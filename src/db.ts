import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { runMigrations } from "./migrations.js";

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, "sim.db"));

// Varios procesos (servidor MCP, vigilante de órdenes, informes) comparten la base de datos.
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Cartera de cada misión. venue: 'solana' (asset = mint) | 'binance' (asset = ticker, p.ej. 'USDT')
  CREATE TABLE IF NOT EXISTS holdings (
    mission_id INTEGER NOT NULL,
    venue TEXT NOT NULL,
    asset TEXT NOT NULL,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    amount REAL NOT NULL,
    PRIMARY KEY (mission_id, venue, asset)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    final_text TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0
  );
  -- kind: 'swap' | 'cex_order' | 'transfer' | 'hypothetical' | 'rejected'
  CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_id INTEGER,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    reasoning TEXT,
    details TEXT
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_id INTEGER,
    text TEXT NOT NULL
  );
  -- Órdenes condicionales: cuando el precio cruza el disparador se ejecuta 'action' a mercado.
  -- status: 'open' | 'executing' | 'filled' | 'failed' | 'cancelled' | 'expired'
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    session_id INTEGER,
    venue TEXT NOT NULL,
    trigger_asset TEXT NOT NULL,
    trigger_label TEXT NOT NULL,
    condition TEXT NOT NULL,
    trigger_price REAL NOT NULL,
    action TEXT NOT NULL,
    reasoning TEXT,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    closed_at TEXT,
    result TEXT
  );
  -- status: 'active' | 'succeeded' (objetivo alcanzado) | 'expired' (se acabó el tiempo) | 'bust' (sin fondos para operar) | 'cancelled'
  CREATE TABLE IF NOT EXISTS missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    initial_usd REAL NOT NULL,
    target_usd REAL NOT NULL,
    deadline TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    ended_at TEXT,
    final_usd REAL
  );
  -- Actividad del agente para el panel: registro de trabajo ('thought', vía log_progress) y, en el runner por API,
  -- también sus textos, razonamiento resumido y llamadas a herramientas.
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_id INTEGER,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT
  );
  -- Memoria a largo plazo del agente: lecciones que sobreviven entre misiones.
  CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    mission_id INTEGER,
    text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    ts TEXT NOT NULL,
    total_usd REAL NOT NULL,
    benchmark_usd REAL NOT NULL,
    details TEXT
  );
`);

db.exec(`
  -- Posiciones: cada token comprado en una misión, con los datos del token al entrar,
  -- la investigación hecha antes y el resultado real al salir. Lo calcula el simulador.
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER,
    venue TEXT NOT NULL,
    asset TEXT NOT NULL,
    symbol TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    qty_open REAL NOT NULL,
    cost_open_usd REAL NOT NULL,
    realized_cost_usd REAL NOT NULL DEFAULT 0,
    realized_proceeds_usd REAL NOT NULL DEFAULT 0,
    entry_features TEXT,
    research TEXT,
    thesis TEXT,
    lessons_applied TEXT,
    exit_reason TEXT
  );
  -- Llamadas a herramientas de investigación, para saber cuánto investigó antes de cada operación.
  CREATE TABLE IF NOT EXISTS research_log (
    ts TEXT NOT NULL,
    mission_id INTEGER,
    tool TEXT NOT NULL,
    target TEXT
  );
`);

// Migraciones de columnas añadidas después de crear la tabla.
function addColumns(table: string, columns: Record<string, string>) {
  const existing = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}
addColumns("missions", {
  instructions: "TEXT",
  reviewed_at: "TEXT",
  benchmark_sol_price: "REAL",
});
addColumns("lessons", { applies_to: "TEXT", evidence: "TEXT", confidence: "TEXT" });

// Todo lo que pertenece a una misión lleva su mission_id: cada misión tiene sus propios datos.
for (const table of ["journal", "activity", "orders", "notes", "snapshots", "sessions"]) addColumns(table, { mission_id: "INTEGER" });

// Migración de bases de datos anteriores (una sola cartera global, sin mission_id).
{
  const holdingCols = (db.prepare("PRAGMA table_info(holdings)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!holdingCols.includes("mission_id")) {
    db.exec(`
      BEGIN;
      CREATE TABLE holdings_new (
        mission_id INTEGER NOT NULL, venue TEXT NOT NULL, asset TEXT NOT NULL, symbol TEXT NOT NULL,
        decimals INTEGER NOT NULL, amount REAL NOT NULL, PRIMARY KEY (mission_id, venue, asset)
      );
      INSERT INTO holdings_new SELECT COALESCE((SELECT MAX(id) FROM missions), 0), venue, asset, symbol, decimals, amount FROM holdings;
      DROP TABLE holdings;
      ALTER TABLE holdings_new RENAME TO holdings;
      COMMIT;
    `);
  }
  // Una sola vez: asigna a cada fila antigua la misión en curso en ese momento (por fecha).
  // No se repite después, porque con misiones en paralelo la fecha no identifica la misión.
  const done = db.prepare("SELECT value FROM meta WHERE key = 'migration_mission_ids'").get();
  if (!done) {
    const byTime = (table: string, tsCol: string) =>
      db.exec(`UPDATE ${table} SET mission_id = (
        SELECT m.id FROM missions m WHERE m.created_at <= ${table}.${tsCol} ORDER BY m.created_at DESC LIMIT 1
      ) WHERE mission_id IS NULL`);
    byTime("journal", "ts");
    byTime("activity", "ts");
    byTime("orders", "created_at");
    byTime("notes", "ts");
    byTime("snapshots", "ts");
    byTime("sessions", "started_at");
    const legacyBench = (db.prepare("SELECT value FROM meta WHERE key = 'benchmark_sol_price'").get() as { value: string } | undefined)?.value;
    if (legacyBench) {
      db.prepare("UPDATE missions SET benchmark_sol_price = ? WHERE benchmark_sol_price IS NULL AND id = (SELECT MAX(id) FROM missions)").run(Number(legacyBench));
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('migration_mission_ids', '1')").run();
  }
}

// Cambios de esquema posteriores: migraciones versionadas (ver migrations.ts).
runMigrations(db, config.dataDir);

export const now = () => new Date().toISOString();

export function getMeta(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(key: string, value: string) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ─── Versión del código que usa los datos ──────────────────────────────────
// Una sesión de Claude Code abierta hace horas puede seguir con un servidor MCP de una versión
// anterior del plugin. Si arranca uno más nuevo, el antiguo deja de escribir: sus datos o reglas
// pueden haber cambiado (p. ej., antes de que cada misión tuviera su propia cartera).
const CODE_VERSION = process.env.CRYPTOAGENT_VERSION;
const semver = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
const newer = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
if (CODE_VERSION) {
  const stored = getMeta("code_version");
  if (!stored || newer(CODE_VERSION, stored)) setMeta("code_version", CODE_VERSION);
}

/** Si otro proceso con una versión más nueva del plugin usa los datos, devuelve el aviso; si no, null. */
export function supersededBy(): string | null {
  if (!CODE_VERSION) return null;
  const stored = getMeta("code_version");
  if (!stored || !newer(stored, CODE_VERSION)) return null;
  return (
    `Esta sesión usa dementeking ${CODE_VERSION}, pero ya hay en marcha la versión ${stored}. ` +
    "Para no estropear los datos, esta versión ya no hace nada: abre una sesión nueva de Claude Code."
  );
}

// ─── Un solo proceso para el trabajo de fondo ──────────────────────────────
// Claude Code, OpenCode y el watcher pueden tener cada uno su servidor abierto sobre la misma base de datos.
// Si todos revisan órdenes y misiones, las cotizaciones se multiplican y Jupiter responde 429 (en la M2 de la
// v0.35.2 el cierre de la misión esperó 14 minutos en la cola). Quien tiene el turno lo renueva en cada vuelta;
// si deja de hacerlo (se cerró), a los 45 s lo toma otro.
const TICK_LEASE_MS = 45_000;
const tickOwner = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** true si este proceso tiene (o acaba de tomar) el turno del trabajo de fondo. */
export function holdsTickLease(): boolean {
  const nowMs = Date.now();
  const r = db
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('tick_lease', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE meta.value LIKE ? OR CAST(substr(meta.value, instr(meta.value, '@') + 1) AS INTEGER) < ?`,
    )
    .run(`${tickOwner}@${nowMs + TICK_LEASE_MS}`, `${tickOwner}@%`, nowMs);
  return r.changes > 0;
}

export function logActivity(entry: { missionId: number | null; sessionId: number | null; kind: string; title: string; body?: string }) {
  db.prepare("INSERT INTO activity (ts, mission_id, session_id, kind, title, body) VALUES (?, ?, ?, ?, ?, ?)").run(
    now(),
    entry.missionId,
    entry.sessionId,
    entry.kind,
    entry.title,
    entry.body ?? null,
  );
}

export function logJournal(entry: {
  missionId: number | null;
  sessionId: number | null;
  kind: string;
  summary: string;
  reasoning?: string;
  details?: unknown;
}) {
  db.prepare("INSERT INTO journal (ts, mission_id, session_id, kind, summary, reasoning, details) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    now(),
    entry.missionId,
    entry.sessionId,
    entry.kind,
    entry.summary,
    entry.reasoning ?? null,
    entry.details === undefined ? null : JSON.stringify(entry.details),
  );
}
