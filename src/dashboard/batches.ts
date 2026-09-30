// «Las tandas» del panel: todas las misiones rápidas, agrupadas por su serie (clase y modo de costes: las de costes
// realistas nunca se mezclan con las de siempre) y, dentro de cada serie, por el plan con el que se jugaron.
// De cada serie: el resultado acumulado misión a misión (con las fronteras de plan), los aciertos con su intervalo de
// Wilson al 95 %, lo que gana o pierde de media cada misión, las hundidas (acaban por debajo del −50 %) y el gemelo
// mecánico: con velas de 1 min si la base de datos ya las tiene (v0.37.2), si no con sus cotizaciones reales.
// La agregación es una función pura (aggregateBatches) para poder probarla; loadBatches la alimenta desde la base de datos.
import { db } from "../db.js";
import { isFastMission } from "../sim/mission-kind.js";
import { wilson } from "../sim/stats.js";

/** Una misión rápida con lo que necesita el panel. */
export interface FastMissionRow {
  id: number;
  status: string;
  end_reason: string | null;
  class: string | null;
  cost_mode: string | null;
  plan_id: number | null;
  requested_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  entry_latency_s: number | null;
  initial_usd: number;
  final_usd: number | null;
  predicted_p: number | null;
  /** El token en el que entró el agente. */
  symbol: string | null;
  /** Su gemelo mecánico: aciertos de los terminados, con la medida que se ha usado. */
  twin: TwinCount | null;
  /** Compras de enter_with_exits que revirtieron (entry_exclusions): una prep_timeout con alguna sí tuvo candidatos. */
  reverted_entries?: number;
}

export interface TwinCount {
  hits: number;
  done: number;
  /** 'velas': velas de 1 min del pool (mecha llega a la toma de beneficio); 'cotizaciones': las del propio gemelo. */
  measure: "velas" | "cotizaciones";
  /** El gemelo todavía está abriendo o vigilando posiciones. */
  running: boolean;
}

/** Se juega hasta el final: conseguida, por tiempo o sin fondos (las canceladas no cuentan en las cuentas). */
const PLAYED = new Set(["succeeded", "expired", "bust"]);
/** Una misión hundida: acaba por debajo de la mitad del capital. */
export const CRASH_PCT = -50;

const round = (x: number, d = 2) => Number(x.toFixed(d));
const pctOf = (r: Pick<FastMissionRow, "initial_usd" | "final_usd">) => (r.final_usd === null ? null : ((r.final_usd - r.initial_usd) / r.initial_usd) * 100);
const minutesBetween = (a: string | null, b: string | null) => (a && b ? round((Date.parse(b) - Date.parse(a)) / 60_000, 1) : null);

export const COST_LABEL: Record<string, string> = { sim: "costes de siempre", real: "costes reales" };

interface Rates {
  missions: number;
  hits: number;
  hitPct: number;
  ci95: [number, number];
  avgPnlUsd: number;
  totalPnlUsd: number;
  avgPct: number;
  crashes: number;
  twin: TwinSummary | null;
}

interface TwinSummary {
  /** Misiones con gemelo terminado (n del intervalo: los gemelos de una misión comparten franja y no son independientes). */
  missions: number;
  twins: number;
  hits: number;
  /** Media por misión de aciertos / terminados. */
  meanRatePct: number;
  ci95: [number, number];
  measure: "velas" | "cotizaciones" | "velas y cotizaciones";
  /** Aciertos del agente en esas mismas misiones, para compararlo con el gemelo. */
  agentHits: number;
  agentCi95: [number, number];
}

function rates(ms: FastMissionRow[]): Rates {
  const n = ms.length;
  const hits = ms.filter((m) => m.status === "succeeded").length;
  const pnl = ms.map((m) => m.final_usd! - m.initial_usd);
  const pcts = ms.map((m) => pctOf(m)!);
  const ci = wilson(hits, n);
  const withTwin = ms.filter((m) => m.twin && m.twin.done > 0);
  let twin: TwinSummary | null = null;
  if (withTwin.length) {
    const mean = withTwin.reduce((s, m) => s + m.twin!.hits / m.twin!.done, 0) / withTwin.length;
    const tci = wilson(mean * withTwin.length, withTwin.length);
    const measures = new Set(withTwin.map((m) => m.twin!.measure));
    const agentHits = withTwin.filter((m) => m.status === "succeeded").length;
    const aci = wilson(agentHits, withTwin.length);
    twin = {
      missions: withTwin.length,
      twins: withTwin.reduce((s, m) => s + m.twin!.done, 0),
      hits: withTwin.reduce((s, m) => s + m.twin!.hits, 0),
      meanRatePct: round(mean * 100, 1),
      ci95: [tci.low, tci.high],
      measure: measures.size > 1 ? "velas y cotizaciones" : [...measures][0]!,
      agentHits,
      agentCi95: [aci.low, aci.high],
    };
  }
  return {
    missions: n,
    hits,
    hitPct: n ? round((hits / n) * 100, 1) : 0,
    ci95: [ci.low, ci.high],
    avgPnlUsd: n ? round(pnl.reduce((s, x) => s + x, 0) / n) : 0,
    totalPnlUsd: round(pnl.reduce((s, x) => s + x, 0)),
    avgPct: n ? round(pcts.reduce((s, x) => s + x, 0) / n, 1) : 0,
    crashes: pcts.filter((p) => p < CRASH_PCT).length,
    twin,
  };
}

export interface SeriesPoint {
  /** Posición en la serie (1, 2, …): el eje x del gráfico. */
  n: number;
  missionId: number;
  planId: number | null;
  pnlUsd: number;
  resultPct: number;
  /** Resultado acumulado de la serie tras esta misión. */
  cumUsd: number;
  hit: boolean;
  crash: boolean;
  symbol: string | null;
}

export interface BatchSeries extends Rates {
  key: string;
  class: string;
  costMode: string;
  label: string;
  points: SeriesPoint[];
  /** Posiciones (n) donde empieza un plan distinto del anterior: las fronteras que se marcan en el gráfico. */
  planBoundaries: Array<{ n: number; planId: number | null }>;
  plans: Array<Rates & { planId: number | null; fromN: number; toN: number; predictedPct: number | null }>;
  /** Canceladas sin llegar a arrancar el reloj (60 min sin entrar: sin señal o con las compras revertidas): no cuentan en los aciertos. */
  cancelled: number;
  /**
   * Detenidas con el reloj ya en marcha (a mano, o sustituidas por otra misión): no son una jugada completa del plan, así
   * que no cuentan en los aciertos ni en el acumulado; su resultado se enseña aparte (stoppedPnlUsd) y en la tabla.
   */
  stopped: number;
  /** Lo que ganaron o perdieron las detenidas que tienen cartera final (una sustituida no la tiene); null si ninguna. */
  stoppedPnlUsd: number | null;
  /** Misiones de la serie en marcha o sin terminar de contar. */
  inProgress: number;
}

export interface BatchMission {
  id: number;
  seriesKey: string;
  costMode: string;
  planId: number | null;
  symbol: string | null;
  status: string;
  endReason: string | null;
  resultPct: number | null;
  pnlUsd: number | null;
  /** De pedir la misión a arrancar el reloj (lo que tardó la señal). */
  prepMinutes: number | null;
  entryLatencyS: number | null;
  twin: TwinCount | null;
  /** Compras que revirtieron antes de entrar: con prep_timeout, la misión no se quedó sin señal, sino sin poder entrar. */
  revertedEntries: number;
}

export interface Batches {
  series: BatchSeries[];
  /** De la más reciente a la más antigua. */
  missions: BatchMission[];
}

const seriesKey = (r: Pick<FastMissionRow, "class" | "cost_mode">) => `${r.class ?? "sin clase"}|${r.cost_mode ?? "sim"}`;
/** Cancelada con el reloj en marcha (detenida a mano o sustituida): tiene resultado si se valoró su cartera al pararla. */
const stoppedWithClock = (m: Pick<FastMissionRow, "status" | "started_at">) => m.status === "cancelled" && !!m.started_at;
/** El resultado que se enseña en la tabla: el de las jugadas hasta el final y el de las detenidas con reloj. */
const hasResult = (m: Pick<FastMissionRow, "status" | "started_at" | "final_usd">) => m.final_usd !== null && (PLAYED.has(m.status) || stoppedWithClock(m));

/** Agrupa las misiones rápidas en series (clase y costes) y planes. `rows`, en cualquier orden. */
export function aggregateBatches(rows: FastMissionRow[]): Batches {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const groups = new Map<string, FastMissionRow[]>();
  for (const r of sorted) groups.set(seriesKey(r), [...(groups.get(seriesKey(r)) ?? []), r]);

  const series: BatchSeries[] = [...groups.entries()].map(([key, all]) => {
    const played = all.filter((m) => PLAYED.has(m.status) && m.started_at && m.final_usd !== null);
    let cum = 0;
    const points: SeriesPoint[] = played.map((m, i) => {
      const pnl = m.final_usd! - m.initial_usd;
      cum += pnl;
      const pct = pctOf(m)!;
      return {
        n: i + 1,
        missionId: m.id,
        planId: m.plan_id,
        pnlUsd: round(pnl),
        resultPct: round(pct, 1),
        cumUsd: round(cum),
        hit: m.status === "succeeded",
        crash: pct < CRASH_PCT,
        symbol: m.symbol,
      };
    });
    const planBoundaries = points.filter((p, i) => i === 0 || p.planId !== points[i - 1]!.planId).map((p) => ({ n: p.n, planId: p.planId }));
    const byPlan = new Map<string, FastMissionRow[]>();
    for (const m of played) byPlan.set(String(m.plan_id), [...(byPlan.get(String(m.plan_id)) ?? []), m]);
    const plans = [...byPlan.values()].map((ms) => {
      const ns = ms.map((m) => points.find((p) => p.missionId === m.id)!.n);
      const withP = ms.filter((m) => m.predicted_p !== null);
      return {
        planId: ms[0]!.plan_id,
        fromN: Math.min(...ns),
        toN: Math.max(...ns),
        predictedPct: withP.length ? round((withP.reduce((s, m) => s + m.predicted_p!, 0) / withP.length) * 100, 1) : null,
        ...rates(ms),
      };
    });
    const [cls, costMode] = key.split("|") as [string, string];
    const stopped = all.filter(stoppedWithClock);
    const stoppedValued = stopped.filter((m) => m.final_usd !== null);
    return {
      key,
      class: cls,
      costMode,
      label: `${cls} · ${COST_LABEL[costMode] ?? costMode}`,
      ...rates(played),
      points,
      planBoundaries,
      plans,
      cancelled: all.filter((m) => m.status === "cancelled" && !m.started_at).length,
      stopped: stopped.length,
      stoppedPnlUsd: stoppedValued.length ? round(stoppedValued.reduce((s, m) => s + m.final_usd! - m.initial_usd, 0)) : null,
      inProgress: all.filter((m) => !PLAYED.has(m.status) && m.status !== "cancelled").length,
    };
  });

  const missions: BatchMission[] = [...sorted].reverse().map((m) => {
    const pct = pctOf(m);
    return {
      id: m.id,
      seriesKey: seriesKey(m),
      costMode: m.cost_mode ?? "sim",
      planId: m.plan_id,
      symbol: m.symbol,
      status: m.status,
      endReason: m.end_reason,
      resultPct: pct === null || !hasResult(m) ? null : round(pct, 1),
      pnlUsd: m.final_usd === null || !hasResult(m) ? null : round(m.final_usd - m.initial_usd),
      prepMinutes: minutesBetween(m.requested_at, m.started_at),
      entryLatencyS: m.entry_latency_s,
      twin: m.twin,
      revertedEntries: m.reverted_entries ?? 0,
    };
  });
  return { series, missions };
}

// ── Base de datos ───────────────────────────────────────────────────────────
// Lo que falta en una base de datos antigua (las columnas de velas llegan con v0.37.2) no rompe el panel: se mira qué
// hay antes de pedirlo.
const columnCache = new Map<string, Set<string>>();

export function columnsOf(table: string): Set<string> {
  let cols = columnCache.get(table);
  if (!cols) {
    cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    // Una tabla que aún no existe (lista vacía) se vuelve a mirar: la puede crear una migración de otro proceso.
    if (cols.size) columnCache.set(table, cols);
  }
  return cols;
}

/** Olvida lo que sabía de las columnas (las pruebas cambian el esquema a mitad). */
export function forgetColumns() {
  columnCache.clear();
  batchesCache = null;
}

const STABLES = ["USDC", "USDT", "SOL", "WSOL", "FDUSD", "USDbC"];

/** El token de cada misión: la entrada medida (v0.37.2) o, si no, su primera compra que no sea un estable ni SOL. */
function symbolsByMission(): Map<number, string> {
  const out = new Map<number, string>();
  const rows = db
    .prepare(`SELECT mission_id, symbol FROM positions WHERE mission_id IS NOT NULL AND symbol NOT IN (${STABLES.map(() => "?").join(", ")}) ORDER BY id DESC`)
    .all(...STABLES) as Array<{ mission_id: number; symbol: string }>;
  for (const r of rows) out.set(r.mission_id, r.symbol); // de la más reciente a la más antigua: queda la primera compra
  if (columnsOf("agent_entries").has("symbol")) {
    for (const r of db.prepare("SELECT mission_id, symbol FROM agent_entries WHERE symbol IS NOT NULL").all() as Array<{ mission_id: number; symbol: string }>) {
      out.set(r.mission_id, r.symbol);
    }
  }
  return out;
}

/** El gemelo de cada misión: con velas si hay alguno medido con ellas, si no con sus cotizaciones. */
function twinsByMission(): Map<number, TwinCount> {
  const candles = ["candle_status", "candle_hit_wick"].every((c) => columnsOf("shadow_positions").has(c));
  const rows = db
    .prepare(
      `SELECT r.mission_id, r.status AS run_status,
              COALESCE(SUM(p.status IN ('hit', 'expired')), 0) AS done,
              COALESCE(SUM(p.status = 'hit'), 0) AS hits
              ${candles ? `, COALESCE(SUM(p.status IN ('hit', 'expired') AND p.candle_status = 'done'), 0) AS cdone,
                 COALESCE(SUM(p.status IN ('hit', 'expired') AND p.candle_status = 'done' AND p.candle_hit_wick = 1), 0) AS chits` : ""}
       FROM shadow_runs r LEFT JOIN shadow_positions p ON p.mission_id = r.mission_id
       GROUP BY r.mission_id`,
    )
    .all() as Array<{ mission_id: number; run_status: string; done: number; hits: number; cdone?: number; chits?: number }>;
  const out = new Map<number, TwinCount>();
  for (const r of rows) {
    const running = r.run_status === "running";
    if (r.cdone) out.set(r.mission_id, { hits: r.chits ?? 0, done: r.cdone, measure: "velas", running });
    else out.set(r.mission_id, { hits: r.hits, done: r.done, measure: "cotizaciones", running });
  }
  return out;
}

/** Las misiones rápidas de la base de datos (simuladas y de 15 min o menos). */
export function loadFastMissions(): FastMissionRow[] {
  const rows = db
    .prepare(
      `SELECT id, status, end_reason, class, cost_mode, plan_id, requested_at, created_at, started_at, ended_at, deadline, mode,
              entry_latency_s, initial_usd, final_usd, predicted_p
       FROM missions ORDER BY id`,
    )
    .all() as Array<Omit<FastMissionRow, "symbol" | "twin"> & { created_at: string; deadline: string; mode: string | null }>;
  const fast = rows.filter((r) => isFastMission(r));
  if (!fast.length) return [];
  const symbols = symbolsByMission();
  const twins = twinsByMission();
  // Las compras que revirtieron (v0.37.2): en una base de datos anterior la tabla aún no existe.
  const reverted = new Map<number, number>(
    columnsOf("entry_exclusions").size
      ? (db.prepare("SELECT mission_id, COUNT(*) AS n FROM entry_exclusions GROUP BY mission_id").all() as Array<{ mission_id: number; n: number }>).map((r) => [r.mission_id, r.n])
      : [],
  );
  return fast.map(({ created_at: _c, deadline: _d, mode: _m, ...r }) => ({
    ...r,
    symbol: symbols.get(r.id) ?? null,
    twin: twins.get(r.id) ?? null,
    reverted_entries: reverted.get(r.id) ?? 0,
  }));
}

// Se recalcula solo si algo ha cambiado (el panel pregunta cada 3 s): la huella son unas cuentas sobre las misiones y
// los gemelos, y como mucho cada 30 s de todos modos (las velas llegan minutos después de acabar cada misión).
let batchesCache: { key: string; at: number; value: Batches } | null = null;

function fingerprint(): string {
  const m = db.prepare("SELECT COUNT(*) AS n, MAX(id) AS id, MAX(ended_at) AS e, COUNT(shadow_hits) AS s, MAX(started_at) AS st, MAX(plan_id) AS p FROM missions").get();
  const s = db.prepare("SELECT COUNT(*) AS n, SUM(status <> 'open') AS closed FROM shadow_positions").get();
  const x = columnsOf("entry_exclusions").size ? db.prepare("SELECT COUNT(*) AS n FROM entry_exclusions").get() : null;
  return JSON.stringify([m, s, x]);
}

export function loadBatches(): Batches {
  const key = fingerprint();
  if (batchesCache && batchesCache.key === key && Date.now() - batchesCache.at < 30_000) return batchesCache.value;
  const value = aggregateBatches(loadFastMissions());
  batchesCache = { key, at: Date.now(), value };
  return value;
}
