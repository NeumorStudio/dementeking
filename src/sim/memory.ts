// Memoria entre misiones, de tres tipos:
// - Procedimental (howtos): cómo se hace algo, qué falla y cómo evitarlo.
// - Creencias sobre el mercado (beliefs): su evidencia no la declara nadie; la calcula el simulador con
//   las posiciones reales (las que aplicaron la creencia y, si tiene condición, las que la cumplían).
// - Episódica: el diario de cada misión y su retrospectiva (mission_reviews).
//
// La escribe el agente revisor, no el que opera: así el agente no juzga sus propias decisiones.
// El que opera deja observaciones (report_observation) y el revisor decide qué pasa a la memoria.
import { db, logActivity, now } from "../db.js";
import { getActiveMission, getLastMission, getMission, missionMeasurement, revertedEntries, type Mission } from "./mission.js";
import { isFastMission } from "./mission-kind.js";
import { listPositions } from "./positions.js";
import { DUPLICATE_THRESHOLD, fingerprint, similarity } from "./text.js";
import { launchpadOf } from "./launchpads.js";
import { wilson } from "./stats.js";
import { classStats, missionComparison, twinCounts } from "./class-stats.js";
import { shadowSummary } from "./shadow.js";
import { agentEntrySummary } from "./candles.js";

// ─── Parecido entre misiones ────────────────────────────────────────────────

interface Profile {
  durationMinutes: number;
  targetPct: number;
  directed: boolean;
}

function profile(m: Pick<Mission, "created_at" | "deadline" | "initial_usd" | "target_usd" | "instructions">): Profile {
  return {
    durationMinutes: Math.max(1, Math.round((new Date(m.deadline).getTime() - new Date(m.created_at).getTime()) / 60_000)),
    targetPct: Number((((m.target_usd - m.initial_usd) / m.initial_usd) * 100).toFixed(1)),
    directed: !!m.instructions,
  };
}

/** Distancia entre perfiles: plazo en escala logarítmica, objetivo en tramos de 10 puntos, enfoque libre/dirigido. */
function distance(a: Profile, b: Profile) {
  return Math.abs(Math.log(a.durationMinutes / b.durationMinutes)) + Math.abs(a.targetPct - b.targetPct) / 10 + (a.directed === b.directed ? 0 : 0.5);
}

const similarityLabel = (d: number) => (d <= 0.6 ? "muy parecida" : d <= 1.5 ? "parecida" : "distinta");

const describe = (p: Profile) => `${p.durationMinutes} min, objetivo +${p.targetPct} %, ${p.directed ? "con instrucciones" : "modo libre"}`;

// ─── Condiciones de las creencias ───────────────────────────────────────────

type Pos = ReturnType<typeof listPositions>[number];

/** Datos de cada posición sobre los que puede definirse una condición. */
export const CONDITION_FIELDS = [
  "venue",
  "ageMinutes",
  "pairAgeMinutes",
  "liquidityUsd",
  "mcapUsd",
  "priceChange5mPct",
  "priceChange1hPct",
  "pairPriceChange5mPct",
  "pairPriceChange1hPct",
  "volume1hJupiterVsDexRatio",
  "priceChange24hPct",
  "buyVolume5mUsd",
  "sellVolume5mUsd",
  "buySellRatio5m",
  "holders",
  "topHoldersPct",
  "netBuyers5m",
  "organicScore",
  "launchpad",
  "rugcheckDangerRisks",
  "rugcheckWarnRisks",
  "buyTaxPct",
  "sellTaxPct",
  "honeypot",
  "mintable",
  "creatorTokens",
  "creatorGraduated",
  "creatorGraduationPct",
  "devHoldingPct",
  "creatorHoneypots",
  "insidersDetected",
  "lpLockedPct",
  // Lo que lleva operado de tokens del mismo creador (antes, una lista negra fija; ahora, un dato que puede aprender).
  "creatorTradesWithYou",
  "creatorWorstPnlWithYouPct",
  "tokenReportBeforeBuying",
  "researchCallsSinceLastTrade",
  "minutesIntoMission",
  // Cómo decide el agente (no cómo es el token): tamaño, reentrada, promediar y tiempo que queda.
  "portfolioPct",
  "previousTradesInToken",
  "lastPnlInTokenPct",
  "addedWhileDown",
  "minutesLeft",
  // Cuándo y con qué mercado decidió: hora UTC y actividad del último escaneo (tokens de menos de 3 h y
  // mediana de operadores en 5 min).
  "hourUtc",
  "marketYoungTokens",
  "marketMedianTraders5m",
  // Reentrada (cuánto hace y si es en esta misión) y evolución de las lecturas antes de comprar.
  "minutesSinceLastTradeInToken",
  "previousTradesInTokenThisMission",
  "readsBeforeBuy",
  "minutesBetweenReads",
  "liquidityTrendPct",
  "netBuyersTrend",
  "fillVsPricePct",
] as const;
export const CONDITION_OPS = ["<", "<=", ">", ">=", "=", "!="] as const;

export interface Clause {
  f: (typeof CONDITION_FIELDS)[number];
  op: (typeof CONDITION_OPS)[number];
  v: number | string | boolean;
}
export interface Condition {
  all: Clause[];
}

const RESEARCH_FIELDS = new Set([
  "tokenReportBeforeBuying",
  "researchCallsSinceLastTrade",
  "minutesIntoMission",
  "portfolioPct",
  "previousTradesInToken",
  "lastPnlInTokenPct",
  "addedWhileDown",
  "minutesLeft",
  "hourUtc",
  "marketYoungTokens",
  "marketMedianTraders5m",
  "minutesSinceLastTradeInToken",
  "previousTradesInTokenThisMission",
  "readsBeforeBuy",
  "minutesBetweenReads",
  "liquidityTrendPct",
  "netBuyersTrend",
  "fillVsPricePct",
]);

function fieldValue(p: Pos, f: Clause["f"]): unknown {
  if (f === "venue") return p.entry.venue ?? p.venue;
  // En BNB Chain el launchpad se deduce de la dirección (también en posiciones antiguas, que guardaban el DEX).
  if (f === "launchpad") return launchpadOf(String(p.entry.venue ?? p.venue), String(p.asset ?? ""), p.entry.launchpad as string | undefined);
  return RESEARCH_FIELDS.has(f) ? p.research[f] : p.entry[f];
}

/** Si una posición cumple la condición. Un dato desconocido no la cumple. */
export function matches(cond: Condition, p: Pos): boolean {
  return cond.all.every(({ f, op, v }) => {
    const x = fieldValue(p, f);
    if (x === undefined || x === null) return false;
    switch (op) {
      case "=":
        return x === v;
      case "!=":
        return x !== v;
      default:
        if (typeof x !== "number" || typeof v !== "number") return false;
        return op === "<" ? x < v : op === "<=" ? x <= v : op === ">" ? x > v : x >= v;
    }
  });
}

const describeCondition = (c: Condition) => c.all.map(({ f, op, v }) => `${f} ${op} ${JSON.stringify(v)}`).join(" y ");

// ─── Evidencia (calculada con las posiciones cerradas) ──────────────────────

/** Una operación cuenta como ganada o perdida si se movió al menos un 1 %. */
const outcome = (p: Pos) => ((p.pnlPct ?? 0) >= 1 ? "win" : (p.pnlPct ?? 0) <= -1 ? "loss" : "flat");

function summarizeTrades(ps: Pos[]) {
  if (!ps.length) return { trades: 0 };
  const avg = ps.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / ps.length;
  return {
    trades: ps.length,
    wins: ps.filter((p) => outcome(p) === "win").length,
    losses: ps.filter((p) => outcome(p) === "loss").length,
    avgPnlPct: Number(avg.toFixed(1)),
    // Además de ganar o perder: cuánto. Una misión con objetivo alto necesita movimientos grandes.
    bestPct: Number(Math.max(...ps.map((p) => p.pnlPct ?? 0)).toFixed(1)),
    worstPct: Number(Math.min(...ps.map((p) => p.pnlPct ?? 0)).toFixed(1)),
    bigWins: ps.filter((p) => (p.pnlPct ?? 0) >= BIG_WIN_PCT).length,
    positionIds: ps.map((p) => p.id),
  };
}

/** A partir de qué subida una operación cuenta como "grande" en la evidencia. */
const BIG_WIN_PCT = 20;

/** Cuánto se movieron las operaciones: media, mejor y cuántas dieron un movimiento grande. */
const magnitude = (t: { trades: number; avgPnlPct?: number; bestPct?: number; bigWins?: number }) =>
  t.trades ? `; media ${t.avgPnlPct} %, mejor ${t.bestPct} %, ${t.bigWins} de ${t.trades} con +${BIG_WIN_PCT} % o más` : "";

interface BeliefRow {
  id: number;
  created_at: string;
  updated_at: string;
  source_mission_id: number | null;
  statement: string;
  applies_to: string;
  expectation: "positive" | "negative" | null;
  condition: string | null;
  fingerprint: string;
  status: string;
  status_reason: string | null;
  origin: string;
  legacy_evidence: string | null;
}

// Intervalo de Wilson al 95 % (stats.ts): lo comparten las creencias y el seguimiento por clase de misión.
export { wilson };

/** Etapa de una creencia según cuántas operaciones decisivas la respaldan o la refutan. */
export type BeliefStage = "hypothesis" | "provisional" | "rule";
export const beliefStage = (decided: number): BeliefStage => (decided >= 30 ? "rule" : decided >= 10 ? "provisional" : "hypothesis");
const STAGE_LABEL: Record<BeliefStage, string> = {
  hypothesis: "hipótesis (menos de 10 casos: puede ser suerte)",
  provisional: "provisional (10-29 casos)",
  rule: "regla (30 casos o más)",
};

function beliefEvidence(b: BeliefRow, closed: Pos[]) {
  const applied = summarizeTrades(closed.filter((p) => p.beliefsApplied.includes(b.id)));
  const cond = b.condition ? (JSON.parse(b.condition) as Condition) : null;
  let matched: Record<string, unknown> | undefined;
  let verdict = applied.trades
    ? `sin condición; aplicada en ${applied.trades} operaciones: ${applied.wins} ganadas, ${applied.losses} perdidas${magnitude(applied)}`
    : "sin condición y todavía sin operaciones que la apliquen";
  if (cond) {
    const ps = closed.filter((p) => matches(cond, p));
    const wins = ps.filter((p) => outcome(p) === "win").length;
    const losses = ps.filter((p) => outcome(p) === "loss").length;
    const [inFavor, against] = b.expectation === "negative" ? [losses, wins] : [wins, losses];
    const decided = inFavor + against;
    const support = decided ? Math.round((inFavor / decided) * 100) : null;
    const ci = wilson(inFavor, decided);
    const stage = beliefStage(decided);
    const summary = summarizeTrades(ps);
    matched = { ...summary, inFavor, against, supportPct: support, wilsonLowPct: ci.low, wilsonHighPct: ci.high, stage };
    const counts = `${inFavor} a favor, ${against} en contra; acierto ${support} %, intervalo ${ci.low}-${ci.high} %`;
    verdict =
      decided < 3
        ? `sin evidencia suficiente (${decided} operaciones decisivas; hacen falta al menos 3)`
        : ci.low >= 50
          ? `se sostiene (${counts})`
          : ci.high < 50
            ? `los datos la contradicen (${counts})`
            : `sin confirmar (${counts})`;
    if (decided >= 3) verdict += ` · ${STAGE_LABEL[stage]}`;
    verdict += magnitude(summary);
  }
  return { verdict, appliedIn: applied, ...(matched ? { matchingTrades: matched } : {}) };
}

function beliefView(b: BeliefRow, closed: Pos[]) {
  const cond = b.condition ? (JSON.parse(b.condition) as Condition) : null;
  return {
    id: b.id,
    statement: b.statement,
    appliesTo: b.applies_to,
    ...(cond ? { condition: describeCondition(cond), expectation: b.expectation === "negative" ? "tiende a perder" : "tiende a ganar" } : {}),
    evidence: beliefEvidence(b, closed),
    ...(b.legacy_evidence ? { evidenceWrittenByTrader: b.legacy_evidence } : {}),
    sourceMission: b.source_mission_id,
    status: b.status,
    ...(b.status_reason ? { statusReason: b.status_reason } : {}),
  };
}

// ─── Lectura: lo que recuerda el agente ─────────────────────────────────────

function finishedMissions() {
  return db.prepare("SELECT * FROM missions WHERE status IN ('succeeded', 'expired', 'bust', 'cancelled') ORDER BY id").all() as unknown as Mission[];
}

/** Resultados de las operaciones cerradas, agrupados por características medidas al entrar. */
function tradeStats(ps: Pos[]) {
  const groups: Array<[string, (p: Pos) => boolean]> = [
    ["todas", () => true],
    ["token con < 30 min de vida al comprar", (p) => (p.entry.ageMinutes ?? Infinity) < 30],
    ["token con ≥ 30 min de vida al comprar", (p) => (p.entry.ageMinutes ?? -1) >= 30],
    ["liquidez < 50.000 $", (p) => (p.entry.liquidityUsd ?? Infinity) < 50_000],
    ["liquidez ≥ 50.000 $", (p) => (p.entry.liquidityUsd ?? -1) >= 50_000],
    ["comprado tras subir > 20 % en 5 min", (p) => (p.entry.priceChange5mPct ?? -Infinity) > 20],
    ["comprado sin haber subido > 20 % en 5 min", (p) => (p.entry.priceChange5mPct ?? Infinity) <= 20],
    ["con token_report antes de comprar", (p) => p.research.tokenReportBeforeBuying === true],
    ["sin token_report antes de comprar", (p) => p.research.tokenReportBeforeBuying === false],
    ["con riesgos 'danger' en RugCheck", (p) => (p.entry.rugcheckDangerRisks ?? 0) > 0],
    ["cerradas por fin de misión", (p) => String(p.exitReason ?? "").startsWith("Cierre automático")],
  ];
  return groups
    .map(([label, fn]) => {
      const s = summarizeTrades(ps.filter(fn));
      return s.trades ? { group: label, trades: s.trades, wins: s.wins, losses: s.losses, avgPnlPct: s.avgPnlPct } : null;
    })
    .filter(Boolean);
}

const closedPositions = () => listPositions().filter((p) => p.status === "closed");

// ─── Mapa de lo explorado ───────────────────────────────────────────────────
// Cuántas operaciones lleva en cada zona (cadena, edad y liquidez del token; futuros por moneda) y cómo le fue.
// Solo datos: las zonas vacías son las que nunca ha probado, y las de 1-2 operaciones no demuestran nada todavía.

const AGE_BUCKETS: Array<[string, number]> = [["<1 h", 60], ["1-3 h", 180], ["3-24 h", 1440], ["1-7 d", 10080], [">7 d", Infinity]];
const LIQ_BUCKETS: Array<[string, number]> = [["<15k", 15_000], ["15-50k", 50_000], ["50-200k", 200_000], ["200k-1M", 1_000_000], [">1M", Infinity]];
const bucket = (v: unknown, buckets: Array<[string, number]>) => (typeof v === "number" ? buckets.find(([, max]) => v < max)![0] : "sin dato");

export function explorationMap() {
  const closed = closedPositions();
  const cell = (ps: Pos[]) => {
    const s = summarizeTrades(ps);
    return s.trades ? { trades: s.trades, wins: s.wins, losses: s.losses, avgPnlPct: s.avgPnlPct } : { trades: 0 };
  };
  const byVenue: Record<string, ReturnType<typeof cell>> = {};
  for (const venue of new Set(closed.map((p) => p.venue))) byVenue[venue] = cell(closed.filter((p) => p.venue === venue));
  // Contado: edad × liquidez del token al entrar, con todas las casillas (también las vacías).
  const spot = closed.filter((p) => p.venue !== "hyperliquid");
  const spotByAgeAndLiquidity = AGE_BUCKETS.map(([age]) => ({
    age,
    ...Object.fromEntries(
      LIQ_BUCKETS.map(([liq]) => {
        const ps = spot.filter((p) => bucket(p.entry.ageMinutes, AGE_BUCKETS) === age && bucket(p.entry.liquidityUsd, LIQ_BUCKETS) === liq);
        const c = cell(ps);
        return [liq, c.trades ? `${c.trades} op: ${c.wins}G/${c.losses}P, media ${c.avgPnlPct} %` : "sin probar"];
      }),
    ),
  }));
  const perps = closed.filter((p) => p.venue === "hyperliquid");
  const perpsByCoin: Record<string, ReturnType<typeof cell>> = {};
  for (const coin of new Set(perps.map((p) => p.symbol.split("-")[0]!))) perpsByCoin[coin] = cell(perps.filter((p) => p.symbol.startsWith(`${coin}-`)));
  return {
    closedTrades: closed.length,
    byVenue,
    spotByAgeAndLiquidity,
    ...(perps.length ? { perpsByCoin } : {}),
    note: "Operaciones cerradas por zona. \"sin probar\" = ninguna operación ahí; con 1-2 operaciones una zona no está probada.",
  };
}

// ─── Freno de memoria: lo aprendido que no se puede pasar por alto ──────────

/**
 * Una creencia negativa con evidencia fuerte bloquea las compras que la cumplen, salvo que el agente
 * la ignore de forma explícita y diga por qué. Así lo aprendido no se olvida por despiste, pero el
 * agente sigue siendo libre de explorar (y esas compras siguen contando como evidencia).
 */
/** Fuerte: al menos 4 casos decisivos, el límite inferior del intervalo de Wilson ≥ 50 % y una media ≤ -15 %. */
export const STRONG_NEGATIVE = { minDecided: 4, minWilsonLowPct: 50, maxAvgPnlPct: -15 };

export interface BlockingBelief {
  id: number;
  statement: string;
  verdict: string;
}

/**
 * Lista negra de creadores: tokens del mismo creador que ya le costaron al agente un 80 % o más (rug,
 * honeypot…). Los "sindicatos" de rugs lanzan decenas de tokens: el historial del creador es el mejor filtro.
 */
export function creatorRugs(creator: string | undefined): Array<{ symbol: string; missionId: number | null; pnlPct: number }> {
  if (!creator) return [];
  return db
    .prepare(
      `SELECT symbol, mission_id, (realized_proceeds_usd - realized_cost_usd) * 100.0 / realized_cost_usd AS pnl FROM positions
       WHERE status = 'closed' AND realized_cost_usd > 0 AND lower(json_extract(entry_features, '$.creator')) = lower(?)
         AND (realized_proceeds_usd - realized_cost_usd) / realized_cost_usd <= -0.8`,
    )
    .all(creator)
    .map((r: any) => ({ symbol: r.symbol, missionId: r.mission_id, pnlPct: Math.round(r.pnl) }));
}

/** Creencias negativas fuertes que cumple una compra con estos datos de entrada. */
export function blockingBeliefs(venue: string, entry: Record<string, unknown>, asset = "", decision: Record<string, unknown> = {}): BlockingBelief[] {
  const closed = closedPositions();
  const pos = { venue, asset, entry: { ...entry, venue }, research: decision } as unknown as Pos;
  return (db.prepare("SELECT * FROM beliefs WHERE status = 'active' AND expectation = 'negative' AND condition IS NOT NULL").all() as unknown as BeliefRow[])
    .filter((b) => matches(JSON.parse(b.condition!) as Condition, pos))
    .map((b) => ({ b, ev: beliefEvidence(b, closed) }))
    .filter(({ ev }) => {
      const t = ev.matchingTrades as { inFavor?: number; against?: number; wilsonLowPct?: number; avgPnlPct?: number } | undefined;
      return (
        t !== undefined &&
        (t.inFavor ?? 0) + (t.against ?? 0) >= STRONG_NEGATIVE.minDecided &&
        (t.wilsonLowPct ?? 0) >= STRONG_NEGATIVE.minWilsonLowPct &&
        (t.avgPnlPct ?? 0) <= STRONG_NEGATIVE.maxAvgPnlPct
      );
    })
    .map(({ b, ev }) => ({ id: b.id, statement: b.statement, verdict: ev.verdict }));
}

/**
 * Qué dice la memoria de un token antes de comprarlo: creencias negativas fuertes que frenarían la compra
 * (block), otras negativas cuya condición cumple (caution) y positivas que cumple (favor). Solo ids: el
 * texto lo tiene el agente en su resumen de memoria.
 */
export function beliefsFor(venue: string, entry: Record<string, unknown>, asset = "", decision: Record<string, unknown> = {}) {
  const pos = { venue, asset, entry: { ...entry, venue }, research: decision } as unknown as Pos;
  const block = new Set(blockingBeliefs(venue, entry, asset, decision).map((b) => b.id));
  const rows = (db.prepare("SELECT * FROM beliefs WHERE status = 'active' AND condition IS NOT NULL").all() as unknown as BeliefRow[]).filter((b) =>
    matches(JSON.parse(b.condition!) as Condition, pos),
  );
  // Con cuántos casos cuenta cada una: una creencia de 1-2 operaciones no descarta nada todavía, y sin verlo
  // al lado del id, el trader las usaba todas como filtros duros y dejó de explorar (M11-M17 de la v0.35).
  const closed = rows.length ? closedPositions() : [];
  const cases: Record<number, { inFavor: number; against: number; stage: BeliefStage }> = {};
  for (const b of rows) {
    const t = beliefEvidence(b, closed).matchingTrades as { inFavor?: number; against?: number; stage?: BeliefStage } | undefined;
    cases[b.id] = { inFavor: t?.inFavor ?? 0, against: t?.against ?? 0, stage: t?.stage ?? "hypothesis" };
  }
  return {
    block: [...block],
    caution: rows.filter((b) => b.expectation === "negative" && !block.has(b.id)).map((b) => b.id),
    favor: rows.filter((b) => b.expectation === "positive").map((b) => b.id),
    cases,
  };
}

/**
 * La memoria completa, ordenada por relevancia para la misión actual (o la última).
 * `limit` recorta las listas largas (para el resumen de inicio de sesión).
 */
export function recall(missionId?: number | null, limit?: number) {
  const current = (missionId ? getMission(missionId) : undefined) ?? getActiveMission() ?? getLastMission();
  const curProfile = current ? profile(current) : null;
  const reviews = new Map(
    (db.prepare("SELECT mission_id, next_time, origin FROM mission_reviews").all() as Array<{ mission_id: number; next_time: string; origin: string }>).map((r) => [
      r.mission_id,
      r,
    ]),
  );

  const history = finishedMissions()
    .map((m) => {
      const p = profile(m);
      const d = curProfile ? distance(curProfile, p) : 0;
      const review = reviews.get(m.id);
      return {
        missionId: m.id,
        profile: describe(p),
        similarity: curProfile ? similarityLabel(d) : undefined,
        distance: Number(d.toFixed(2)),
        instructions: m.instructions ?? undefined,
        result:
          m.status === "cancelled"
            ? m.end_reason === "prep_timeout"
              ? `cancelada: el reloj no llegó a arrancar${revertedEntries(m.id).length ? " (sus compras revirtieron)" : ""}`
              : "cancelada por el usuario"
            : `${m.status === "succeeded" ? "objetivo conseguido" : "no llegó al objetivo"}: ${m.initial_usd} → ${m.final_usd?.toFixed(2)} USD (${(
                ((m.final_usd! - m.initial_usd) / m.initial_usd) *
                100
              ).toFixed(1)} %)`,
        ...(review && review.origin !== "legacy" ? { nextTime: review.next_time } : {}),
      };
    })
    .sort((a, b) => a.distance - b.distance);

  const closed = closedPositions();
  const distByMission = new Map(history.map((h) => [h.missionId, h.distance]));
  const beliefs = (db.prepare("SELECT * FROM beliefs WHERE status = 'active' ORDER BY id").all() as unknown as BeliefRow[])
    .map((b) => {
      const view = beliefView(b, closed);
      const n = (view.evidence.matchingTrades?.trades as number | undefined) ?? view.evidence.appliedIn.trades;
      // Más relevante: de misiones parecidas y con más operaciones que la respalden o la refuten.
      const score = (b.source_mission_id && distByMission.has(b.source_mission_id) ? distByMission.get(b.source_mission_id)! : 3) - Math.min(n, 10) * 0.1;
      return { ...view, relevance: b.source_mission_id && distByMission.has(b.source_mission_id) ? similarityLabel(distByMission.get(b.source_mission_id)!) : "general", _s: score };
    })
    .sort((a, b) => a._s - b._s)
    .map(({ _s, ...rest }) => rest);

  const howtos = db
    .prepare("SELECT id, scope, topic, title, steps, updated_at FROM howtos WHERE status = 'active' ORDER BY scope, topic, id")
    .all() as Array<Record<string, unknown>>;

  const similarIds = new Set(history.filter((h) => h.distance <= 1.5).map((h) => h.missionId));
  const cut = <T>(xs: T[]) => (limit ? xs.slice(0, limit) : xs);
  // Con límite, tantas creencias negativas como positivas: si solo ve las que le animan a entrar, las elige a su favor.
  const balanced = (xs: typeof beliefs) => {
    if (!limit) return xs;
    const neg = xs.filter((b) => b.expectation === "tiende a perder");
    const rest = xs.filter((b) => b.expectation !== "tiende a perder");
    const out: typeof beliefs = [];
    for (let i = 0; out.length < limit && (i < neg.length || i < rest.length); i++) {
      if (i < rest.length) out.push(rest[i]!);
      if (i < neg.length && out.length < limit) out.push(neg[i]!);
    }
    return out;
  };
  return {
    currentMission: current && curProfile ? { missionId: current.id, profile: describe(curProfile) } : null,
    missionHistory: cut(history),
    howtos,
    beliefs: balanced(beliefs),
    totalBeliefs: beliefs.length,
    tradeStats: {
      note: "Resultados reales de las operaciones cerradas, calculados por el simulador. Ganada/perdida = se movió al menos un 1 %.",
      allMissions: tradeStats(closed),
      similarMissions: similarIds.size ? tradeStats(closed.filter((p) => p.missionId !== null && similarIds.has(p.missionId))) : [],
    },
    recurringErrors: recurringErrors(),
    apis: db.prepare("SELECT host, path, ok, fail, last_status, last_ok_at, last_fail_at FROM api_observations ORDER BY COALESCE(last_ok_at, last_fail_at) DESC LIMIT 25").all(),
  };
}

const clip = (text: unknown, n: number) => {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, n).replace(/\s\S*$/, "")}…` : s;
};

/**
 * La memoria resumida: lo más relevante primero y los textos largos recortados. Crece con cada misión,
 * y el agente la consulta a menudo: el detalle completo está en recall con detail "completo".
 */
export function recallSummary(missionId?: number | null) {
  const full = recall(missionId, 8);
  return {
    currentMission: full.currentMission,
    missionHistory: full.missionHistory.slice(0, 5).map(({ distance: _d, ...h }) => ({ ...h, ...(h.nextTime ? { nextTime: clip(h.nextTime, 220) } : {}) })),
    // Los howtos, solo por título: el texto de los que necesites, con howto_ids.
    howtos: full.howtos.map((h) => `#${h.id} [${h.scope}/${h.topic}] ${h.title}`),
    beliefs: full.beliefs.slice(0, 8).map((b) => ({
      id: b.id,
      statement: clip(b.statement, 200),
      ...(b.condition ? { condition: b.condition, expectation: b.expectation } : {}),
      evidence: b.evidence.verdict,
    })),
    totalBeliefs: full.totalBeliefs,
    tradeStats: full.tradeStats.allMissions,
    recurringErrors: (full.recurringErrors as Array<Record<string, unknown>>).slice(0, 5).map((e) => ({ ...e, errorClass: clip(e.errorClass, 140) })),
    note:
      "Resumen: howtos por título y las 8 creencias más relevantes. recall_memory con howto_ids trae el texto de esos howtos; " +
      "con detail: completo, todo (es largo: úsalo solo si lo necesitas).",
  };
}

/** El texto completo de unos howtos concretos. */
export function howtosById(ids: number[]) {
  if (!ids.length) return [];
  return db.prepare(`SELECT id, scope, topic, title, steps, status FROM howtos WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).all(...ids);
}

/**
 * Para el revisor: el catálogo compacto (ids, títulos, creencias recortadas con su evidencia). El
 * detalle de lo que vaya a tocar, con howto_ids y belief_ids.
 */
export function memoryCatalog(missionId: number | null, opts: { howtoIds?: number[]; beliefIds?: number[]; full?: boolean } = {}) {
  const all = recall(missionId);
  if (opts.full) return all;
  const pick = new Set(opts.beliefIds ?? []);
  return {
    currentMission: all.currentMission,
    howtos: all.howtos.map((h) => `#${h.id} [${h.scope}/${h.topic}] ${h.title}`),
    beliefs: all.beliefs.map((b) =>
      pick.has(b.id)
        ? b
        : { id: b.id, statement: clip(b.statement, 160), ...(b.condition ? { expectation: b.expectation } : {}), evidence: b.evidence.verdict },
    ),
    ...(opts.howtoIds?.length ? { howtoDetail: howtosById(opts.howtoIds) } : {}),
    missionHistory: all.missionHistory.slice(0, 8).map(({ distance: _d, ...h }) => ({ ...h, ...(h.nextTime ? { nextTime: clip(h.nextTime, 220) } : {}) })),
    tradeStats: all.tradeStats.allMissions,
    note: "Catálogo compacto. Con howto_ids o belief_ids, el detalle de esos; con full: true, todo.",
  };
}

/** Errores de herramientas agrupados por tipo (últimos 30 días), con el howto que los resuelve si lo hay. */
export function recurringErrors() {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT error_class AS errorClass, tool, COUNT(*) AS count, MAX(ts) AS lastAt, MAX(id) AS exampleId, MAX(howto_id) AS howtoId
       FROM tool_errors WHERE ts >= ? GROUP BY error_class, tool ORDER BY count DESC, lastAt DESC LIMIT 20`,
    )
    .all(since);
}

// ─── Escritura (revisor) ────────────────────────────────────────────────────

function duplicateOf(table: "howtos" | "beliefs", fp: string, exceptId?: number) {
  const rows = db
    .prepare(`SELECT id, fingerprint FROM ${table} WHERE status = 'active' AND id IS NOT ?`)
    .all(exceptId ?? null) as Array<{ id: number; fingerprint: string }>;
  return rows.find((r) => similarity(r.fingerprint, fp) >= DUPLICATE_THRESHOLD)?.id;
}

/**
 * Cada cambio en la memoria queda en la actividad de la misión de la que sale (o de la activa o la última),
 * para que el panel lo muestre: con la memoria ya formada, el revisor sobre todo corrige y amplía lo que hay.
 */
function logLearning(_sourceMission: number | null | undefined, title: string, body?: string) {
  // Va a la misión que se está viendo (la activa o la última), no a la de origen: el revisor escribe al
  // terminar una misión y el panel pasa enseguida a la siguiente.
  const target = (getActiveMission() ?? getLastMission())?.id ?? null;
  logActivity({ missionId: target, sessionId: null, kind: "lesson", title, body });
}

/** Lo último que ha cambiado en la memoria, de cualquier misión (para el panel). */
export function recentLearning(limit = 5) {
  return db.prepare("SELECT ts, title FROM activity WHERE kind = 'lesson' ORDER BY id DESC LIMIT ?").all(limit) as Array<{ ts: string; title: string }>;
}

// ─── Límites e higiene de la memoria ────────────────────────────────────────
// La memoria se lee en cada misión: si crece sin podarse, cuesta más y se lee peor. Por encima de estos
// límites no se escribe nada nuevo hasta fusionar o retirar algo.
export const HOWTO_LIMIT = 18;
export const BELIEF_LIMIT = 18;

const activeCount = (table: "howtos" | "beliefs") => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'active'`).get() as { n: number }).n;

/** Parecido entre dos conjuntos de posiciones (Jaccard). */
const overlap = (a: number[], b: number[]) => {
  const sa = new Set(a);
  const inter = b.filter((x) => sa.has(x)).length;
  return inter / (sa.size + b.length - inter || 1);
};

/**
 * Otra creencia activa, con la misma expectativa, que cubre (casi) las mismas operaciones: aunque la
 * condición o el texto sean distintos, dice lo mismo según los datos.
 */
function evidenceTwin(cond: Condition, expectation: string, closed: Pos[], exceptId?: number): number | undefined {
  const mine = closed.filter((p) => matches(cond, p)).map((p) => p.id);
  if (mine.length < 3) return undefined;
  const others = db
    .prepare("SELECT id, condition FROM beliefs WHERE status = 'active' AND condition IS NOT NULL AND expectation = ? AND id IS NOT ?")
    .all(expectation, exceptId ?? null) as Array<{ id: number; condition: string }>;
  return others.find((o) => overlap(mine, closed.filter((p) => matches(JSON.parse(o.condition) as Condition, p)).map((p) => p.id)) >= 0.8)?.id;
}

/** Lo que el revisor debería consolidar: duplicados por evidencia, creencias contradichas y exceso de howtos. */
export function memoryHygiene() {
  const closed = closedPositions();
  const beliefs = db.prepare("SELECT * FROM beliefs WHERE status = 'active' ORDER BY id").all() as unknown as BeliefRow[];
  const withEv = beliefs.map((b) => ({ b, ev: beliefEvidence(b, closed) }));
  const duplicates: Array<{ ids: number[]; sharedTrades: number }> = [];
  for (let i = 0; i < withEv.length; i++) {
    for (let j = i + 1; j < withEv.length; j++) {
      const [x, y] = [withEv[i]!, withEv[j]!];
      if (!x.b.condition || !y.b.condition || x.b.expectation !== y.b.expectation) continue;
      const px = (x.ev.matchingTrades?.positionIds as number[] | undefined) ?? [];
      const py = (y.ev.matchingTrades?.positionIds as number[] | undefined) ?? [];
      if (px.length >= 3 && py.length >= 3 && overlap(px, py) >= 0.8) duplicates.push({ ids: [x.b.id, y.b.id], sharedTrades: px.filter((p) => py.includes(p)).length });
    }
  }
  const contradicted = withEv
    .filter(({ ev }) => {
      // Contradicha: incluso el límite superior del intervalo queda por debajo del 50 %.
      const t = ev.matchingTrades as { inFavor?: number; against?: number; wilsonHighPct?: number } | undefined;
      return t && (t.inFavor ?? 0) + (t.against ?? 0) >= 3 && (t.wilsonHighPct ?? 100) < 50;
    })
    .map(({ b, ev }) => ({ id: b.id, statement: clip(b.statement, 120), verdict: ev.verdict }));
  const howtos = db.prepare("SELECT id, scope, topic, title, LENGTH(steps) AS chars FROM howtos WHERE status = 'active' ORDER BY scope, topic, id").all() as Array<{
    id: number;
    scope: string;
    topic: string;
    title: string;
    chars: number;
  }>;
  const fps = new Map(howtos.map((h) => [h.id, fingerprint(`${h.title} ${h.topic}`)]));
  const similarHowtos: number[][] = [];
  for (let i = 0; i < howtos.length; i++) {
    for (let j = i + 1; j < howtos.length; j++) {
      if (similarity(fps.get(howtos[i]!.id)!, fps.get(howtos[j]!.id)!) >= 0.3) similarHowtos.push([howtos[i]!.id, howtos[j]!.id]);
    }
  }
  const tooMany = howtos.length > HOWTO_LIMIT || beliefs.length > BELIEF_LIMIT;
  return {
    counts: { howtos: howtos.length, howtoLimit: HOWTO_LIMIT, beliefs: beliefs.length, beliefLimit: BELIEF_LIMIT },
    ...(tooMany ? { mustConsolidate: "Hay más memoria de la que admite el límite: fusiona o retira antes de escribir nada nuevo (write_howto y write_belief lo rechazarán)." } : {}),
    duplicateBeliefs: duplicates,
    contradictedBeliefs: contradicted,
    similarHowtos,
    howtoIndex: howtos.map((h) => `#${h.id} [${h.scope}/${h.topic}] ${h.title} (${h.chars} car.)`),
  };
}

export function writeHowto(a: { scope: string; topic: string; title: string; steps: string; missionId: number | null; fixesErrorIds?: number[] }) {
  if (activeCount("howtos") >= HOWTO_LIMIT) {
    throw new Error(`Ya hay ${HOWTO_LIMIT} howtos activos o más: amplía uno existente (update_howto) o fusiona y retira alguno antes de escribir otro.`);
  }
  const fp = fingerprint(`${a.title} ${a.steps}`);
  const dup = duplicateOf("howtos", fp);
  if (dup) throw new Error(`Ya hay un howto casi igual (#${dup}). Actualízalo con update_howto en lugar de crear otro.`);
  const id = Number(
    db
      .prepare(
        "INSERT INTO howtos (created_at, updated_at, scope, topic, title, steps, source_mission_id, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(now(), now(), a.scope, a.topic, a.title, a.steps, a.missionId, fp).lastInsertRowid,
  );
  if (a.fixesErrorIds?.length) linkErrors(id, a.fixesErrorIds);
  logLearning(a.missionId, `Nuevo howto #${id}: ${a.title}`, a.steps);
  return id;
}

/** Vincula un howto a los errores que resuelve (y a todos los del mismo tipo). */
function linkErrors(howtoId: number, errorIds: number[]) {
  const marks = errorIds.map(() => "?").join(",");
  db.prepare(`UPDATE tool_errors SET howto_id = ? WHERE error_class IN (SELECT error_class FROM tool_errors WHERE id IN (${marks}))`).run(howtoId, ...errorIds);
}

export function updateHowto(a: { id: number; title?: string; steps?: string; status?: "active" | "obsolete"; supersededBy?: number; fixesErrorIds?: number[] }) {
  const h = db.prepare("SELECT * FROM howtos WHERE id = ?").get(a.id) as { title: string; steps: string } | undefined;
  if (!h) throw new Error(`No existe el howto #${a.id}`);
  const title = a.title ?? h.title;
  const steps = a.steps ?? h.steps;
  db.prepare("UPDATE howtos SET title = ?, steps = ?, fingerprint = ?, status = COALESCE(?, status), superseded_by = COALESCE(?, superseded_by), updated_at = ? WHERE id = ?").run(
    title,
    steps,
    fingerprint(`${title} ${steps}`),
    a.status ?? null,
    a.supersededBy ?? null,
    now(),
    a.id,
  );
  if (a.fixesErrorIds?.length) linkErrors(a.id, a.fixesErrorIds);
  logLearning(null, a.status === "obsolete" ? `Da por obsoleto el howto #${a.id}: ${title}` : `Amplía el howto #${a.id}: ${title}`, a.steps);
}

function validateCondition(cond: Condition | undefined, expectation: string | undefined) {
  if (cond && !expectation) throw new Error("Una creencia con condición necesita expectation: positive (tiende a ganar) o negative (tiende a perder)");
}

const sameCondition = (cond: Condition | undefined) =>
  cond ? (db.prepare("SELECT id FROM beliefs WHERE status = 'active' AND condition = ?").get(JSON.stringify(cond)) as { id: number } | undefined)?.id : undefined;

export function writeBelief(a: { statement: string; appliesTo: string; expectation?: "positive" | "negative"; condition?: Condition; missionId: number | null }) {
  validateCondition(a.condition, a.expectation);
  if (activeCount("beliefs") >= BELIEF_LIMIT) {
    throw new Error(`Ya hay ${BELIEF_LIMIT} creencias activas o más: corrige una existente (revise_belief) o retira las duplicadas o contradichas antes de escribir otra.`);
  }
  const fp = fingerprint(a.statement);
  const dup = duplicateOf("beliefs", fp) ?? sameCondition(a.condition);
  if (dup) throw new Error(`Ya hay una creencia casi igual o con la misma condición (#${dup}). Corrígela con revise_belief en lugar de crear otra.`);
  const twin = a.condition && a.expectation ? evidenceTwin(a.condition, a.expectation, closedPositions()) : undefined;
  if (twin) throw new Error(`La creencia #${twin} ya cubre casi las mismas operaciones con la misma expectativa: dicen lo mismo según los datos. Corrígela con revise_belief en lugar de crear otra.`);
  const id = Number(
    db
      .prepare(
        `INSERT INTO beliefs (created_at, updated_at, source_mission_id, statement, applies_to, expectation, condition, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(now(), now(), a.missionId, a.statement, a.appliesTo, a.expectation ?? null, a.condition ? JSON.stringify(a.condition) : null, fp).lastInsertRowid,
  );
  const view = beliefView(getBelief(id), closedPositions());
  logLearning(a.missionId, `Nueva creencia #${id}: ${a.statement}`, view.evidence.verdict);
  return view;
}

function getBelief(id: number) {
  const b = db.prepare("SELECT * FROM beliefs WHERE id = ?").get(id) as unknown as BeliefRow | undefined;
  if (!b) throw new Error(`No existe la creencia #${id}`);
  return b;
}

export function reviseBelief(a: {
  id: number;
  statement?: string;
  appliesTo?: string;
  expectation?: "positive" | "negative";
  condition?: Condition;
  clearCondition?: boolean;
  retire?: boolean;
  reason: string;
}) {
  const b = getBelief(a.id);
  const statement = a.statement ?? b.statement;
  const condition = a.clearCondition ? null : a.condition ? JSON.stringify(a.condition) : b.condition;
  const expectation = a.expectation ?? b.expectation;
  validateCondition(condition ? (JSON.parse(condition) as Condition) : undefined, expectation ?? undefined);
  if (a.statement) {
    const dup = duplicateOf("beliefs", fingerprint(statement), a.id);
    if (dup) throw new Error(`Con ese texto sería casi igual que la creencia #${dup}. Si sobran, retira una de las dos.`);
  }
  db.prepare(
    `UPDATE beliefs SET statement = ?, applies_to = ?, expectation = ?, condition = ?, fingerprint = ?, status = ?, status_reason = ?, updated_at = ? WHERE id = ?`,
  ).run(statement, a.appliesTo ?? b.applies_to, expectation, condition, fingerprint(statement), a.retire ? "retired" : b.status, a.reason, now(), a.id);
  const view = beliefView(getBelief(a.id), closedPositions());
  logLearning(null, `${a.retire ? "Retira" : "Corrige"} la creencia #${a.id}: ${statement}`, `${a.reason} · ${view.evidence.verdict}`);
  return view;
}

export function convertBeliefToHowto(a: { id: number; scope: string; topic: string; title: string; steps: string }) {
  const b = getBelief(a.id);
  if (b.status !== "active") throw new Error(`La creencia #${a.id} ya no está activa (${b.status})`);
  const howtoId = writeHowto({ scope: a.scope, topic: a.topic, title: a.title, steps: a.steps, missionId: b.source_mission_id });
  db.prepare("UPDATE howtos SET from_belief_id = ? WHERE id = ?").run(a.id, howtoId);
  db.prepare("UPDATE beliefs SET status = 'converted', status_reason = ?, updated_at = ? WHERE id = ?").run(`convertida en el howto #${howtoId}`, now(), a.id);
  return howtoId;
}

// ─── Misiones: estadísticas, retrospectiva y cola del revisor ───────────────

export function missionStats(missionId: number) {
  const ps = listPositions(missionId);
  const closed = ps.filter((p) => p.status === "closed");
  const count = (sql: string) => (db.prepare(sql).get(missionId) as { n: number }).n;
  const m = getMission(missionId);
  return {
    result:
      m?.final_usd != null
        ? { initialUsd: m.initial_usd, finalUsd: Number(m.final_usd.toFixed(2)), pct: Number((((m.final_usd - m.initial_usd) / m.initial_usd) * 100).toFixed(2)), status: m.status }
        : { initialUsd: m?.initial_usd, status: m?.status },
    positions: ps.length,
    closed: summarizeTrades(closed),
    realizedPnlUsd: Number(closed.reduce((s, p) => s + (p.pnlUsd ?? 0), 0).toFixed(2)),
    stillOpen: ps.filter((p) => p.status === "open").length,
    rejectedOrFailed: count("SELECT COUNT(*) AS n FROM journal WHERE mission_id = ? AND kind IN ('rejected', 'failed_tx', 'order_failed')"),
    toolErrors: count("SELECT COUNT(*) AS n FROM tool_errors WHERE mission_id = ?"),
    researchCalls: count("SELECT COUNT(*) AS n FROM research_log WHERE mission_id = ?"),
    observations: count("SELECT COUNT(*) AS n FROM observations WHERE mission_id = ?"),
  };
}

/** Misiones terminadas sin retrospectiva (las canceladas, solo si llegaron a operar). */
export function pendingReviews() {
  return (
    db
      .prepare(
        `SELECT m.id FROM missions m
         WHERE (m.status IN ('succeeded', 'expired', 'bust') OR (m.status = 'cancelled' AND EXISTS (SELECT 1 FROM positions p WHERE p.mission_id = m.id)))
           AND m.reviewed_at IS NULL AND NOT EXISTS (SELECT 1 FROM mission_reviews r WHERE r.mission_id = m.id)
         ORDER BY m.id`,
      )
      .all() as Array<{ id: number }>
  ).map((r) => r.id);
}

export function writeMissionReview(a: { missionId: number; whatWasTried: string; whatHappened: string; surprises?: string; nextTime: string }) {
  const m = getMission(a.missionId);
  if (!m) throw new Error(`No existe la misión #${a.missionId}`);
  if (m.status === "active" || m.status === "closing") throw new Error(`La misión #${a.missionId} sigue activa: para revisarla a mitad usa review_checkpoint`);
  db.prepare(
    `INSERT INTO mission_reviews (mission_id, created_at, what_was_tried, what_happened, surprises, next_time) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(mission_id) DO UPDATE SET created_at = excluded.created_at, origin = 'reviewer', what_was_tried = excluded.what_was_tried,
       what_happened = excluded.what_happened, surprises = excluded.surprises, next_time = excluded.next_time`,
  ).run(a.missionId, now(), a.whatWasTried, a.whatHappened, a.surprises ?? null, a.nextTime);
  markReviewed(a.missionId);
  logActivity({ missionId: a.missionId, sessionId: null, kind: "review", title: `Retrospectiva de la misión #${a.missionId}`, body: a.nextTime });
  return missionStats(a.missionId);
}

/** Corrige campos de una retrospectiva ya escrita (solo los que se indiquen), con el motivo. */
export function reviseMissionReview(a: { missionId: number; whatWasTried?: string; whatHappened?: string; surprises?: string; nextTime?: string; reason: string }) {
  const r = db.prepare("SELECT * FROM mission_reviews WHERE mission_id = ?").get(a.missionId) as
    | { what_was_tried: string; what_happened: string; surprises: string | null; next_time: string }
    | undefined;
  if (!r) throw new Error(`La misión #${a.missionId} no tiene retrospectiva: escríbela con write_mission_review`);
  const changed = (["whatWasTried", "whatHappened", "surprises", "nextTime"] as const).filter((k) => a[k] !== undefined);
  if (!changed.length) throw new Error("Indica al menos un campo que corregir (what_was_tried, what_happened, surprises o next_time)");
  db.prepare("UPDATE mission_reviews SET what_was_tried = ?, what_happened = ?, surprises = ?, next_time = ? WHERE mission_id = ?").run(
    a.whatWasTried ?? r.what_was_tried,
    a.whatHappened ?? r.what_happened,
    a.surprises ?? r.surprises,
    a.nextTime ?? r.next_time,
    a.missionId,
  );
  logActivity({ missionId: a.missionId, sessionId: null, kind: "lesson", title: `Corrige la retrospectiva de la misión #${a.missionId}: ${a.reason}` });
  return { missionId: a.missionId, corrected: changed };
}

export function markReviewed(missionId: number) {
  db.prepare("UPDATE missions SET reviewed_at = COALESCE(reviewed_at, ?) WHERE id = ?").run(now(), missionId);
}

/** Da por revisada una misión sin operaciones (no hay nada que analizar). */
export function markEmptyMissionReviewed(missionId: number, note: string) {
  if (listPositions(missionId).length) throw new Error(`La misión #${missionId} tuvo operaciones: escribe su retrospectiva con write_mission_review`);
  markReviewed(missionId);
  logActivity({ missionId, sessionId: null, kind: "review", title: `Misión #${missionId} revisada sin operaciones`, body: note });
}

function lastCheckpoint(missionId: number) {
  return (db.prepare("SELECT MAX(ts) AS ts FROM review_checkpoints WHERE mission_id = ?").get(missionId) as { ts: string | null }).ts;
}

/** Cada cuánto conviene revisar una misión activa: unas seis veces en toda la misión, entre 20 min y 6 h. */
export function reviewIntervalMinutes(m: Pick<Mission, "created_at" | "deadline">) {
  const duration = (new Date(m.deadline).getTime() - new Date(m.created_at).getTime()) / 60_000;
  return Math.round(Math.min(360, Math.max(20, duration / 6)));
}

/** Actividad del agente desde una fecha: operaciones, rechazos, observaciones y errores. */
function activitySince(missionId: number, since: string) {
  const q = (sql: string) => (db.prepare(sql).get(missionId, since) as { n: number }).n;
  return {
    trades: q("SELECT COUNT(*) AS n FROM journal WHERE mission_id = ? AND ts > ? AND kind IN ('swap', 'cex_order', 'transfer', 'failed_tx', 'rejected', 'order_placed', 'order_failed')"),
    observations: q("SELECT COUNT(*) AS n FROM observations WHERE mission_id = ? AND ts > ?"),
    errors: q("SELECT COUNT(*) AS n FROM tool_errors WHERE mission_id = ? AND ts > ?"),
  };
}

export function reviewCheckpoint(missionId: number, summary: string) {
  db.prepare("INSERT INTO review_checkpoints (ts, mission_id, summary) VALUES (?, ?, ?)").run(now(), missionId, summary);
  logActivity({ missionId, sessionId: null, kind: "review", title: "El revisor repasa la misión", body: summary });
}

/**
 * Cómo ha jugado el trader en sus últimas misiones terminadas, para que el revisor vea si repite siempre
 * el mismo enfoque (y con qué resultado) y, si está estancado, proponga uno distinto de verdad.
 */
export function recentApproach(count = 8) {
  const missions = db
    .prepare("SELECT * FROM missions WHERE status IN ('succeeded', 'expired', 'bust', 'cancelled') AND final_usd IS NOT NULL ORDER BY id DESC LIMIT ?")
    .all(count) as unknown as Mission[];
  if (!missions.length) return null;
  const twins = twinCounts();
  const perMission = missions.reverse().map((m) => {
    const ps = listPositions(m.id).filter((p) => p.status !== "moved");
    const ages = ps.map((p) => p.entry.ageMinutes).filter((a): a is number => typeof a === "number").sort((a, b) => a - b);
    const orders = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE mission_id = ?").get(m.id) as { n: number }).n;
    // Minutos parado al final: desde la última operación hasta que acabó (sin haber llegado al objetivo). Los
    // futuros cuentan: en la M16 de la v0.35.6 un largo abierto a 7 min del final salía como "parado en efectivo".
    const lastTrade = (db.prepare("SELECT MAX(ts) AS ts FROM journal WHERE mission_id = ? AND kind IN ('swap', 'cex_order', 'transfer', 'perp') AND (reasoning IS NULL OR reasoning NOT LIKE 'Cierre %') AND (reasoning IS NULL OR reasoning NOT LIKE 'Parada %')").get(m.id) as { ts: string | null }).ts;
    const end = new Date(m.ended_at ?? m.deadline).getTime();
    const durationMin = (new Date(m.deadline).getTime() - new Date(m.started_at ?? m.created_at).getTime()) / 60_000;
    const idleAtEndMinutes = m.status === "succeeded" || !lastTrade ? 0 : Math.max(0, Math.round((end - new Date(lastTrade).getTime()) / 60_000));
    // Esperar con una posición abierta no es rendirse; esperar en efectivo, sí. La posición se anota unos
    // milisegundos después que el swap en el diario: si la última operación fue justo esa compra, cuenta (en la
    // M3 de la v0.35.3, THUMB abierta hasta el final salía como "aparcado en efectivo").
    const holding =
      !!lastTrade &&
      !!db
        .prepare("SELECT 1 FROM positions WHERE mission_id = ? AND status != 'moved' AND opened_at <= ? AND (closed_at IS NULL OR closed_at > ?) LIMIT 1")
        .get(m.id, new Date(new Date(lastTrade).getTime() + 10_000).toISOString(), lastTrade);
    return {
      missionId: m.id,
      // Minutos desde su última operación hasta el final, y si en ese tiempo tenía una posición abierta: esperar
      // con una posición no es quedarse parado (el revisor leía el antiguo "idleAtEndMinutes" como efectivo).
      minutesSinceLastTradeAtEnd: idleAtEndMinutes,
      holdingAtEnd: holding,
      parkedAtEnd: !holding && idleAtEndMinutes >= Math.max(3, durationMin * 0.25),
      succeeded: m.status === "succeeded",
      resultPct: Number((((m.final_usd! - m.initial_usd) / m.initial_usd) * 100).toFixed(1)),
      positions: ps.length,
      venues: [...new Set(ps.map((p) => p.venue))].join("+") || "ninguno",
      tokenAgeMinutes: ages.length ? ages[Math.floor(ages.length / 2)] : null,
      closedByDeadline: ps.filter((p) => String(p.exitReason ?? "").startsWith("Cierre automático")).length,
      orders,
      // Su clase y cómo quedó frente a lo que predijo el plan, a la línea base y a su gemelo mecánico.
      ...(m.class ? { missionClass: m.class } : {}),
      // Con costes realistas es otra serie (costs.ts): el resumen no la mezcla con las de costes de siempre.
      costs: m.cost_mode,
      ...(m.status !== "cancelled" && m.started_at ? comparedToTwin(m, twins) : {}),
    };
  });
  const n = perMission.length;
  const share = (f: (x: (typeof perMission)[number]) => boolean) => `${perMission.filter(f).length} de ${n}`;
  // Si hay misiones de los dos modos de costes, los aciertos y el resultado van también por separado: son series distintas.
  const modes = [...new Set(perMission.map((x) => x.costs))];
  const byCosts =
    modes.length > 1
      ? Object.fromEntries(
          modes.map((mode) => {
            const xs = perMission.filter((x) => x.costs === mode);
            return [
              mode,
              {
                missions: xs.length,
                succeeded: `${xs.filter((x) => x.succeeded).length} de ${xs.length}`,
                avgResultPct: Number((xs.reduce((s, x) => s + x.resultPct, 0) / xs.length).toFixed(1)),
              },
            ];
          }),
        )
      : undefined;
  // Éxitos seguidos al final de la serie: si el enfoque actual gana, no es estancamiento.
  let successStreak = 0;
  for (let i = n - 1; i >= 0 && perMission[i]!.succeeded; i--) successStreak++;
  return {
    summary: {
      missions: n,
      succeeded: share((x) => x.succeeded),
      successStreak,
      avgResultPct: Number((perMission.reduce((s, x) => s + x.resultPct, 0) / n).toFixed(1)),
      bestPct: Math.max(...perMission.map((x) => x.resultPct)),
      withOneEntry: share((x) => x.positions === 1),
      /** Misiones que acabaron paradas (sin operar el último cuarto del plazo) sin llegar: se rindió. */
      parkedAtEnd: share((x) => x.parkedAtEnd),
      endedByDeadline: share((x) => x.closedByDeadline > 0),
      withYoungTokens: share((x) => x.tokenAgeMinutes !== null && x.tokenAgeMinutes < 60),
      venuesUsed: [...new Set(perMission.map((x) => x.venues))].join(", "),
      ...(byCosts
        ? { byCosts, costsNote: "hay misiones con costes de siempre (sim) y realistas (real): sus aciertos y resultados no se comparan entre sí" }
        : {}),
    },
    perMission,
  };
}

/** La comparación de una misión con su predicción y su gemelo, sin lo que recentApproach ya dice (resultado y éxito). */
function comparedToTwin(m: Mission, twins: ReturnType<typeof twinCounts>) {
  const { hit: _hit, resultPct: _result, ...rest } = missionComparison(m, twins);
  return rest;
}

/** Lo que tiene pendiente el revisor. */
export function reviewQueue() {
  const active = getActiveMission();
  let activeMission: Record<string, unknown> | null = null;
  if (active) {
    const since = lastCheckpoint(active.id) ?? active.created_at;
    const briefing = db.prepare("SELECT updated_at, seen_at FROM briefings WHERE mission_id = ?").get(active.id) as
      | { updated_at: string; seen_at: string | null }
      | undefined;
    activeMission = {
      missionId: active.id,
      // rápida (simulada de 15 min o menos: planner y executor, sin briefing) o normal (el trader, con briefing).
      missionKind: isFastMission(active) ? "rápida" : "normal",
      costs: active.cost_mode,
      profile: describe(profile(active)),
      instructions: active.instructions ?? undefined,
      deadline: active.deadline,
      reviewIntervalMinutes: reviewIntervalMinutes(active),
      lastCheckpointAt: lastCheckpoint(active.id),
      activitySinceLastCheckpoint: activitySince(active.id, since),
      briefing: briefing ? { updatedAt: briefing.updated_at, seenByTraderAt: briefing.seen_at } : "todavía no tiene briefing",
    };
  }
  const beliefsWithoutCondition = (db.prepare("SELECT id FROM beliefs WHERE status = 'active' AND condition IS NULL").all() as Array<{ id: number }>).map((r) => r.id);
  return {
    pendingFinalReviews: pendingReviews(),
    activeMission,
    recentApproach: recentApproach(),
    // Por clase de misión: aciertos con su IC de Wilson, calibración del cerebro, línea base y gemelo mecánico.
    missionClasses: classStats({ perMissionLimit: 20 }),
    memoryHygiene: memoryHygiene(),
    pendingObservations: db.prepare("SELECT id, ts, mission_id, kind, text FROM observations WHERE status = 'pending' ORDER BY id").all(),
    errorsWithoutHowto: recurringErrors().filter((e: any) => !e.howtoId),
    beliefsWithoutCondition,
  };
}

/** Todo lo ocurrido en una misión (desde `since` si se indica), para revisarla en una sola llamada. */
export function missionReviewData(missionId: number, since?: string) {
  const m = getMission(missionId);
  if (!m) throw new Error(`No existe la misión #${missionId}`);
  const from = since ?? "";
  const { benchmark: _b, benchmark_sol_price: _s, signal_features: _f, ...mission } = m as Mission & { benchmark?: unknown; benchmark_sol_price?: unknown };
  const briefing = db.prepare("SELECT text, updated_at, seen_at FROM briefings WHERE mission_id = ?").get(missionId) as
    | { text: string; updated_at: string; seen_at: string | null }
    | undefined;
  const errors = db.prepare("SELECT id, ts, tool, error_class, message, howto_id FROM tool_errors WHERE mission_id = ? AND ts > ? ORDER BY id").all(missionId, from) as Array<
    Record<string, unknown> & { error_class: string; message: string }
  >;
  // A mitad de misión (since), solo lo nuevo: el revisor ya leyó el resto en su revisión anterior. Las
  // posiciones abiertas antes siguen saliendo (su estado importa), pero sin la tesis ni los datos de entrada.
  const allPositions = listPositions(missionId);
  const positions = since
    ? allPositions
        .filter((p) => p.status === "open" || p.openedAt > from || (p.closedAt ?? "") > from)
        .map((p) => (p.openedAt > from ? p : { ...p, thesis: undefined, lessonsApplied: undefined, entry: undefined, research: undefined, note: "abierta antes de tu última revisión" }))
    : allPositions;
  // El gemelo, solo con la misión terminada: a mitad de misión podría llegarle al agente por el briefing.
  const twin = m.status === "active" || m.status === "closing" ? null : shadowSummary(missionId);
  // La entrada del agente medida con velas como sus gemelos (misma vara), con su ficha. Con la misión terminada, como el gemelo.
  const agentEntry = m.status === "active" || m.status === "closing" ? null : agentEntrySummary(missionId);
  const measurement = missionMeasurement(m);
  return {
    mission: { ...mission, profile: describe(profile(m)) },
    // Lo que tardó en prepararse (de pedirla a arrancar el reloj) y en entrar desde la señal de wait_for_signal.
    ...(measurement ? { measurement } : {}),
    stats: missionStats(missionId),
    // Misión rápida: su gemelo mecánico (los eventos siguientes con la regla sin inteligencia) y cómo va su clase.
    ...(twin ? { twin } : {}),
    ...(agentEntry ? { agentEntry } : {}),
    ...(m.class && !since
      ? { missionClass: classStats({ cls: m.class, costMode: m.cost_mode, perMissionLimit: 10 })[0] ?? `${m.class} (costes ${m.cost_mode}): aún sin misiones terminadas` }
      : {}),
    briefing: !briefing
      ? null
      : since && briefing.updated_at <= from
        ? { updated_at: briefing.updated_at, seen_at: briefing.seen_at, text: "(sin cambios desde tu última revisión)" }
        : briefing,
    ...(since
      ? { checkpoints: `${(db.prepare("SELECT COUNT(*) AS n FROM review_checkpoints WHERE mission_id = ?").get(missionId) as { n: number }).n} revisiones anteriores` }
      : { checkpoints: db.prepare("SELECT ts, summary FROM review_checkpoints WHERE mission_id = ? ORDER BY id").all(missionId) }),
    positions,
    ...(since && positions.length < allPositions.length ? { positionsNote: `${allPositions.length - positions.length} posiciones cerradas antes de tu última revisión no salen` } : {}),
    journal: db.prepare("SELECT ts, kind, summary, reasoning, details FROM journal WHERE mission_id = ? AND ts > ? ORDER BY id LIMIT 400").all(missionId, from),
    workLog: db
      .prepare("SELECT ts, kind, title FROM activity WHERE mission_id = ? AND ts > ? AND kind IN ('thought', 'text') ORDER BY id LIMIT 300")
      .all(missionId, from),
    notes: db.prepare("SELECT ts, text FROM notes WHERE mission_id = ? AND ts > ? ORDER BY id").all(missionId, from),
    // Las pendientes siempre (hay que procesarlas); las ya resueltas, solo si son nuevas.
    observations: db
      .prepare("SELECT id, ts, kind, text, status FROM observations WHERE mission_id = ? AND (status = 'pending' OR ts > ?) ORDER BY id")
      .all(missionId, from),
    // Candidatos cuya compra de enter_with_exits revirtió (el precio se movió más que el slippage en la latencia): quedaron
    // descartados en la misión. Antes del reloj no cuentan como operación, pero dicen por qué tardó en entrar o no entró.
    ...(() => {
      const reverted = revertedEntries(missionId).filter((r) => r.ts > from);
      return reverted.length ? { entryExclusions: reverted } : {};
    })(),
    // El mensaje solo si dice algo más que su clase normalizada.
    toolErrors: errors.map(({ error_class, message, ...e }) => ({
      ...e,
      error: error_class,
      ...(message && message !== error_class && !message.startsWith(error_class) ? { message: message.length > 240 ? message.slice(0, 240) + "…" : message } : {}),
    })),
  };
}

/**
 * Todo lo que necesita una revisión a mitad de misión, en una sola respuesta: lo nuevo desde la última
 * revisión, las creencias que tocan las posiciones nuevas (las aplicadas y las que cumplen por sus datos
 * de entrada) con su evidencia de ahora, los howtos por título y los errores repetidos sin howto.
 * Así cada relanzamiento del revisor no vuelve a leer la cola entera ni el catálogo de memoria.
 */
export function checkpointData(missionId: number) {
  const m = getMission(missionId);
  if (!m) throw new Error(`No existe la misión #${missionId}`);
  const since = lastCheckpoint(missionId) ?? m.created_at;
  const data = missionReviewData(missionId, since);
  const touched = new Set<number>();
  for (const p of data.positions.filter((x) => x.openedAt > since)) {
    for (const id of p.beliefsApplied ?? []) touched.add(id);
    const f = beliefsFor(p.venue, (p.entry ?? {}) as Record<string, unknown>, p.asset, (p.research ?? {}) as Record<string, unknown>);
    for (const id of [...f.block, ...f.caution, ...f.favor]) touched.add(id);
  }
  const mem = recall(missionId);
  return {
    since,
    ...data,
    memory: {
      howtos: mem.howtos.map((h) => `#${h.id} [${h.scope}/${h.topic}] ${h.title}`),
      beliefsTouched: mem.beliefs
        .filter((b) => touched.has(b.id))
        .map((b) => ({ id: b.id, statement: clip(b.statement, 200), ...(b.condition ? { condition: b.condition, expectation: b.expectation } : {}), evidence: b.evidence.verdict })),
      otherBeliefs: `${mem.totalBeliefs - touched.size} creencias más, sin relación con las posiciones nuevas (memory_catalog si necesitas alguna)`,
    },
    errorsWithoutHowto: (recurringErrors() as Array<Record<string, unknown>>).filter((e) => !e.howtoId).slice(0, 5),
    note:
      "Todo lo de esta revisión: no hace falta review_queue, mission_review_data ni memory_catalog. El detalle de una creencia o un " +
      "howto concreto, con memory_catalog y belief_ids/howto_ids. Al terminar, review_checkpoint.",
  };
}

/**
 * Espera (hasta `maxMinutes`) a que haya algo que revisar en la misión activa: que termine, que toque
 * la revisión periódica o que se acumule actividad del agente.
 */
export async function waitForActivity(maxMinutes: number) {
  const until = Date.now() + maxMinutes * 60_000;
  for (;;) {
    const m = getActiveMission();
    if (!m) {
      const last = getLastMission();
      return { reason: "mission_ended", missionId: last?.id, status: last?.status, pendingFinalReviews: pendingReviews() };
    }
    const since = lastCheckpoint(m.id) ?? m.created_at;
    const minutesSince = (Date.now() - new Date(since).getTime()) / 60_000;
    const activity = activitySince(m.id, since);
    const interval = reviewIntervalMinutes(m);
    if (minutesSince >= interval) return { reason: "interval_due", missionId: m.id, minutesSinceLastReview: Math.round(minutesSince), activity };
    if (minutesSince >= 10 && activity.trades + activity.observations + activity.errors >= 5) {
      return { reason: "activity", missionId: m.id, minutesSinceLastReview: Math.round(minutesSince), activity };
    }
    if (Date.now() >= until) {
      return { reason: "timeout", missionId: m.id, minutesSinceLastReview: Math.round(minutesSince), nextReviewInMinutes: Math.round(interval - minutesSince), activity };
    }
    await new Promise((r) => setTimeout(r, Math.min(20_000, until - Date.now())));
  }
}

// ─── Briefing: lo que el revisor quiere que el agente tenga presente ────────

export function writeBriefing(missionId: number, text: string) {
  const m = getMission(missionId);
  if (!m) throw new Error(`No existe la misión #${missionId}`);
  db.prepare(
    `INSERT INTO briefings (mission_id, created_at, updated_at, text) VALUES (?, ?, ?, ?)
     ON CONFLICT(mission_id) DO UPDATE SET updated_at = excluded.updated_at, text = excluded.text`,
  ).run(missionId, now(), now(), text);
  logActivity({ missionId, sessionId: null, kind: "review", title: "El revisor actualiza el briefing del agente", body: text });
}

export function getBriefing(missionId: number) {
  return db.prepare("SELECT text, updated_at, seen_at FROM briefings WHERE mission_id = ?").get(missionId) as
    | { text: string; updated_at: string; seen_at: string | null }
    | undefined;
}

export function markBriefingSeen(missionId: number) {
  db.prepare("UPDATE briefings SET seen_at = ? WHERE mission_id = ?").run(now(), missionId);
}

/** Si el revisor ha cambiado el briefing desde la última vez que lo vio el agente, lo devuelve (y lo marca como visto). */
export function takeBriefingNews(missionId: number): string | null {
  const b = getBriefing(missionId);
  if (!b || (b.seen_at && b.seen_at >= b.updated_at)) return null;
  markBriefingSeen(missionId);
  return b.text;
}

// ─── Capacidades que el agente echa en falta ────────────────────────────────

export const CAPABILITY_CATEGORIES = ["cuenta", "herramienta", "datos", "mercado", "otro"] as const;

/** Anota una capacidad que el agente necesitaría. Si ya estaba pedida (abierta), suma la petición. */
export function requestCapability(a: {
  source: "trader" | "reviewer";
  missionId: number | null;
  category: (typeof CAPABILITY_CATEGORIES)[number];
  capability: string;
  why: string;
  plan: string;
}) {
  const fp = fingerprint(a.capability);
  const open = db.prepare("SELECT id, fingerprint, missions FROM capability_requests WHERE status = 'open'").all() as Array<{ id: number; fingerprint: string; missions: string }>;
  const same = open.find((r) => similarity(r.fingerprint, fp) >= DUPLICATE_THRESHOLD);
  if (same) {
    const missions = new Set(JSON.parse(same.missions) as number[]);
    if (a.missionId !== null) missions.add(a.missionId);
    db.prepare("UPDATE capability_requests SET times_requested = times_requested + 1, missions = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify([...missions]),
      now(),
      same.id,
    );
    return { id: same.id, duplicate: true };
  }
  const id = Number(
    db
      .prepare(
        `INSERT INTO capability_requests (created_at, updated_at, source, category, capability, why, plan, fingerprint, missions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(now(), now(), a.source, a.category, a.capability, a.why, a.plan, fp, JSON.stringify(a.missionId !== null ? [a.missionId] : [])).lastInsertRowid,
  );
  logActivity({ missionId: a.missionId, sessionId: null, kind: "request", title: `Pide: ${a.capability}`, body: a.why });
  return { id, duplicate: false };
}

export interface CapabilityRequest {
  id: number;
  created_at: string;
  updated_at: string;
  source: string;
  category: string;
  capability: string;
  why: string;
  plan: string;
  times_requested: number;
  missions: number[];
  status: string;
  response: string | null;
}

export function listCapabilityRequests(status: "open" | "all" = "open"): CapabilityRequest[] {
  return (
    db
      .prepare(`SELECT * FROM capability_requests ${status === "open" ? "WHERE status = 'open'" : ""} ORDER BY times_requested DESC, updated_at DESC`)
      .all() as Array<Omit<CapabilityRequest, "missions"> & { missions: string; fingerprint?: string }>
  ).map(({ fingerprint: _fp, ...r }) => ({ ...r, missions: JSON.parse(r.missions) as number[] }));
}

export function resolveCapabilityRequest(id: number, status: "accepted" | "rejected" | "done", response: string) {
  if (!db.prepare("UPDATE capability_requests SET status = ?, response = ?, updated_at = ? WHERE id = ?").run(status, response, now(), id).changes) {
    throw new Error(`No existe la petición #${id}`);
  }
}

// ─── Observaciones, errores y APIs (los registra el simulador o el agente que opera) ──

export function reportObservation(missionId: number | null, sessionId: number | null, kind: string, text: string) {
  return Number(
    db.prepare("INSERT INTO observations (ts, mission_id, session_id, kind, text) VALUES (?, ?, ?, ?, ?)").run(now(), missionId, sessionId, kind, text)
      .lastInsertRowid,
  );
}

export function resolveObservation(id: number, status: "used" | "dismissed", resolution: string) {
  if (!db.prepare("UPDATE observations SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?").run(status, now(), resolution, id).changes) {
    throw new Error(`No existe la observación #${id}`);
  }
}

/** Tipo de error: el mensaje sin direcciones, números ni detalles variables, para agrupar los repetidos. */
export function errorClass(message: string) {
  return message
    .replace(/0x[0-9a-fA-F]{6,}/g, "<dirección>")
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "<dirección>")
    .replace(/\d+([.,]\d+)?(e-?\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * El howto que el revisor ya enlazó a este tipo de error (mismo error_class), si lo hay: se le enseña al agente en
 * el momento en que el error se repite. Los howtos le llegan por título al empezar y no siempre los relee; en
 * M32-M35 repitió cuatro veces un error que su howto #6 ya explicaba.
 */
export function howtoForError(message: string): { id: number; title: string; steps: string } | undefined {
  const row = db
    // Por el principio del mensaje: el resto lleva el símbolo del token y cambia de un error a otro del mismo tipo.
    .prepare("SELECT h.id, h.title, h.steps FROM tool_errors e JOIN howtos h ON h.id = e.howto_id WHERE substr(e.error_class, 1, 50) = ? AND h.status = 'active' ORDER BY e.id DESC LIMIT 1")
    .get(errorClass(message).slice(0, 50)) as { id: number; title: string; steps: string } | undefined;
  return row;
}

export function recordToolError(a: { missionId: number | null; sessionId: number | null; tool: string; input: unknown; message: string }) {
  const input = (a.input ?? {}) as Record<string, unknown>;
  const venue = typeof input.chain === "string" ? input.chain : typeof input.from === "string" ? input.from : a.tool.includes("binance") ? "binance" : null;
  db.prepare("INSERT INTO tool_errors (ts, mission_id, session_id, tool, venue, error_class, message, input) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    now(),
    a.missionId,
    a.sessionId,
    a.tool,
    venue,
    errorClass(a.message),
    a.message.slice(0, 1000),
    JSON.stringify(a.input ?? null).slice(0, 2000),
  );
}

/** Anota si una API respondió bien (lo usa http_get). La ruta se recorta a sus tres primeros tramos. */
export function recordApiCall(url: string, status: number) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  const path = "/" + u.pathname.split("/").filter(Boolean).slice(0, 3).join("/");
  const ok = status >= 200 && status < 300;
  db.prepare(
    `INSERT INTO api_observations (host, path, ok, fail, last_status, last_ok_at, last_fail_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, path) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail, last_status = excluded.last_status,
       last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at), last_fail_at = COALESCE(excluded.last_fail_at, last_fail_at)`,
  ).run(u.host, path, ok ? 1 : 0, ok ? 0 : 1, status, ok ? now() : null, ok ? null : now());
}

// ─── Creencias citadas en las tesis ─────────────────────────────────────────

export function activeBeliefIds(): number[] {
  return (db.prepare("SELECT id FROM beliefs WHERE status = 'active' ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

/** Ids citados que no corresponden a una creencia activa. */
export function unknownBeliefs(ids: number[]): number[] {
  const active = new Set(activeBeliefIds());
  return [...new Set(ids)].filter((id) => !active.has(id));
}

/** Última revisión (a mitad de misión) del revisor, o null si no ha revisado aún. */
export const lastReviewAt = (missionId: number) => lastCheckpoint(missionId);
