// Migraciones versionadas de la base de datos. El número de la última aplicada se guarda en
// PRAGMA user_version (no en `meta`, que `npm run reset` vacía).
//
// Varios procesos (un servidor MCP por sesión de Claude Code, el vigilante, los informes) pueden
// arrancar a la vez: cada paso se aplica dentro de BEGIN IMMEDIATE y vuelve a comprobar la versión,
// así que solo uno lo ejecuta. Antes de migrar una base de datos con datos se hace una copia.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { missionClass, missionDurationMinutes } from "./sim/mission-kind.js";
import { fingerprint, lessonRefs } from "./sim/text.js";

export interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

// El esquema base (tablas y columnas hasta v0.7.0) lo crea db.ts de forma idempotente.
// A partir de aquí, cada cambio de esquema es un paso nuevo al final de la lista.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Cupos de peticiones por servicio (APIs con límite por ventana de tiempo)",
    up: (db) => db.exec("CREATE TABLE IF NOT EXISTS http_budget (host TEXT PRIMARY KEY, window_start INTEGER NOT NULL, used INTEGER NOT NULL)"),
  },
  {
    version: 2,
    description: "Memoria de tres tipos (howtos, creencias, retrospectivas) escrita por el agente revisor",
    up: memoryV2,
  },
  {
    version: 3,
    description: "Cadenas EVM (Base, BNB Chain): datos de tokens, approvals, y reparto y referencia de cada misión",
    up: (db) =>
      db.exec(`
        -- Símbolo y decimales de los tokens EVM (no cambian: se leen una vez por RPC).
        CREATE TABLE token_meta (chain TEXT NOT NULL, address TEXT NOT NULL, symbol TEXT NOT NULL, decimals INTEGER NOT NULL, PRIMARY KEY (chain, address));
        -- Tokens que el monedero EVM de cada misión ya ha aprobado para vender (la primera venta cuesta un approve).
        CREATE TABLE evm_approvals (mission_id INTEGER NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, approved_at TEXT NOT NULL, PRIMARY KEY (mission_id, chain, token));
        -- Reparto inicial del capital por cadena o exchange (JSON de porcentajes) y cartera inicial para la referencia "sin operar".
        ALTER TABLE missions ADD COLUMN allocation TEXT;
        ALTER TABLE missions ADD COLUMN benchmark TEXT;
      `),
  },
  {
    version: 4,
    description: "Transferencias con tiempo de llegada: depósitos y retiradas de Binance y puentes entre cadenas",
    up: (db) =>
      db.exec(`
        -- El dinero sale al momento y llega en arrives_at. status: 'pending' | 'settling' | 'settled'.
        -- kind: 'cex_deposit' | 'cex_withdraw' | 'bridge'. carry: coste de la posición que viaja con el activo.
        CREATE TABLE transfers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id INTEGER NOT NULL,
          session_id INTEGER,
          created_at TEXT NOT NULL,
          arrives_at TEXT NOT NULL,
          settled_at TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          kind TEXT NOT NULL,
          from_venue TEXT NOT NULL,
          to_venue TEXT NOT NULL,
          provider TEXT NOT NULL,
          asset_out TEXT NOT NULL,
          symbol_out TEXT NOT NULL,
          amount_out REAL NOT NULL,
          asset_in TEXT NOT NULL,
          symbol_in TEXT NOT NULL,
          decimals_in INTEGER NOT NULL,
          amount_in REAL NOT NULL,
          value_usd REAL,
          costs TEXT NOT NULL,
          carry TEXT
        );
        CREATE INDEX transfers_pending ON transfers (status, arrives_at);
      `),
  },
  {
    version: 5,
    description: "El reloj de la misión arranca cuando el agente empieza a trabajar",
    // Las misiones que ya existían cuentan como empezadas al crearse.
    up: (db) => db.exec("ALTER TABLE missions ADD COLUMN started_at TEXT; UPDATE missions SET started_at = created_at;"),
  },
  {
    version: 6,
    description: "Misiones con dinero real: modo, aprobación, límites y registro de transacciones firmadas",
    up: (db) =>
      db.exec(`
        ALTER TABLE missions ADD COLUMN mode TEXT NOT NULL DEFAULT 'sim';  -- 'sim' | 'live'
        ALTER TABLE missions ADD COLUMN approval TEXT;                     -- 'manual' | 'auto' (solo live)
        ALTER TABLE missions ADD COLUMN limits TEXT;                       -- JSON { maxTradeUsd, maxLossPct }
        CREATE TABLE live_txs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          mission_id INTEGER NOT NULL,
          chain TEXT NOT NULL,
          kind TEXT NOT NULL,                 -- 'swap' | 'approve'
          status TEXT NOT NULL,               -- 'confirmed' | 'failed' | 'rejected'
          summary TEXT NOT NULL,
          tx_hash TEXT,
          explorer_url TEXT,
          usd REAL,
          error TEXT
        );
        CREATE INDEX live_txs_mission ON live_txs (mission_id, id);
      `),
  },
  {
    version: 7,
    description: "Futuros perpetuos simulados (datos de Hyperliquid)",
    up: (db) =>
      db.exec(`
        CREATE TABLE perp_positions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id INTEGER NOT NULL,
          position_id INTEGER,              -- fila en positions (para la memoria y las estadísticas)
          coin TEXT NOT NULL,
          side TEXT NOT NULL,               -- 'long' | 'short'
          leverage REAL NOT NULL,
          margin_usd REAL NOT NULL,
          size REAL NOT NULL,               -- en unidades de la moneda
          entry_price REAL NOT NULL,
          from_chain TEXT NOT NULL,         -- de qué cadena salió el margen (y adónde vuelve)
          take_profit REAL,
          stop_loss REAL,
          fees_usd REAL NOT NULL DEFAULT 0,
          funding_usd REAL NOT NULL DEFAULT 0,  -- positivo = pagado
          last_funding_at TEXT NOT NULL,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closing' | 'closed' | 'liquidated'
          exit_price REAL,
          returned_usd REAL,
          reasoning TEXT
        );
        CREATE INDEX perp_open ON perp_positions (status, mission_id);
      `),
  },
  {
    version: 8,
    description: "Datos de decisión en las posiciones antiguas (tamaño, reentrada, promediar, tiempo que quedaba), sacados del diario",
    up: decisionBackfill,
  },
  {
    version: 9,
    description: "Hora UTC de entrada en las posiciones antiguas (la actividad del mercado no se puede reconstruir)",
    up: (db) => {
      const rows = db.prepare("SELECT id, opened_at, research FROM positions").all() as Array<{ id: number; opened_at: string; research: string | null }>;
      const update = db.prepare("UPDATE positions SET research = ? WHERE id = ?");
      for (const r of rows) {
        const research = JSON.parse(r.research ?? "{}") as Record<string, unknown>;
        if (research.hourUtc !== undefined) continue;
        research.hourUtc = new Date(r.opened_at).getUTCHours();
        update.run(JSON.stringify(research), r.id);
      }
    },
  },
  {
    version: 10,
    description: "Misiones rápidas: clase de misión, P predicha y de la línea base, plan, gemelo mecánico y motivo de cierre",
    up: (db) => {
      db.exec(`
        ALTER TABLE missions ADD COLUMN class TEXT;           -- '<mercado>-<minutos>m-+<objetivo>%', p. ej. 'graduado-10m-+25%'
        ALTER TABLE missions ADD COLUMN predicted_p REAL;     -- P de llegar al objetivo según el plan vigente al arrancar el reloj (0-1)
        ALTER TABLE missions ADD COLUMN baseline_p REAL;      -- P de la línea base (regla mecánica) para esa clase (0-1)
        ALTER TABLE missions ADD COLUMN plan_id INTEGER;      -- plan vigente al arrancar el reloj
        ALTER TABLE missions ADD COLUMN shadow_hits INTEGER;  -- aciertos del gemelo mecánico
        ALTER TABLE missions ADD COLUMN shadow_return REAL;   -- resultado medio del gemelo (fracción: -0.12 = -12 %)
        -- 'target' | 'deadline' | 'bust' | 'loss_limit' | 'user' | 'replaced' | 'prep_timeout'
        ALTER TABLE missions ADD COLUMN end_reason TEXT;
      `);
      // Las misiones que ya existían reciben su clase con el mismo criterio que las nuevas.
      const rows = db.prepare("SELECT id, created_at, deadline, initial_usd, target_usd, mode FROM missions").all() as Array<{
        id: number;
        created_at: string;
        deadline: string;
        initial_usd: number;
        target_usd: number;
        mode: string | null;
      }>;
      const update = db.prepare("UPDATE missions SET class = ? WHERE id = ?");
      for (const m of rows) {
        update.run(missionClass({ durationMinutes: missionDurationMinutes(m), initialUsd: m.initial_usd, targetUsd: m.target_usd, live: m.mode === "live" }), m.id);
      }
    },
  },
  {
    version: 11,
    description: "Planes del cerebro (planner): reglas fijas para un bloque de misiones de una misma clase",
    up: (db) =>
      db.exec(`
        CREATE TABLE plans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          class TEXT NOT NULL,               -- clase de misión a la que se aplica, p. ej. 'graduado-10m-+25%'
          body TEXT NOT NULL,                -- JSON: evento, filtros, tamaño, toma de beneficio, reentrada, riesgos, lista corta
          predicted_p REAL,                  -- P de llegar al objetivo siguiendo el plan (0-1)
          baseline_p REAL,                   -- P de la línea base (la regla mecánica) para esa clase (0-1)
          active INTEGER NOT NULL DEFAULT 1  -- 1 = vigente; como mucho uno por clase
        );
        CREATE INDEX plans_class ON plans (class, active);
      `),
  },
  {
    version: 12,
    description: "Gemelo mecánico de las misiones rápidas: posiciones en papel en los eventos siguientes, sin tocar la cartera",
    up: (db) =>
      db.exec(`
        CREATE TABLE shadow_runs (
          mission_id INTEGER PRIMARY KEY,
          started_at TEXT NOT NULL,          -- cuando arrancó el reloj de la misión
          detect_until TEXT NOT NULL,        -- hasta cuándo abre gemelos: el plazo de la misión
          horizon_minutes REAL NOT NULL,     -- plazo de cada gemelo desde que entra (la duración de la misión)
          source TEXT NOT NULL,              -- fuente de eventos, la misma que wait_for_signal: 'graduado'
          size_usd REAL NOT NULL,            -- lo que compra cada gemelo (lo que compraría el agente)
          tp_usd REAL NOT NULL,              -- acierta si vender sus tokens da esto o más (la toma de beneficio del plan)
          tp_basis TEXT NOT NULL,
          target_count INTEGER NOT NULL,     -- cuántos gemelos abre como mucho
          status TEXT NOT NULL DEFAULT 'running',  -- running | done | abandoned
          note TEXT,
          ended_at TEXT
        );
        CREATE TABLE shadow_positions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id INTEGER NOT NULL,
          token TEXT NOT NULL,
          symbol TEXT,
          pool TEXT,
          opened_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          usd_in REAL NOT NULL,
          tokens_raw TEXT NOT NULL,          -- tokens comprados en unidades base (lo que se cotiza al venderlos)
          decimals INTEGER NOT NULL,
          entry_value_usd REAL NOT NULL,     -- lo que daba venderlos al entrar (tras la ida y vuelta)
          last_value_usd REAL,
          best_value_usd REAL,
          last_quote_at TEXT,
          quotes INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open',  -- open | hit | expired | abandoned
          closed_at TEXT,
          exit_usd REAL,
          note TEXT,
          UNIQUE (mission_id, token)
        );
        CREATE INDEX shadow_positions_open ON shadow_positions (status, mission_id);
      `),
  },
  {
    version: 13,
    description: "Una misión real nunca es rápida: su clase va en el mercado libre aunque dure 15 min o menos",
    // La migración 10 les daba el mercado de las rápidas (graduado) a las reales cortas, y el flujo rápido solo existe en simulación.
    up: (db) => {
      db.exec("UPDATE missions SET class = 'libre' || substr(class, instr(class, '-')) WHERE mode = 'live' AND class IS NOT NULL AND class NOT LIKE 'libre-%'");
    },
  },
  {
    version: 14,
    description: "Costes realistas por misión (cost_mode) y medidas de la entrada: cuándo se pidió, la señal y la compra",
    up: (db) =>
      db.exec(`
        -- 'sim' (los costes de siempre) | 'real' (fee con prioridad, renta sin devolver y latencia al ejecutar): las dos
        -- series no se mezclan en las estadísticas por clase.
        ALTER TABLE missions ADD COLUMN cost_mode TEXT NOT NULL DEFAULT 'sim';
        -- Cuándo se pidió la misión. No cambia nunca (created_at se reescribe al arrancar el reloj).
        ALTER TABLE missions ADD COLUMN requested_at TEXT;
        -- La última señal de wait_for_signal antes de la entrada, y la primera compra de enter_with_exits.
        ALTER TABLE missions ADD COLUMN signal_at TEXT;
        ALTER TABLE missions ADD COLUMN signal_token TEXT;
        ALTER TABLE missions ADD COLUMN entry_at TEXT;
        ALTER TABLE missions ADD COLUMN entry_latency_s REAL;
        -- Las que aún no han arrancado el reloj conservan su hora de creación; en las demás ya no se sabe.
        UPDATE missions SET requested_at = created_at WHERE started_at IS NULL;
        -- Red y renta de cada gemelo con costes realistas, en USD (con los de siempre, 0: como hasta ahora).
        ALTER TABLE shadow_positions ADD COLUMN costs_usd REAL NOT NULL DEFAULT 0;
      `),
  },
];

/**
 * Las posiciones guardan desde v0.30 cómo decidió el agente (qué parte del capital puso, si volvía a un token
 * ya operado, si promedió en pérdidas y cuánto quedaba). Para las anteriores se reconstruye: capital = inicial
 * de la misión + lo ganado o perdido en las posiciones ya cerradas; tamaño = todo lo invertido en la posición
 * (con lo añadido); las compras más baratas que la media, del diario. Así la evidencia no empieza de cero.
 */
function decisionBackfill(db: DatabaseSync) {
  const positions = db
    .prepare("SELECT id, mission_id, venue, asset, opened_at, closed_at, status, cost_open_usd, realized_cost_usd, realized_proceeds_usd, research FROM positions ORDER BY opened_at, id")
    .all() as Array<{ id: number; mission_id: number; venue: string; asset: string; opened_at: string; closed_at: string | null; status: string; cost_open_usd: number; realized_cost_usd: number; realized_proceeds_usd: number; research: string | null }>;
  const missions = new Map((db.prepare("SELECT id, initial_usd, deadline FROM missions").all() as Array<{ id: number; initial_usd: number; deadline: string }>).map((m) => [m.id, m]));
  const buys = db.prepare("SELECT ts, details FROM journal WHERE mission_id = ? AND kind = 'swap' AND ts >= ? AND ts <= ? ORDER BY id");
  const update = db.prepare("UPDATE positions SET research = ? WHERE id = ?");
  const num = (x: unknown) => Number(String(x ?? "").split(" ")[0]);
  const STABLE = /^(USDC|USDT|USDbC|FDUSD)$/;
  for (const p of positions) {
    const research = JSON.parse(p.research ?? "{}") as Record<string, unknown>;
    if (research.portfolioPct !== undefined) continue;
    const m = missions.get(p.mission_id);
    if (!m) continue;
    const before = positions.filter((q) => q.mission_id === p.mission_id && q.status === "closed" && q.closed_at !== null && q.closed_at <= p.opened_at);
    const capital = m.initial_usd + before.reduce((sum, q) => sum + q.realized_proceeds_usd - q.realized_cost_usd, 0);
    const invested = p.realized_cost_usd + p.cost_open_usd;
    const previous = positions.filter((q) => q.venue === p.venue && q.asset === p.asset && q.status === "closed" && q.closed_at !== null && q.closed_at <= p.opened_at);
    const last = previous.at(-1);
    // Compras de este token mientras la posición estaba abierta, pagadas con un estable (precio en USD).
    const prices: number[] = [];
    for (const j of buys.all(p.mission_id, p.opened_at.slice(0, 19), p.closed_at ?? "9999") as Array<{ details: string | null }>) {
      const d = JSON.parse(j.details ?? "{}") as { outputMint?: string; sold?: string; received?: string };
      if (d.outputMint !== p.asset || !STABLE.test(String(d.sold ?? "").split(" ")[1] ?? "")) continue;
      const usd = num(d.sold), qty = num(d.received);
      if (usd > 0 && qty > 0) prices.push(usd / qty);
    }
    let addedWhileDown = false;
    for (let i = 1; i < prices.length; i++) {
      const avg = prices.slice(0, i).reduce((a, b) => a + b, 0) / i;
      if (prices[i]! < avg * 0.97) addedWhileDown = true;
    }
    Object.assign(research, {
      ...(capital > 0 && invested > 0 ? { portfolioPct: Math.round((invested / capital) * 100) } : {}),
      previousTradesInToken: previous.length,
      ...(last && last.realized_cost_usd > 0 ? { lastPnlInTokenPct: Math.round((last.realized_proceeds_usd / last.realized_cost_usd - 1) * 100) } : {}),
      minutesLeft: Math.max(0, Math.round((new Date(m.deadline).getTime() - new Date(p.opened_at).getTime()) / 60_000)),
      adds: Math.max(0, prices.length - 1),
      addedWhileDown,
      backfilled: true,
    });
    update.run(JSON.stringify(research), p.id);
  }
}

/**
 * Memoria de tres tipos. La escribe el agente revisor, no el que opera:
 * - howtos: conocimiento procedimental (cómo se hace algo, qué falla y cómo evitarlo).
 * - beliefs: creencias sobre el mercado; su evidencia la calcula el simulador con las posiciones reales.
 * - mission_reviews: retrospectiva de cada misión (lo episódico, junto con el diario).
 * Las lecciones antiguas pasan a ser creencias con el mismo id, para que "Lección 5" siga apuntando a lo mismo.
 */
function memoryV2(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE howtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      scope TEXT NOT NULL,            -- cadena o exchange al que se aplica, o 'any'
      topic TEXT NOT NULL,
      title TEXT NOT NULL,
      steps TEXT NOT NULL,
      source_mission_id INTEGER,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'obsolete'
      superseded_by INTEGER,
      from_belief_id INTEGER
    );
    CREATE TABLE beliefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_mission_id INTEGER,
      statement TEXT NOT NULL,
      applies_to TEXT NOT NULL,
      expectation TEXT,               -- con condición: 'positive' (tiende a ganar) | 'negative' (tiende a perder)
      condition TEXT,                 -- JSON: {"all":[{"f":"ageMinutes","op":"<","v":30}]}
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'retired' | 'converted'
      status_reason TEXT,
      origin TEXT NOT NULL DEFAULT 'reviewer', -- 'reviewer' | 'migrated'
      legacy_evidence TEXT
    );
    CREATE TABLE mission_reviews (
      mission_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'reviewer', -- 'reviewer' | 'legacy'
      what_was_tried TEXT NOT NULL,
      what_happened TEXT NOT NULL,
      surprises TEXT,
      next_time TEXT NOT NULL
    );
    -- Revisiones a mitad de misión: marcan hasta dónde ha revisado el revisor.
    CREATE TABLE review_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      mission_id INTEGER NOT NULL,
      summary TEXT NOT NULL
    );
    -- Lo que el revisor quiere que el agente tenga presente en una misión. seen_at: cuándo lo recibió el agente.
    CREATE TABLE briefings (
      mission_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      text TEXT NOT NULL,
      seen_at TEXT
    );
    -- Observaciones del agente que opera para el revisor, que decide si pasan a la memoria.
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      mission_id INTEGER,
      session_id INTEGER,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'used' | 'dismissed'
      resolved_at TEXT,
      resolution TEXT
    );
    -- Errores de las herramientas, capturados por el simulador.
    CREATE TABLE tool_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      mission_id INTEGER,
      session_id INTEGER,
      tool TEXT NOT NULL,
      venue TEXT,
      error_class TEXT NOT NULL,
      message TEXT NOT NULL,
      input TEXT,
      howto_id INTEGER
    );
    CREATE INDEX tool_errors_class ON tool_errors (error_class, ts);
    -- Qué APIs responden: lo mide http_get en cada llamada del agente.
    CREATE TABLE api_observations (
      host TEXT NOT NULL,
      path TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 0,
      fail INTEGER NOT NULL DEFAULT 0,
      last_status INTEGER,
      last_ok_at TEXT,
      last_fail_at TEXT,
      PRIMARY KEY (host, path)
    );
    -- Capacidades que el agente echa en falta (una cuenta, una herramienta, otro mercado…), para que el
    -- usuario decida si se las da. Las peticiones parecidas se agrupan y se cuentan.
    CREATE TABLE capability_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL,             -- 'trader' | 'reviewer'
      category TEXT NOT NULL,
      capability TEXT NOT NULL,
      why TEXT NOT NULL,
      plan TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      times_requested INTEGER NOT NULL DEFAULT 1,
      missions TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'accepted' | 'rejected' | 'done'
      response TEXT
    );
    ALTER TABLE positions ADD COLUMN beliefs_applied TEXT;
  `);

  // Lecciones → creencias con el mismo id.
  const lessons = db.prepare("SELECT id, created_at, mission_id, text, applies_to, evidence, confidence FROM lessons ORDER BY id").all() as Array<{
    id: number;
    created_at: string;
    mission_id: number | null;
    text: string;
    applies_to: string | null;
    evidence: string | null;
    confidence: string | null;
  }>;
  const insertBelief = db.prepare(
    `INSERT INTO beliefs (id, created_at, updated_at, source_mission_id, statement, applies_to, fingerprint, origin, legacy_evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'migrated', ?)`,
  );
  for (const l of lessons) {
    const evidence = [l.evidence, l.confidence ? `(confianza que declaró el agente: ${l.confidence})` : null].filter(Boolean).join(" ");
    insertBelief.run(l.id, l.created_at, l.created_at, l.mission_id, l.text, l.applies_to ?? "(sin especificar)", fingerprint(l.text), evidence || null);
  }

  // Misiones ya revisadas con el sistema anterior: retrospectiva de origen 'legacy'.
  const reviewed = db.prepare("SELECT id, reviewed_at FROM missions WHERE reviewed_at IS NOT NULL").all() as Array<{ id: number; reviewed_at: string }>;
  const insertReview = db.prepare(
    "INSERT INTO mission_reviews (mission_id, created_at, origin, what_was_tried, what_happened, next_time) VALUES (?, ?, 'legacy', ?, ?, ?)",
  );
  for (const m of reviewed) {
    const ids = lessons.filter((l) => l.mission_id === m.id).map((l) => `#${l.id}`);
    const note = ids.length ? `Revisada antes de existir el revisor: lo aprendido está en las creencias ${ids.join(", ")}.` : "Revisada antes de existir el revisor, sin lecciones.";
    insertReview.run(m.id, m.reviewed_at, note, note, ids.length ? `Ver las creencias ${ids.join(", ")}.` : "-");
  }

  // Referencias a lecciones en las tesis ("Lección 5", "Lecciones 5 y 6") → creencias aplicadas.
  const known = new Set(lessons.map((l) => l.id));
  const positions = db.prepare("SELECT id, lessons_applied FROM positions WHERE lessons_applied IS NOT NULL").all() as Array<{ id: number; lessons_applied: string }>;
  const setApplied = db.prepare("UPDATE positions SET beliefs_applied = ? WHERE id = ?");
  for (const p of positions) {
    const ids = lessonRefs(p.lessons_applied).filter((id) => known.has(id));
    if (ids.length) setApplied.run(JSON.stringify(ids), p.id);
  }
}

const MAX_BACKUPS = 10;

export const schemaVersion = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

export const latestVersion = () => MIGRATIONS.reduce((v, m) => Math.max(v, m.version), 0);

function hasUserData(db: DatabaseSync) {
  return Boolean(db.prepare("SELECT 1 FROM missions LIMIT 1").get());
}

/** Copia de la base de datos antes de migrarla, en <dataDir>/backups. Conserva las últimas copias. */
function backup(db: DatabaseSync, dataDir: string, from: number) {
  const dir = path.join(dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `sim-v${from}-${stamp}-${process.pid}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = readdirSync(dir).filter((f) => f.startsWith("sim-v") && f.endsWith(".db")).sort();
  for (const f of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) rmSync(path.join(dir, f), { force: true });
  return file;
}

/** Aplica las migraciones pendientes. Devuelve las versiones aplicadas por este proceso. */
export function runMigrations(db: DatabaseSync, dataDir: string, migrations: Migration[] = MIGRATIONS): number[] {
  const pending = migrations.filter((m) => m.version > schemaVersion(db)).sort((a, b) => a.version - b.version);
  if (!pending.length) return [];
  if (hasUserData(db)) backup(db, dataDir, schemaVersion(db));

  const applied: number[] = [];
  for (const m of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Otro proceso puede haberla aplicado mientras esperábamos el bloqueo.
      if (schemaVersion(db) >= m.version) {
        db.exec("COMMIT");
        continue;
      }
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
      applied.push(m.version);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Falló la migración ${m.version} (${m.description}): ${(err as Error).message}`);
    }
  }
  return applied;
}
