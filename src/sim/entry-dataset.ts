// Conjunto de entradas de una clase de misión rápida (entry_dataset): una fila por entrada del agente y por gemelo, con
// su ficha de entrada (ficha.ts), su resultado real (toma de beneficio o por tiempo, y lo que dio) y la medida con velas
// (candles.ts). Es para que el planner busque filtros con evidencia, con la misma vara para el agente y los gemelos: p. ej.
// si los que llegan a la graduación con millones de mcap se quedan planos, o si los de pocos holders acaban en rug.
// split_by parte las filas por un campo de la ficha y da los aciertos de cada lado con su IC de Wilson.
import { db } from "../db.js";
import { classStats } from "./class-stats.js";
import { asCostMode, type CostMode } from "./costs.js";
import { wilson } from "./stats.js";

/** Columnas de la ficha en la tabla, en este orden (las que no tenga ninguna fila no salen). */
export const FEATURE_COLUMNS = [
  "poolAgeS",
  "graduatedAgoS",
  "tokenAgeS",
  "reserveUsd",
  "fdvUsd",
  "mcapUsd",
  "jupMcapUsd",
  "jupLiquidityUsd",
  "holders",
  "topHoldersPct",
  "devBalancePct",
  "devMints",
  "devMigrations",
  "organicScore",
  "bondingCurvePct",
  "buys5m",
  "sells5m",
  "buyers5m",
  "sellers5m",
  "volume5mUsd",
  "priceChange5mPct",
  "jupBuys5m",
  "jupSells5m",
  "traders5m",
  "netBuyers5m",
  "organicBuyers5m",
  "holderChange5mPct",
  "jupPriceChange5mPct",
  "roundTripPct",
  "mintDisabled",
  "freezeDisabled",
  "hasTwitter",
  "hasWebsite",
  "token2022",
  "launchpad",
] as const;

const FINISHED = "('succeeded', 'expired', 'bust')";

interface Entry {
  who: "agente" | "gemelo";
  mission: number;
  twin?: number;
  costs: CostMode;
  enteredAt: string;
  symbol?: string;
  /** Resultado con precios reales: el agente, la misión conseguida; el gemelo, su toma de beneficio con cotizaciones. */
  realHit: boolean;
  retPct?: number;
  candle: { status: string | null; wick: boolean; close: boolean; minutesToTp: number | null; ddPct: number | null; runupPct: number | null; count: number | null; note: string | null };
  tpRisePct?: number;
  ficha: Record<string, unknown>;
}

const parse = (raw: string | null): Record<string, unknown> => {
  try {
    const f = JSON.parse(raw ?? "null") as unknown;
    return f && typeof f === "object" ? (f as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const pct = (x: number) => Number((x * 100).toFixed(1));

type CandleRow = {
  candle_status: string | null;
  candle_hit_wick: number | null;
  candle_hit_close: number | null;
  minutes_to_tp: number | null;
  max_drawdown_pct: number | null;
  max_runup_pct: number | null;
  candle_count: number | null;
  candle_note: string | null;
};
const candleOf = (r: CandleRow): Entry["candle"] => ({
  status: r.candle_status,
  wick: r.candle_hit_wick === 1,
  close: r.candle_hit_close === 1,
  minutesToTp: r.minutes_to_tp,
  ddPct: r.max_drawdown_pct,
  runupPct: r.max_runup_pct,
  count: r.candle_count,
  note: r.candle_note,
});

/** Misiones terminadas de la clase (las que cuentan en sus estadísticas). */
export function classMissionIds(cls: string): number[] {
  return (db.prepare(`SELECT id FROM missions WHERE class = ? AND started_at IS NOT NULL AND status IN ${FINISHED}`).all(cls) as Array<{ id: number }>).map((r) => r.id);
}

/** Las entradas de la clase: las del agente (agent_entries) y los gemelos terminados, de la más antigua a la más reciente. */
export function classEntries(cls: string, costs?: CostMode): Entry[] {
  const agents = db
    .prepare(
      `SELECT a.*, m.status AS m_status, m.cost_mode FROM agent_entries a JOIN missions m ON m.id = a.mission_id
       WHERE m.class = ? AND m.status IN ${FINISHED}`,
    )
    .all(cls) as unknown as Array<
    CandleRow & { mission_id: number; token: string; symbol: string | null; entered_at: string; entry_price_usd: number; tp_price_usd: number | null; features: string | null; m_status: string; cost_mode: string | null }
  >;
  const position = db.prepare("SELECT realized_cost_usd AS c, realized_proceeds_usd AS p, status FROM positions WHERE mission_id = ? AND venue = 'solana' AND asset = ? ORDER BY id LIMIT 1");
  const twins = db
    .prepare(
      `SELECT p.*, r.tp_usd, m.cost_mode FROM shadow_positions p JOIN shadow_runs r ON r.mission_id = p.mission_id JOIN missions m ON m.id = p.mission_id
       WHERE m.class = ? AND m.status IN ${FINISHED} AND p.status IN ('hit', 'expired')`,
    )
    .all(cls) as unknown as Array<
    CandleRow & { id: number; mission_id: number; symbol: string | null; opened_at: string; usd_in: number; tokens_raw: string; decimals: number; exit_usd: number | null; costs_usd: number; status: string; tp_usd: number; features: string | null; cost_mode: string | null }
  >;
  const out: Entry[] = [
    ...agents.map((a): Entry => {
      const pos = position.get(a.mission_id, a.token) as { c: number; p: number; status: string } | undefined;
      return {
        who: "agente",
        mission: a.mission_id,
        costs: asCostMode(a.cost_mode),
        enteredAt: a.entered_at,
        ...(a.symbol ? { symbol: a.symbol } : {}),
        realHit: a.m_status === "succeeded",
        ...(pos?.status === "closed" && pos.c > 0 ? { retPct: pct(pos.p / pos.c - 1) } : {}),
        candle: candleOf(a),
        ...(a.tp_price_usd ? { tpRisePct: pct(a.tp_price_usd / a.entry_price_usd - 1) } : {}),
        ficha: parse(a.features),
      };
    }),
    ...twins.map((t): Entry => {
      const tokens = Number(t.tokens_raw) / 10 ** t.decimals;
      return {
        who: "gemelo",
        mission: t.mission_id,
        twin: t.id,
        costs: asCostMode(t.cost_mode),
        enteredAt: t.opened_at,
        ...(t.symbol ? { symbol: t.symbol } : {}),
        realHit: t.status === "hit",
        ...(t.exit_usd !== null ? { retPct: pct((t.exit_usd - (t.costs_usd ?? 0)) / t.usd_in - 1) } : {}),
        candle: candleOf(t),
        ...(tokens > 0 ? { tpRisePct: pct(t.tp_usd / t.usd_in - 1) } : {}),
        ficha: parse(t.features),
      };
    }),
  ];
  return out.filter((e) => !costs || e.costs === costs).sort((a, b) => a.enteredAt.localeCompare(b.enteredAt));
}

const yesNo = (c: Entry["candle"], k: "wick" | "close") => (c.status === "done" ? (c[k] ? "sí" : "no") : c.status === "unavailable" ? "n/d" : "pend.");

/** Una fila de la tabla: quién, cuándo, resultado real, velas y la ficha. */
function row(e: Entry): Record<string, unknown> {
  const f = e.ficha;
  return {
    who: e.who,
    mission: e.mission,
    twin: e.twin,
    costs: e.costs,
    at: e.enteredAt.slice(5, 16).replace("T", " "),
    symbol: e.symbol,
    realHit: e.realHit ? "sí" : "no",
    retPct: e.retPct,
    tpRisePct: e.tpRisePct,
    wick: yesNo(e.candle, "wick"),
    close: yesNo(e.candle, "close"),
    minToTp: e.candle.minutesToTp,
    drawdownPct: e.candle.ddPct,
    runupPct: e.candle.runupPct,
    ...Object.fromEntries(FEATURE_COLUMNS.map((k) => [k, f[k]])),
    fichaFrom: typeof f.from === "string" && f.from !== "señal" ? f.from : undefined,
  };
}

const rateText = (k: number, n: number) => {
  const ci = wilson(k, n);
  return n ? `${k} de ${n} (${Math.round((k / n) * 100)} %; IC95 ${ci.low}-${ci.high} %)` : "sin casos";
};

/**
 * Parte las entradas por un campo de la ficha: numérico, por `at` (por defecto, su mediana); sí/no, por su valor. Para
 * cada lado, los aciertos con velas (mecha) y con precios reales, del agente, de los gemelos y de todos.
 */
function splitBy(entries: Entry[], feature: string, at?: number) {
  const known = entries.filter((e) => e.ficha[feature] !== undefined && e.ficha[feature] !== null);
  const values = known.map((e) => e.ficha[feature]);
  const numeric = values.length > 0 && values.every((v) => typeof v === "number");
  let threshold = at;
  if (numeric && threshold === undefined) {
    const sorted = (values as number[]).slice().sort((a, b) => a - b);
    threshold = sorted[Math.floor((sorted.length - 1) / 2)]!;
  }
  const groupOf = (e: Entry): string => {
    const v = e.ficha[feature];
    if (v === undefined || v === null) return "sin dato";
    if (numeric) return (v as number) <= threshold! ? `≤ ${threshold}` : `> ${threshold}`;
    return String(v);
  };
  const groups = new Map<string, Entry[]>();
  for (const e of entries) groups.set(groupOf(e), [...(groups.get(groupOf(e)) ?? []), e]);
  const side = (es: Entry[]) => {
    const measured = es.filter((e) => e.candle.status === "done");
    return { entries: es.length, candleWick: rateText(measured.filter((e) => e.candle.wick).length, measured.length), realHits: rateText(es.filter((e) => e.realHit).length, es.length) };
  };
  return {
    feature,
    ...(numeric ? { at: threshold, ...(at === undefined ? { atNote: "la mediana (no se indicó split_at)" } : {}) } : {}),
    groups: [...groups.entries()].map(([group, es]) => ({
      group,
      agent: side(es.filter((e) => e.who === "agente")),
      twins: side(es.filter((e) => e.who === "gemelo")),
      all: side(es),
    })),
    note:
      "cada entrada cuenta como un caso: los gemelos de una misión comparten franja y no son del todo independientes, así que el IC real es algo más ancho. " +
      "Un filtro necesita que la diferencia se vea en el agente y en los gemelos, con intervalos que no se solapen",
  };
}

/** El conjunto de entradas de una clase para entry_dataset. */
export function entryDataset(opts: { cls: string; costs?: CostMode; who?: "all" | "agent" | "twin"; splitBy?: string; splitAt?: number; limit?: number }) {
  const all = classEntries(opts.cls, opts.costs).filter((e) => opts.who === undefined || opts.who === "all" || (opts.who === "agent" ? e.who === "agente" : e.who === "gemelo"));
  if (opts.splitBy) {
    const keys = new Set(all.flatMap((e) => Object.keys(e.ficha)));
    if (!keys.has(opts.splitBy)) throw new Error(`Ninguna entrada tiene «${opts.splitBy}» en su ficha. Campos disponibles: ${[...keys].filter((k) => k !== "from" && k !== "dev").sort().join(", ") || "ninguno"}`);
  }
  const limit = opts.limit ?? 120;
  const shown = all.slice(-limit);
  const stats = classStats({ cls: opts.cls, costMode: opts.costs ?? null, perMissionLimit: 1 }).map((s) => ({
    costs: s.costs,
    missions: s.missions,
    agentRealHits: s.hitRate,
    twinRealQuotes: typeof s.twin === "object" ? s.twin.hitRate : s.twin,
    candles: s.candles,
    ...(s.twinObservation ? { twinObservation: s.twinObservation } : {}),
  }));
  const agents = all.filter((e) => e.who === "agente");
  const twins = all.filter((e) => e.who === "gemelo");
  const measured = (es: Entry[]) => es.filter((e) => e.candle.status === "done").length;
  return {
    class: opts.cls,
    costs: opts.costs ?? "todas (cada fila dice la suya; las series sim y real no se mezclan en classStats)",
    entries: `${agents.length} del agente (${measured(agents)} medidas con velas) y ${twins.length} de gemelos (${measured(twins)} medidas)${shown.length < all.length ? `; salen las ${shown.length} más recientes` : ""}`,
    legend:
      "realHit: con precios reales (el agente, misión conseguida; el gemelo, su toma de beneficio con cotizaciones de Jupiter, que le faltaban a veces). " +
      "wick/close: con velas de 1 min, algún máximo / algún cierre llega a la toma de beneficio en su plazo (pend.: aún sin medir; n/d: sin velas). " +
      "minToTp: minutos hasta la vela que la toca (0: la de la entrada). drawdownPct: lo más bajo antes de tocarla; runupPct: lo más alto del plazo. " +
      "tpRisePct: subida que pedía la toma de beneficio sobre lo pagado. La ficha es de la señal (edades en segundos a la hora de entrar: pool, desde la graduación, del token); " +
      "Usd sin prefijo y buys5m… son de GeckoTerminal, jup… y holders, de Jupiter",
    rules:
      "Antes de proponer un filtro: que se vea en el agente y en los gemelos, con n y el IC de cada lado (split_by lo calcula). Con pocos casos no hay filtro. " +
      "Nunca se cambian reglas a mitad de bloque: un filtro nuevo es para el bloque siguiente",
    classStats: stats,
    ...(opts.splitBy ? { split: splitBy(all, opts.splitBy, opts.splitAt) } : {}),
    rows: shown.map(row),
  };
}

/** La clase por defecto: la de la misión indicada, la del plan vigente más reciente o la de la última entrada medida. */
export function defaultDatasetClass(missionClass: string | null | undefined, planClass: string | null | undefined): string | null {
  if (missionClass) return missionClass;
  if (planClass) return planClass;
  const last = db.prepare("SELECT m.class FROM agent_entries a JOIN missions m ON m.id = a.mission_id WHERE m.class IS NOT NULL ORDER BY a.entered_at DESC LIMIT 1").get() as
    | { class: string }
    | undefined;
  return last?.class ?? null;
}
