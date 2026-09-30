// Gemelo mecánico de las misiones rápidas: la línea base medida en la misma franja que la misión. Cuando arranca el
// reloj de una misión rápida, el simulador abre en papel (sin tocar la cartera) posiciones en los SHADOW_COUNT eventos
// siguientes que detecta la misma fuente que wait_for_signal, pasando solo los filtros mecánicos (pool de 2 min o
// menos de pump.fun, liquidez de 1.000 $ o más, y cotización de compra y venta en Jupiter con una ida y vuelta del 10 %
// o menos: los mismos por defecto que wait_for_signal), con el mismo tamaño y la misma toma de beneficio que el plan.
// Cada gemelo tiene el plazo entero de la misión desde que entra, como lo tiene el agente desde su entrada (si los
// últimos tuvieran menos tiempo, el gemelo saldría peor y el agente parecería mejor de lo que es).
//
// Por qué: la P base llegó a doblarse entre dos ventanas seguidas de 20 minutos. Comparar al agente con una cifra fija de
// tabla puede dar un falso "el agente aporta" solo porque ese día el mercado estaba caliente.
//
// Reglas:
// - Durante la misión no escribe nada que vea el agente (ni diario ni estado): `wait` se despierta con cualquier
//   novedad del diario y el gemelo no debe influir en él. El resultado se guarda en la misión (shadow_hits,
//   shadow_return) cuando la misión ha terminado y todos sus gemelos también; si alguno sigue abierto al cerrarla,
//   en cuanto termine.
// - Va en su propio bucle (watch.ts), no en la vuelta de órdenes y misión: si GeckoTerminal responde 429 y sus
//   peticiones se alargan, la toma de beneficio del agente se sigue mirando cada 5 s.
// - Cada gemelo abierto se cotiza al mismo ritmo que la orden del agente en una misión rápida (cada 5 s): en este
//   mercado la P depende de cazar picos cortos (35 % por cierre de minuto frente a 51 % tocando mecha), y mirarlo la
//   mitad de veces sesgaría la comparación a favor del agente.
// - El agente tiene prioridad de verdad en Jupiter (una petición cada 1,1 s entre todos los procesos): el gemelo pide
//   por el carril de baja prioridad (market/http.ts), que solo usa turnos libres y nunca hace cola delante del agente.
//   Si no hay turno, lo deja para la vuelta siguiente.
// - La toma de beneficio se llena justo a su precio, como la orden límite del agente (orders.ts); al acabar su plazo,
//   el gemelo vende a la cotización de ese momento, como el cierre de la misión. Con precios de después de su plazo no
//   se decide nada: si la vigilancia llega tarde (el proceso estaba parado), se cierra con la última cotización de su
//   plazo o, si nadie lo miró al final, no cuenta.
import { config } from "../config.js";
import { db, logJournal } from "../db.js";
import { HostBusyError } from "../market/http.js";
import { fromBaseUnits, getQuote, USDC_MINT } from "../market/jupiter.js";
import { isFastMission, parseMissionClass, TP_TARGET_MARGIN } from "./mission-kind.js";
import { planForMission, type SignalSource } from "./plans.js";
import { balance } from "./portfolio.js";
import { SignalScanner, type ScannerHit, type SignalTiming } from "./signals.js";
import { getChain } from "./venues/index.js";

/** Gemelos por misión: los eventos siguientes a la entrada del agente. */
export const SHADOW_COUNT = 3;

/** Mercados con una fuente de eventos mecánica (la de wait_for_signal). En los demás no hay gemelo. */
const TWIN_SOURCES: Record<string, SignalSource> = { graduado: "graduado" };

export interface ShadowTiming {
  /** Cada cuánto se vuelve a cotizar cada gemelo abierto (vender sus tokens al momento). */
  quoteEveryMs: number;
  /** Peticiones a Jupiter que puede gastar el gemelo en cada vuelta: 1 por cotización y 3 por candidato nuevo. */
  jupiterPerTick: number;
  /**
   * Margen tras el plazo de un gemelo (una vuelta y algo): dentro, se cotiza y aún puede llenar su toma de beneficio,
   * como la orden del agente en la vuelta del cierre; pasado, ya no se decide nada con precios de después.
   */
  lateMs: number;
  /** Si la vigilancia llega tarde: el gemelo cuenta solo si se le miró en este tiempo antes de su plazo. */
  unobservedMs: number;
  /** Del detector de eventos (signals.ts). */
  signal?: Partial<SignalTiming>;
}

// Al ritmo de las órdenes del agente en una misión rápida: 3 gemelos cada 5 s son 0,6 peticiones/s, que caben con el
// agente (~0,27/s medido) en las de Jupiter (0,91/s); lo que no quepa, lo frena el carril de baja prioridad.
export const SHADOW_TIMING: ShadowTiming = {
  quoteEveryMs: config.fastWatchIntervalSeconds * 1000,
  jupiterPerTick: 6,
  lateMs: 15_000,
  unobservedMs: 30_000,
};

/** Margen para que un gemelo no se salte su cotización por unos milisegundos de retraso del temporizador. */
const DUE_SLACK_MS = 250;

interface RunRow {
  mission_id: number;
  started_at: string;
  detect_until: string;
  horizon_minutes: number;
  source: SignalSource;
  size_usd: number;
  tp_usd: number;
  tp_basis: string;
  target_count: number;
  status: "running" | "done" | "abandoned";
  note: string | null;
  ended_at: string | null;
}

interface TwinRow {
  id: number;
  mission_id: number;
  token: string;
  symbol: string | null;
  pool: string | null;
  opened_at: string;
  expires_at: string;
  usd_in: number;
  tokens_raw: string;
  decimals: number;
  entry_value_usd: number;
  last_value_usd: number | null;
  best_value_usd: number | null;
  last_quote_at: string | null;
  quotes: number;
  status: "open" | "hit" | "expired" | "abandoned";
  closed_at: string | null;
  exit_usd: number | null;
  note: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Al arrancar el reloj de una misión rápida simulada cuyo mercado tiene fuente mecánica: prepara su gemelo con el tamaño
 * y la toma de beneficio que usaría el agente (los del plan; si no, todo el efectivo de Solana y el precio que deja el
 * objetivo cumplido neto de costes). Se llama antes de que el agente compre (enter_with_exits arranca el reloj primero).
 * Devuelve por qué no hay gemelo, si no lo hay.
 */
export function startShadowRun(missionId: number): { started: true } | { started: false; reason: string } {
  const m = db
    .prepare("SELECT id, mode, class, created_at, deadline, started_at, initial_usd, target_usd FROM missions WHERE id = ?")
    .get(missionId) as
    | { id: number; mode: string | null; class: string | null; created_at: string; deadline: string; started_at: string | null; initial_usd: number; target_usd: number }
    | undefined;
  if (!m?.started_at) return { started: false, reason: "el reloj no ha arrancado" };
  if (m.mode === "live") return { started: false, reason: "misión real" };
  if (!isFastMission(m)) return { started: false, reason: "no es una misión rápida" };
  const cls = parseMissionClass(m.class);
  const source = cls ? TWIN_SOURCES[cls.market] : undefined;
  if (!source) return { started: false, reason: `el mercado ${cls?.market ?? "?"} no tiene fuente de eventos mecánica` };
  const plan = planForMission(missionId);
  const cash = Math.max(0, ...getChain("solana").stables.map((s) => balance(missionId, "solana", s.address)));
  const size = Math.min(plan?.body.usd_amount ?? cash, cash);
  if (!(size >= 1)) return { started: false, reason: "sin efectivo en Solana" };
  // El resto de la cartera (el gas y lo que haya en otras cadenas) sigue ahí: antes del reloj no se puede operar, así
  // que al arrancarlo la cartera vale lo del principio.
  const tpRatio = plan?.body.tp_ratio;
  const tpUsd = tpRatio ? size * tpRatio : m.target_usd * (1 + TP_TARGET_MARGIN) - (m.initial_usd - size);
  const durationMs = new Date(m.deadline).getTime() - new Date(m.started_at).getTime();
  const changed = db
    .prepare(
      `INSERT OR IGNORE INTO shadow_runs (mission_id, started_at, detect_until, horizon_minutes, source, size_usd, tp_usd, tp_basis, target_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      missionId,
      m.started_at,
      m.deadline,
      durationMs / 60_000,
      source,
      size,
      tpUsd,
      tpRatio ? `×${tpRatio} de lo que paga (plan #${plan!.id})` : `el objetivo de la misión neto de costes${plan ? ` (plan #${plan.id}, sin tp_ratio)` : ""}`,
      SHADOW_COUNT,
    ).changes;
  return changed ? { started: true } : { started: false, reason: "ya tenía gemelo" };
}

/** Detectores de eventos de los gemelos en marcha, por misión (en memoria del proceso que vigila). */
const scanners = new Map<number, SignalScanner>();

/** Tokens que el agente ha comprado u ofrecido wait_for_signal en esta misión: los siguientes eventos son otros. */
function agentTokens(missionId: number): string[] {
  const rows = db
    .prepare(
      `SELECT asset AS t FROM positions WHERE mission_id = ? AND venue = 'solana'
       UNION SELECT target AS t FROM research_log WHERE mission_id = ? AND tool = 'wait_for_signal' AND target IS NOT NULL`,
    )
    .all(missionId, missionId) as Array<{ t: string }>;
  return rows.map((r) => r.t);
}

const twinsOf = (missionId: number) => db.prepare("SELECT * FROM shadow_positions WHERE mission_id = ? ORDER BY id").all(missionId) as unknown as TwinRow[];

function openTwin(run: RunRow, hit: ScannerHit, nowMs: number): TwinRow | undefined {
  let id: number | undefined;
  // Contar e insertar juntos: si dos procesos vigilan a la vez, no pasan de target_count.
  db.exec("BEGIN IMMEDIATE");
  try {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM shadow_positions WHERE mission_id = ?").get(run.mission_id) as { n: number }).n;
    if (n < run.target_count) {
      const back = hit.candidate.quote!.backUsd;
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO shadow_positions
             (mission_id, token, symbol, pool, opened_at, expires_at, usd_in, tokens_raw, decimals, entry_value_usd, last_value_usd, best_value_usd, last_quote_at, quotes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          run.mission_id,
          hit.candidate.token,
          hit.candidate.symbol ?? null,
          hit.candidate.pool ?? null,
          iso(nowMs),
          iso(nowMs + run.horizon_minutes * 60_000),
          run.size_usd,
          hit.tokensOutRaw,
          hit.decimals,
          back,
          back,
          back,
          iso(nowMs),
        );
      if (r.changes) id = Number(r.lastInsertRowid);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return id === undefined ? undefined : (db.prepare("SELECT * FROM shadow_positions WHERE id = ?").get(id) as unknown as TwinRow);
}

/** Un gemelo que no se pudo seguir hasta el final de su plazo: no cuenta (ni acierto ni fallo). */
function dropTwin(t: TwinRow, note: string, nowMs: number): boolean {
  return db.prepare("UPDATE shadow_positions SET status = 'abandoned', closed_at = ?, note = ? WHERE id = ? AND status = 'open'").run(iso(nowMs), note, t.id).changes > 0;
}

function closeTwin(t: TwinRow, status: "hit" | "expired", exitUsd: number, note: string | null, nowMs: number): boolean {
  return (
    db
      .prepare("UPDATE shadow_positions SET status = ?, exit_usd = ?, closed_at = ?, note = COALESCE(?, note) WHERE id = ? AND status = 'open'")
      .run(status, exitUsd, iso(nowMs), note, t.id).changes > 0
  );
}

/** Cotiza vender los tokens del gemelo y lo cierra si llega a la toma de beneficio o si se le ha acabado el plazo. */
async function quoteTwin(t: TwinRow, run: RunRow, nowMs: number, timing: ShadowTiming): Promise<string | null> {
  const expiresMs = Date.parse(t.expires_at);
  const expired = nowMs >= expiresMs;
  const name = t.symbol ?? t.token;
  // Tarde: nadie lo miró al acabar su plazo (el proceso estaba parado o dormido). Un precio de ahora no dice nada de
  // entonces: ni acierto con una subida posterior, ni el cierre a un precio tardío.
  if (expired && nowMs - expiresMs > timing.lateMs) {
    const lastSeenMs = t.last_quote_at ? Date.parse(t.last_quote_at) : Number.NEGATIVE_INFINITY;
    if (expiresMs - lastSeenMs <= timing.unobservedMs) {
      // Se le miró hasta el final (con cotización o intentándolo sin ruta): vale la última cotización de su plazo.
      const exit = t.last_value_usd ?? 0;
      return closeTwin(t, "expired", exit, "cerrado con la última cotización de su plazo (la vigilancia llegó tarde al cierre)", nowMs)
        ? `Gemelo #${t.id} (${name}) cerrado por tiempo con su última cotización: ${exit.toFixed(2)} $`
        : null;
    }
    return dropTwin(t, "sin observar al acabar su plazo (la vigilancia no corría): no cuenta", nowMs)
      ? `Gemelo #${t.id} (${name}) sin observar al final de su plazo: no cuenta`
      : null;
  }
  let value: number;
  try {
    const q = await getQuote(t.token, USDC_MINT, BigInt(t.tokens_raw), 300, 1_000, { lowPriority: true });
    value = fromBaseUnits(q.outAmount, 6);
  } catch (err) {
    // Jupiter ocupado con el agente: se vuelve a intentar en la vuelta siguiente, sin anotar nada.
    if (err instanceof HostBusyError) return null;
    // Sin ruta de venta: se vuelve a intentar; si se le sigue mirando así hasta pasado su plazo, se cierra con el
    // último valor conocido (arriba).
    db.prepare("UPDATE shadow_positions SET last_quote_at = ?, note = ? WHERE id = ? AND status = 'open'").run(iso(nowMs), `sin cotización: ${(err as Error).message.slice(0, 120)}`, t.id);
    return null;
  }
  db.prepare(
    "UPDATE shadow_positions SET quotes = quotes + 1, last_value_usd = ?, best_value_usd = MAX(COALESCE(best_value_usd, ?), ?), last_quote_at = ? WHERE id = ? AND status = 'open'",
  ).run(value, value, value, iso(nowMs), t.id);
  if (value >= run.tp_usd) {
    // Como la orden límite del agente: se llena justo a su precio (el exceso del pico no es suyo).
    return closeTwin(t, "hit", run.tp_usd, null, nowMs) ? `Gemelo #${t.id} (${name}) llega a la toma de beneficio: ${run.tp_usd.toFixed(2)} $` : null;
  }
  if (expired) return closeTwin(t, "expired", value, null, nowMs) ? `Gemelo #${t.id} (${name}) cerrado por tiempo: ${value.toFixed(2)} $` : null;
  return null;
}

/**
 * Da el gemelo por terminado y guarda su resultado en la misión: aciertos y resultado medio sobre el capital de la
 * misión (comparable con el resultado de la misión). Solo con la misión cerrada, la ventana de eventos pasada (o los
 * gemelos completos) y ningún gemelo abierto.
 */
function finalize(run: RunRow, nowMs: number): string | null {
  const mission = db.prepare("SELECT status, initial_usd FROM missions WHERE id = ?").get(run.mission_id) as { status: string; initial_usd: number } | undefined;
  if (!mission || mission.status === "active" || mission.status === "closing") return null;
  const twins = twinsOf(run.mission_id);
  if (twins.some((t) => t.status === "open")) return null;
  if (twins.length < run.target_count && nowMs < Date.parse(run.detect_until)) return null;
  const done = twins.filter((t) => t.status === "hit" || t.status === "expired");
  const hits = done.filter((t) => t.status === "hit").length;
  const ret = done.length ? done.reduce((s, t) => s + (t.exit_usd! - t.usd_in), 0) / done.length / mission.initial_usd : null;
  const note = done.length
    ? null
    : twins.length
      ? "ningún gemelo se pudo seguir hasta el final de su plazo (la vigilancia no corría): sin resultado"
      : "no hubo ningún evento que pasara los filtros mecánicos en el plazo de la misión";
  const claimed = db.prepare("UPDATE shadow_runs SET status = 'done', ended_at = ?, note = ? WHERE mission_id = ? AND status = 'running'").run(iso(nowMs), note, run.mission_id).changes;
  if (!claimed) return null;
  db.prepare("UPDATE missions SET shadow_hits = ?, shadow_return = ? WHERE id = ?").run(done.length ? hits : null, ret, run.mission_id);
  const summary = done.length
    ? `Gemelo mecánico de la misión #${run.mission_id}: ${hits} de ${done.length} llegaron a la toma de beneficio; resultado medio ${(ret! * 100).toFixed(1).replace(".", ",")} % sobre el capital`
    : `Gemelo mecánico de la misión #${run.mission_id}: sin gemelos (${note})`;
  logJournal({ missionId: run.mission_id, sessionId: null, kind: "shadow", summary, details: { hits, twins: done.length, shadowReturn: ret } });
  return summary;
}

function abandon(run: RunRow, nowMs: number, reason: string) {
  db.prepare("UPDATE shadow_runs SET status = 'abandoned', ended_at = ?, note = ? WHERE mission_id = ? AND status = 'running'").run(iso(nowMs), reason, run.mission_id);
  db.prepare("UPDATE shadow_positions SET status = 'abandoned', closed_at = ?, note = ? WHERE mission_id = ? AND status = 'open'").run(iso(nowMs), reason, run.mission_id);
  scanners.delete(run.mission_id);
}

/** ¿Hay algún gemelo en marcha? Mientras lo haya, su bucle sigue cada 5 s aunque la misión ya haya terminado. */
export const shadowsRunning = () => !!db.prepare("SELECT 1 FROM shadow_runs WHERE status = 'running' LIMIT 1").get();

/**
 * Una vuelta de los gemelos (la da su propio bucle de vigilancia, watch.ts): cotiza los abiertos que toquen (primero
 * los que han cumplido su plazo), busca eventos nuevos mientras falten gemelos y dura la ventana, y guarda el resultado
 * de los que han terminado. Devuelve líneas de log (no escribe en el diario hasta el final).
 */
export async function checkShadows(opts: { timing?: Partial<ShadowTiming>; nowMs?: number } = {}): Promise<string[]> {
  const timing = { ...SHADOW_TIMING, ...opts.timing };
  const nowMs = opts.nowMs ?? Date.now();
  const log: string[] = [];
  const runs = db
    .prepare("SELECT r.*, m.status AS mission_status FROM shadow_runs r JOIN missions m ON m.id = r.mission_id WHERE r.status = 'running' ORDER BY r.mission_id")
    .all() as unknown as Array<RunRow & { mission_status: string }>;
  for (const id of scanners.keys()) if (!runs.some((r) => r.mission_id === id)) scanners.delete(id);

  // Una misión cancelada (por el usuario o al crear otra) no se compara con nada: su gemelo se abandona.
  const live = runs.filter((r) => {
    if (r.mission_status !== "cancelled") return true;
    abandon(r, nowMs, "misión cancelada");
    return false;
  });
  let budget = timing.jupiterPerTick;

  // 1. Gemelos abiertos: primero los que han cumplido su plazo, después los que llevan más tiempo sin cotizar.
  const byMission = new Map(live.map((r) => [r.mission_id, r]));
  const open = (db.prepare("SELECT * FROM shadow_positions WHERE status = 'open' ORDER BY id").all() as unknown as TwinRow[]).filter((t) => byMission.has(t.mission_id));
  const isExpired = (t: TwinRow) => nowMs >= Date.parse(t.expires_at);
  const due = open
    .filter((t) => isExpired(t) || !t.last_quote_at || nowMs - Date.parse(t.last_quote_at) >= timing.quoteEveryMs - DUE_SLACK_MS)
    .sort((a, b) => Number(isExpired(b)) - Number(isExpired(a)) || Date.parse(a.last_quote_at ?? "") - Date.parse(b.last_quote_at ?? ""));
  for (const t of due) {
    // Uno visto tarde se cierra sin pedir nada (con su última cotización o fuera): no gasta turnos de Jupiter.
    const late = nowMs - Date.parse(t.expires_at) > timing.lateMs;
    if (!late && budget <= 0) continue;
    if (!late) budget--;
    const line = await quoteTwin(t, byMission.get(t.mission_id)!, nowMs, timing).catch((err) => `Error cotizando el gemelo #${t.id}: ${(err as Error).message}`);
    if (line) log.push(line);
  }

  // 2. Eventos nuevos, mientras falten gemelos y dure la ventana (el plazo de la misión desde que arrancó el reloj).
  for (const r of live) {
    const count = (db.prepare("SELECT COUNT(*) AS n FROM shadow_positions WHERE mission_id = ?").get(r.mission_id) as { n: number }).n;
    if (count >= r.target_count || nowMs >= Date.parse(r.detect_until)) {
      scanners.delete(r.mission_id);
      continue;
    }
    let scanner = scanners.get(r.mission_id);
    if (!scanner) {
      // Solo los filtros mecánicos (los de wait_for_signal por defecto): los del plan son donde el cerebro puede
      // aportar, y eso es lo que se mide. Por el carril de baja prioridad: el agente va primero.
      scanner = new SignalScanner({ source: r.source, filters: {}, usdAmount: r.size_usd, timing: timing.signal, lowPriority: true });
      scanners.set(r.mission_id, scanner);
    }
    scanner.exclude([...agentTokens(r.mission_id), ...twinsOf(r.mission_id).map((t) => t.token)]);
    // Un candidato nuevo son 3 peticiones a Jupiter (datos del token, compra y venta): solo si caben en esta vuelta.
    const checks = budget >= 3 ? 1 : 0;
    budget -= checks * 3;
    const hit = await scanner.poll(checks).catch(() => null);
    if (!hit) continue;
    const twin = openTwin(r, hit, nowMs);
    if (twin) log.push(`Gemelo #${twin.id} de la misión #${r.mission_id}: ${twin.symbol ?? twin.token} con ${twin.usd_in.toFixed(2)} $ (vender al momento: ${twin.entry_value_usd.toFixed(2)} $)`);
  }

  // 3. Resultados de los que ya han terminado.
  for (const r of live) {
    const line = finalize(r, nowMs);
    if (line) log.push(line);
  }
  return log;
}

/** El gemelo de una misión tal como lo lee el revisor (mission_review_data y el seguimiento por clase). */
export function shadowSummary(missionId: number) {
  const run = db.prepare("SELECT * FROM shadow_runs WHERE mission_id = ?").get(missionId) as RunRow | undefined;
  if (!run) return null;
  const initial = (db.prepare("SELECT initial_usd FROM missions WHERE id = ?").get(missionId) as { initial_usd: number } | undefined)?.initial_usd ?? run.size_usd;
  const all = twinsOf(missionId);
  // Los que no se pudieron seguir hasta el final no cuentan; los de una misión cancelada, tampoco.
  const twins = all.filter((t) => t.status !== "abandoned");
  const unobserved = run.status === "abandoned" ? 0 : all.length - twins.length;
  const done = twins.filter((t) => t.status === "hit" || t.status === "expired");
  const hits = done.filter((t) => t.status === "hit").length;
  const pct = (x: number) => Number((x * 100).toFixed(1));
  const clockMs = Date.parse(run.started_at);
  return {
    status:
      run.status === "done"
        ? "terminado"
        : run.status === "abandoned"
          ? `abandonado (${run.note ?? "misión cancelada"})`
          : `en curso: ${done.length} de ${twins.length} gemelos terminados${twins.length < run.target_count ? `, buscando eventos hasta ${run.detect_until}` : ""}`,
    rule: `comprar ${run.size_usd.toFixed(2)} $ en cada uno de los ${run.target_count} eventos siguientes (fuente ${run.source}, solo filtros mecánicos) con la toma de beneficio en ${run.tp_usd.toFixed(2)} $ (${run.tp_basis}) y ${Number(run.horizon_minutes.toFixed(1))} min de plazo cada uno`,
    hits,
    twins: done.length,
    ...(unobserved ? { unobserved: `${unobserved} gemelo(s) sin observar al final de su plazo: no cuentan` } : {}),
    ...(done.length ? { avgResultPct: pct(done.reduce((s, t) => s + (t.exit_usd! - t.usd_in), 0) / done.length / initial) } : {}),
    ...(run.note ? { note: run.note } : {}),
    positions: twins.map((t) => ({
      twinId: t.id,
      token: t.token,
      symbol: t.symbol ?? undefined,
      enteredMinutesAfterClock: Number(((Date.parse(t.opened_at) - clockMs) / 60_000).toFixed(1)),
      status: t.status === "hit" ? "toma de beneficio" : t.status === "expired" ? "cerrado por tiempo" : "abierto",
      entryValuePct: pct(t.entry_value_usd / t.usd_in - 1),
      bestPct: t.best_value_usd !== null ? pct(t.best_value_usd / t.usd_in - 1) : undefined,
      ...(t.exit_usd !== null ? { resultPct: pct(t.exit_usd / t.usd_in - 1) } : { nowPct: t.last_value_usd !== null ? pct(t.last_value_usd / t.usd_in - 1) : undefined }),
      quotes: t.quotes,
      ...(t.note ? { note: t.note } : {}),
    })),
  };
}
