// Resultado de cada entrada de una misión rápida medido con las velas de 1 min de su pool (GeckoTerminal), la misma vara
// para el agente y para los gemelos mecánicos. Por qué: el gemelo cotiza por el carril de baja prioridad de Jupiter y en
// los datos reales perdió cotizaciones (429 y turnos ocupados: hizo el 76-83 % de las que tocaban mientras estuvo
// abierto); con los huecos puede perderse picos cortos, y una cotización perdida solo puede quitarle aciertos, nunca
// dárselos. Con cotizaciones acertó 6 de 20, y el agente, con la misma regla, 11 de 17. Las velas no dependen de quién las
// mire.
//
// Qué se guarda de cada entrada, entre la entrada y el final de su plazo (el agente: el plazo de la misión, aunque acabe
// antes; el gemelo: el suyo):
// - candle_hit_wick: algún máximo de 1 min llegó al precio de la toma de beneficio (en USD por token);
// - candle_hit_close: algún cierre de 1 min dentro del plazo llegó (más exigente: el pico duró hasta el final del minuto);
// - minutes_to_tp: de la entrada al principio de la primera vela que la toca (0: la vela de la propia entrada);
// - max_drawdown_pct: el mínimo antes de tocarla (sin la vela que la toca, de la que solo cuenta la apertura: no se sabe
//   si su mínimo fue antes o después del pico) o de todo el plazo, frente al precio de entrada;
// - max_runup_pct: el máximo de todo el plazo frente al precio de entrada; candle_count: velas en el plazo.
// Las velas son las que acaban después de la entrada y no más tarde del final del plazo: la de la entrada es parcial (un
// pico suyo pudo ser justo antes de entrar; minutes_to_tp = 0 lo delata) y la que cruza el final del plazo no cuenta (su
// cierre es de después y su pico puede serlo). Con un plazo de minutos enteros son justo N velas: los segundos de antes de
// la entrada que mete la primera son los mismos que se quedan fuera al final. El precio de entrada es lo pagado
// entre los tokens recibidos (con comisiones e impacto) y la toma de beneficio, lo que da venderlo todo entre los tokens:
// los dos son precios efectivos, y las velas, el precio del pool.
//
// Cuándo: pasados CANDLE_SETTLE_MS del final del plazo (las velas tardan en publicarse), en su propio bucle lento
// (watch.ts: una petición cada CANDLE_LOOP_MS, por el carril de baja prioridad, que no hace cola delante de nadie) o al
// pedir la revisión de la misión (mission_review_data) o el conjunto de entradas (entry_dataset). Una petición por
// posición (dos si hay que buscar su pool), contadas antes de hacerlas: una que falla también gasta. Con un 429, se deja
// para más tarde (y todo el bucle espera) sin insistir; con un fallo pasajero (5xx, sin respuesta, red caída, IP
// bloqueada), también se deja para más tarde y no cuenta como intento: MAX_FAILURES es solo para las respuestas que no
// van a cambiar (pool desconocido o sin velas en su plazo).
import { db } from "../db.js";
import { fetchJson, HostBusyError, isTransientError } from "../market/http.js";

/** Vela de GeckoTerminal: [segundo de inicio, apertura, máximo, mínimo, cierre]. */
export type Candle = [number, number, number, number, number];

/** Espera tras el final del plazo antes de pedir sus velas: GeckoTerminal tarda en publicar las últimas. */
export const CANDLE_SETTLE_MS = 5 * 60_000;
/** Cada cuánto el bucle de fondo pide las velas de una posición (una por vuelta). */
export const CANDLE_LOOP_MS = 30_000;
/** Respuestas definitivas (pool desconocido, sin velas en su plazo, 404) antes de darla por no medible. Lo pasajero no cuenta. */
const MAX_FAILURES = 4;
/** Tras un fallo pasajero, cuánto se espera: una cuarta parte de lo que lleva terminada, entre 10 min y 6 h (nunca se abandona). */
const TRANSIENT_RETRY_MIN_MS = 10 * 60_000;
const TRANSIENT_RETRY_MAX_MS = 6 * 3600_000;
/** Tras un 429, cuánto se espera (se dobla con cada 429 seguido, hasta 30 min). */
const RATE_LIMIT_BACKOFF_MS = 2 * 60_000;
/** Si el pool se aleja más que esto del precio de entrada en la vela de la entrada, la medida es poco fiable. */
const UNRELIABLE_GAP_PCT = 30;

const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana";
const JUPITER_SEARCH = "https://lite-api.jup.ag/tokens/v2/search";

export interface CandleOutcome {
  hitWick: boolean;
  hitClose: boolean;
  minutesToTp: number | null;
  maxDrawdownPct: number;
  maxRunupPct: number;
  candleCount: number;
  /** Cierre de la vela de la entrada frente al precio de entrada (null si esa vela no está). */
  gapPct: number | null;
}

const r2 = (x: number) => Number(x.toFixed(2));

/** Las métricas de una entrada con sus velas (ver la cabecera). null si no hay ninguna vela en su plazo. */
export function candleOutcome(a: { candles: Candle[]; entryMs: number; endMs: number; entryPriceUsd: number; tpPriceUsd: number }): CandleOutcome | null {
  if (!(a.entryPriceUsd > 0) || !(a.tpPriceUsd > 0)) return null;
  const entrySec = a.entryMs / 1000;
  const endSec = a.endMs / 1000;
  // La que cruza el final del plazo no entra: su cierre es de después y su pico puede serlo (ver la cabecera).
  const w = a.candles.filter((c) => c[0] + 60 > entrySec && c[0] + 60 <= endSec).sort((x, y) => x[0] - y[0]);
  if (!w.length) return null;
  const pct = (p: number) => (p / a.entryPriceUsd - 1) * 100;
  const touch = w.findIndex((c) => c[2] >= a.tpPriceUsd);
  const lows = (touch >= 0 ? w.slice(0, touch) : w).map((c) => c[3]);
  if (touch >= 0) lows.push(w[touch]![1]);
  const entryCandle = w[0]![0] <= entrySec ? w[0] : undefined;
  return {
    hitWick: touch >= 0,
    hitClose: w.some((c) => c[4] >= a.tpPriceUsd),
    minutesToTp: touch >= 0 ? Number(Math.max(0, (w[touch]![0] - entrySec) / 60).toFixed(1)) : null,
    maxDrawdownPct: r2(Math.min(0, pct(Math.min(...lows)))),
    maxRunupPct: r2(pct(Math.max(...w.map((c) => c[2])))),
    candleCount: w.length,
    gapPct: entryCandle ? r2(pct(entryCandle[4])) : null,
  };
}

/** Velas de 1 min del pool en USD (del lado del token) que cubren [fromMs, toMs]. */
export async function fetchPoolCandles(pool: string, token: string, fromMs: number, toMs: number, opts: { lowPriority?: boolean } = {}): Promise<Candle[]> {
  const fromSec = Math.floor(fromMs / 60_000) * 60;
  const beforeSec = Math.ceil(toMs / 60_000) * 60 + 60;
  const limit = Math.min(1000, Math.ceil((beforeSec - fromSec) / 60) + 1);
  const res = await fetchJson<{ data?: { attributes?: { ohlcv_list?: unknown[] } } }>(
    `${GECKO}/pools/${pool}/ohlcv/minute?aggregate=1&before_timestamp=${beforeSec}&limit=${limit}&currency=usd&token=${token}`,
    { timeoutMs: 15_000, ttlMs: 600_000, lowPriority: opts.lowPriority },
  );
  const list = res?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) throw new Error("GeckoTerminal no devolvió velas");
  return list
    .map((row) => (Array.isArray(row) ? row.slice(0, 5).map(Number) : []))
    .filter((c): c is Candle => c.length === 5 && c.every((x) => Number.isFinite(x)))
    .sort((a, b) => a[0] - b[0]);
}

/** El graduatedPool del token en la búsqueda de Jupiter (null si no lo da o falla; Jupiter ocupado sí se propaga). */
async function jupiterPool(token: string, lowPriority: boolean): Promise<string | null> {
  try {
    const list = await fetchJson<Array<Record<string, any>>>(`${JUPITER_SEARCH}?query=${token}`, { timeoutMs: 15_000, ttlMs: 600_000, lowPriority });
    const pool = list.find((t) => t.id === token)?.graduatedPool;
    return typeof pool === "string" && pool ? pool : null;
  } catch (err) {
    if (err instanceof HostBusyError) throw err;
    return null;
  }
}

/** El pool del token con más liquidez en GeckoTerminal (una petición). */
async function geckoPool(token: string, lowPriority: boolean): Promise<string | null> {
  const res = await fetchJson<{ data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string } }> }>(`${GECKO}/tokens/${token}/pools?page=1`, {
    timeoutMs: 15_000,
    ttlMs: 3_600_000,
    lowPriority,
  });
  const best = [...(res.data ?? [])].sort((a, b) => Number(b.attributes?.reserve_in_usd ?? 0) - Number(a.attributes?.reserve_in_usd ?? 0))[0];
  return best?.attributes?.address ?? null;
}

/** Una entrada por medir, del agente o de un gemelo. */
interface Unit {
  table: "agent_entries" | "shadow_positions";
  key: string;
  id: number;
  missionId: number;
  token: string;
  pool: string | null;
  entryMs: number;
  endMs: number;
  entryPriceUsd: number;
  tpPriceUsd: number | null;
  failures: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Las entradas cuyas velas ya se pueden pedir (su plazo terminó hace CANDLE_SETTLE_MS), de la más antigua a la más reciente. */
function dueUnits(nowMs: number, missionIds?: number[]): Unit[] {
  const settled = iso(nowMs - CANDLE_SETTLE_MS);
  const nowIso = iso(nowMs);
  const inMissions = missionIds ? `AND mission_id IN (${missionIds.map(Number).join(",") || "NULL"})` : "";
  const agents = db
    .prepare(
      `SELECT mission_id, token, pool, entered_at, horizon_end, entry_price_usd, tp_price_usd, candle_attempts FROM agent_entries
       WHERE candle_status IS NULL AND horizon_end <= ? AND (candle_next_at IS NULL OR candle_next_at <= ?) ${inMissions}`,
    )
    .all(settled, nowIso) as Array<{ mission_id: number; token: string; pool: string | null; entered_at: string; horizon_end: string; entry_price_usd: number; tp_price_usd: number | null; candle_attempts: number }>;
  const twins = db
    .prepare(
      `SELECT p.id, p.mission_id, p.token, p.pool, p.opened_at, p.expires_at, p.usd_in, p.tokens_raw, p.decimals, p.candle_attempts, r.tp_usd
       FROM shadow_positions p JOIN shadow_runs r ON r.mission_id = p.mission_id
       WHERE p.status IN ('hit', 'expired') AND p.candle_status IS NULL AND p.expires_at <= ? AND (p.candle_next_at IS NULL OR p.candle_next_at <= ?) ${inMissions.replace("mission_id", "p.mission_id")}`,
    )
    .all(settled, nowIso) as Array<{ id: number; mission_id: number; token: string; pool: string | null; opened_at: string; expires_at: string; usd_in: number; tokens_raw: string; decimals: number; candle_attempts: number; tp_usd: number }>;
  const units: Unit[] = [
    ...agents.map((a): Unit => ({
      table: "agent_entries",
      key: "mission_id",
      id: a.mission_id,
      missionId: a.mission_id,
      token: a.token,
      pool: a.pool,
      entryMs: Date.parse(a.entered_at),
      endMs: Date.parse(a.horizon_end),
      entryPriceUsd: a.entry_price_usd,
      tpPriceUsd: a.tp_price_usd,
      failures: a.candle_attempts,
    })),
    ...twins.map((t): Unit => {
      const tokens = Number(t.tokens_raw) / 10 ** t.decimals;
      return {
        table: "shadow_positions",
        key: "id",
        id: t.id,
        missionId: t.mission_id,
        token: t.token,
        pool: t.pool,
        entryMs: Date.parse(t.opened_at),
        endMs: Date.parse(t.expires_at),
        entryPriceUsd: tokens > 0 ? t.usd_in / tokens : 0,
        tpPriceUsd: tokens > 0 ? t.tp_usd / tokens : null,
        failures: t.candle_attempts,
      };
    }),
  ];
  return units.sort((a, b) => a.endMs - b.endMs);
}

/** ¿Hay alguna entrada cuyas velas ya se puedan pedir? (el bucle de fondo no hace nada si no). */
export function candlesDue(nowMs = Date.now()): boolean {
  return dueUnits(nowMs).length > 0;
}

const update = (u: Unit, sets: string, ...values: Array<string | number | null>) =>
  db.prepare(`UPDATE ${u.table} SET ${sets} WHERE ${u.key} = ? AND candle_status IS NULL`).run(...values, u.id);

/** Una respuesta definitiva (no pasajera): se reintenta más tarde y, pasados MAX_FAILURES, la entrada queda como no medible. */
function fail(u: Unit, note: string, nowMs: number, retryMs = 10 * 60_000) {
  if (u.failures + 1 >= MAX_FAILURES) update(u, "candle_status = 'unavailable', candle_attempts = candle_attempts + 1, candle_note = ?, candle_next_at = NULL", note);
  else update(u, "candle_attempts = candle_attempts + 1, candle_note = ?, candle_next_at = ?", note, iso(nowMs + retryMs));
}

/** Tras un 429 de GeckoTerminal, nadie de este proceso le pide velas hasta aquí (ms). */
let pausedUntil = 0;
let consecutive429 = 0;

/** Un fallo pasajero (5xx, sin respuesta, red caída, IP bloqueada): se deja para más tarde sin gastar un intento. */
function isPassing(err: unknown): boolean {
  return isTransientError(err) || /HTTP 418|bloqueado temporalmente/.test(String((err as Error)?.message ?? err));
}

/**
 * Mide las entradas que toquen: como mucho maxRequests peticiones a GeckoTerminal (una por entrada; dos si hay que
 * buscar su pool), contadas antes de hacerlas, vaya bien o mal. La búsqueda del pool en Jupiter no cuenta, pero solo se
 * hace si queda presupuesto y la sigue siempre una a GeckoTerminal, así que tampoco pasan de maxRequests. Con
 * missionIds, solo las de esas misiones. Devuelve líneas de log.
 */
export async function checkCandleOutcomes(opts: { nowMs?: number; maxRequests?: number; missionIds?: number[]; lowPriority?: boolean } = {}): Promise<string[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const lowPriority = opts.lowPriority ?? true;
  let budget = opts.maxRequests ?? 1;
  const log: string[] = [];
  if (Date.now() < pausedUntil) return log;
  for (const u of dueUnits(nowMs, opts.missionIds)) {
    if (budget <= 0) break;
    const who = u.table === "agent_entries" ? `agente de la misión #${u.missionId}` : `gemelo #${u.id}`;
    if (!(u.tpPriceUsd! > 0) || !(u.entryPriceUsd > 0)) {
      update(u, "candle_status = 'unavailable', candle_note = ?", "sin precio de entrada o de toma de beneficio");
      continue;
    }
    try {
      let pool = u.pool;
      if (!pool) {
        pool = await jupiterPool(u.token, lowPriority);
        if (!pool) {
          // Cuenta antes de pedir: si falla (5xx, sin respuesta), la petición ya se ha gastado.
          budget--;
          pool = await geckoPool(u.token, lowPriority);
        }
        if (!pool) {
          fail(u, "sin pool conocido del token", nowMs);
          continue;
        }
        db.prepare(`UPDATE ${u.table} SET pool = ? WHERE ${u.key} = ?`).run(pool, u.id);
        if (budget <= 0) break;
      }
      budget--;
      const candles = await fetchPoolCandles(pool, u.token, u.entryMs, u.endMs, { lowPriority });
      consecutive429 = 0;
      const out = candleOutcome({ candles, entryMs: u.entryMs, endMs: u.endMs, entryPriceUsd: u.entryPriceUsd, tpPriceUsd: u.tpPriceUsd! });
      if (!out) {
        fail(u, "sin velas en su plazo (pool sin operaciones o aún sin datos en GeckoTerminal)", nowMs);
        continue;
      }
      const note =
        out.gapPct !== null && Math.abs(out.gapPct) > UNRELIABLE_GAP_PCT
          ? `poco fiable: la vela de la entrada cierra un ${out.gapPct} % lejos del precio de entrada`
          : null;
      update(
        u,
        `candle_status = 'done', candle_hit_wick = ?, candle_hit_close = ?, minutes_to_tp = ?, max_drawdown_pct = ?, max_runup_pct = ?,
         candle_count = ?, candle_gap_pct = ?, candle_note = ?, candle_next_at = NULL`,
        Number(out.hitWick),
        Number(out.hitClose),
        out.minutesToTp,
        out.maxDrawdownPct,
        out.maxRunupPct,
        out.candleCount,
        out.gapPct,
        note,
      );
      log.push(`Velas del ${who}: ${out.hitWick ? `toca la toma de beneficio a los ${out.minutesToTp} min` : "no toca la toma de beneficio"} (${out.candleCount} velas)`);
    } catch (err) {
      // Carril ocupado: se deja para la vuelta siguiente, sin anotar nada.
      if (err instanceof HostBusyError) break;
      const msg = (err as Error).message;
      if (/HTTP 429/.test(msg)) {
        // Sin insistir: esta entrada y todo el bucle esperan (el doble con cada 429 seguido).
        consecutive429++;
        const wait = Math.min(30 * 60_000, RATE_LIMIT_BACKOFF_MS * 2 ** (consecutive429 - 1));
        pausedUntil = Date.now() + wait;
        update(u, "candle_next_at = ?, candle_note = ?", iso(nowMs + wait), "GeckoTerminal respondió 429: se vuelve a pedir más tarde");
        log.push(`Velas del ${who}: GeckoTerminal respondió 429; se vuelve a pedir en ${Math.round(wait / 60_000)} min`);
        break;
      }
      if (isPassing(err)) {
        // Pasajero: no gasta un intento (si no, media hora de GeckoTerminal caído dejaría la cola entera sin medir para
        // siempre) y no se insiste con las demás en esta vuelta.
        const wait = Math.min(TRANSIENT_RETRY_MAX_MS, Math.max(TRANSIENT_RETRY_MIN_MS, (nowMs - u.endMs) / 4));
        update(u, "candle_next_at = ?, candle_note = ?", iso(nowMs + wait), `fallo pasajero, se vuelve a pedir más tarde: ${msg.slice(0, 160)}`);
        log.push(`Velas del ${who}: fallo pasajero (${msg.slice(0, 80)}); se vuelve a pedir en ${Math.round(wait / 60_000)} min`);
        break;
      }
      fail(u, `error pidiendo velas: ${msg.slice(0, 160)}`, nowMs);
    }
  }
  return log;
}

/** Solo para los tests: olvida la pausa tras un 429. */
export function resetCandlePause() {
  pausedUntil = 0;
  consecutive429 = 0;
}

/** Columnas de la medida con velas, como las guardan agent_entries y shadow_positions. */
export interface CandleColumns {
  candle_status: string | null;
  candle_note: string | null;
  candle_next_at?: string | null;
  candle_hit_wick: number | null;
  candle_hit_close: number | null;
  minutes_to_tp: number | null;
  max_drawdown_pct: number | null;
  max_runup_pct: number | null;
  candle_count: number | null;
  candle_gap_pct: number | null;
}

/** La medida con velas de una entrada tal como la lee el revisor. */
export function candleView(r: CandleColumns): Record<string, unknown> | string {
  if (r.candle_status === "done") {
    return {
      touchesTp: r.candle_hit_wick === 1 ? "sí (mecha)" : "no",
      closesAtTp: r.candle_hit_close === 1,
      ...(r.minutes_to_tp !== null ? { minutesToTp: r.minutes_to_tp } : {}),
      maxDrawdownPct: r.max_drawdown_pct,
      maxRunupPct: r.max_runup_pct,
      candles: r.candle_count,
      ...(r.candle_note ? { note: r.candle_note } : {}),
    };
  }
  if (r.candle_status === "unavailable") return `sin medir: ${r.candle_note ?? "sin velas"}`;
  return `pendiente: se mide con velas ${CANDLE_SETTLE_MS / 60_000} min después de su plazo${r.candle_note ? ` (${r.candle_note})` : ""}`;
}

/** La entrada del agente en una misión rápida (agent_entries), para la revisión de la misión. */
export function agentEntrySummary(missionId: number) {
  const r = db.prepare("SELECT * FROM agent_entries WHERE mission_id = ?").get(missionId) as
    | (CandleColumns & { token: string; symbol: string | null; pool: string | null; entered_at: string; horizon_end: string; usd_in: number; tokens: number; entry_price_usd: number; tp_price_usd: number | null; features: string | null })
    | undefined;
  if (!r) return null;
  let ficha: unknown;
  try {
    ficha = r.features ? JSON.parse(r.features) : undefined;
  } catch {
    ficha = undefined;
  }
  return {
    token: r.token,
    ...(r.symbol ? { symbol: r.symbol } : {}),
    ...(r.pool ? { pool: r.pool } : {}),
    enteredAt: r.entered_at,
    measuredUntil: r.horizon_end,
    usdIn: r.usd_in,
    entryPrice: r.entry_price_usd,
    ...(r.tp_price_usd ? { tpPrice: r.tp_price_usd, tpRisePct: Number(((r.tp_price_usd / r.entry_price_usd - 1) * 100).toFixed(1)) } : {}),
    candles: candleView(r),
    ...(ficha ? { ficha } : { ficha: "sin ficha" }),
  };
}

/**
 * Minutos que un gemelo terminado estuvo abierto y tocaba cotizarlo: de su entrada a su cierre, como mucho su plazo. Uno
 * que llega pronto a la toma de beneficio deja de cotizarse al cerrarse: el resto de su plazo no son cotizaciones perdidas
 * (contarlas así bajaba la cobertura precisamente por los que aciertan). Sin hora de cierre, el plazo entero.
 */
export function twinOpenMinutes(t: { opened_at: string; closed_at: string | null }, horizonMinutes: number): number {
  const open = t.closed_at ? (Date.parse(t.closed_at) - Date.parse(t.opened_at)) / 60_000 : Number.NaN;
  return Number.isFinite(open) ? Math.max(0, Math.min(horizonMinutes, open)) : horizonMinutes;
}

/** Por misión: la medida con velas del agente y de sus gemelos terminados, y la observación de los gemelos. */
export function candleCounts() {
  const agents = db.prepare("SELECT mission_id, candle_status, candle_hit_wick, candle_hit_close FROM agent_entries").all() as Array<{
    mission_id: number;
    candle_status: string | null;
    candle_hit_wick: number | null;
    candle_hit_close: number | null;
  }>;
  const rows = db
    .prepare(
      `SELECT p.mission_id, p.candle_status, p.candle_hit_wick, p.candle_hit_close, p.quotes, p.quotes_missed, p.opened_at, p.closed_at, r.horizon_minutes
       FROM shadow_positions p JOIN shadow_runs r ON r.mission_id = p.mission_id
       WHERE p.status IN ('hit', 'expired')`,
    )
    .all() as Array<{
    mission_id: number;
    candle_status: string | null;
    candle_hit_wick: number | null;
    candle_hit_close: number | null;
    quotes: number;
    quotes_missed: number | null;
    opened_at: string;
    closed_at: string | null;
    horizon_minutes: number;
  }>;
  type Twins = { n: number; done: number; wick: number; close: number; pending: number; quotes: number; missed: number; openMinutes: number };
  const out = new Map<number, { agent?: { status: string | null; wick: boolean; close: boolean }; twins?: Twins }>();
  for (const a of agents) out.set(a.mission_id, { agent: { status: a.candle_status, wick: a.candle_hit_wick === 1, close: a.candle_hit_close === 1 } });
  for (const p of rows) {
    const cur = out.get(p.mission_id) ?? {};
    const t = cur.twins ?? { n: 0, done: 0, wick: 0, close: 0, pending: 0, quotes: 0, missed: 0, openMinutes: 0 };
    const done = p.candle_status === "done";
    t.n++;
    t.done += Number(done);
    t.wick += Number(done && p.candle_hit_wick === 1);
    t.close += Number(done && p.candle_hit_close === 1);
    t.pending += Number(p.candle_status === null);
    t.quotes += p.quotes ?? 0;
    t.missed += p.quotes_missed ?? 0;
    t.openMinutes += twinOpenMinutes(p, p.horizon_minutes);
    out.set(p.mission_id, { ...cur, twins: t });
  }
  return out;
}
