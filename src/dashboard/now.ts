// «Ahora mismo»: en qué punto de la tanda está el equipo, sacado de la base de datos (misión, plan, diario) y de qué
// agente tiene una sesión abierta. Las fases de una misión rápida, en orden:
//   esperando plan   el cerebro (planner) escribe el plan, o la misión se ha creado sin plan para su clase
//   esperando señal  misión activa sin reloj: el ejecutor espera con wait_for_signal a un token que pase los filtros
//   reloj            enter_with_exits compró y puso la toma de beneficio: el reloj de la misión corre
//   revisando        la misión ha terminado y el revisor aún no la ha dado por revisada (solo las que tiene que revisar:
//                    jugadas hasta el final, o canceladas que llegaron a operar; el mismo criterio que pendingReviews)
//   pausa            entre misiones (una cancelada sin posiciones, p. ej. por prep_timeout, va directa: nadie la revisa)
// derivePhase es una función pura (se prueba sola); nowState la alimenta desde la base de datos.
import { db } from "../db.js";
import { isFastMission, PREP_TIMEOUT_MINUTES } from "../sim/mission-kind.js";
import { columnsOf } from "./batches.js";
import type { AgentName, AgentSession } from "./timeline.js";

export type PhaseId = "sin-mision" | "esperando-plan" | "esperando-senal" | "reloj" | "revisando" | "pausa";

export interface PhaseMission {
  id: number;
  status: string;
  end_reason: string | null;
  class: string | null;
  cost_mode: string | null;
  plan_id: number | null;
  mode: string | null;
  requested_at: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  reviewed_at: string | null;
  deadline: string;
  initial_usd: number;
  target_usd: number;
  final_usd: number | null;
  signal_at: string | null;
  signal_token: string | null;
  entry_at: string | null;
  entry_latency_s: number | null;
}

/** La posición del reloj: el token, a cuánto entró, dónde está la toma de beneficio y cuánto vale ahora. */
export interface EntryInfo {
  token: string;
  symbol: string | null;
  enteredAt: string | null;
  entryPriceUsd: number | null;
  tpPriceUsd: number | null;
  usdIn: number | null;
  /** Precio y valor de liquidación ahora (la última valoración del panel). */
  priceUsd: number | null;
  valueUsd: number | null;
  valuedAt: string | null;
}

export interface PhaseInput {
  nowMs: number;
  mission: PhaseMission | null;
  /** El plan vigente de la clase de la misión, si hay. */
  classPlan: { id: number; created_at: string } | null;
  /** La última espera sin señal del diario (wait_for_signal antes del reloj). */
  lastSignal: { ts: string; summary: string } | null;
  /** La última entrada rechazada (enter_with_exits que revierte). */
  lastRejection: { ts: string; summary: string } | null;
  /** Nombre de los tokens vistos en las señales (de la transcripción del ejecutor). */
  symbols?: Record<string, string>;
  /** Sesiones de agentes con actividad desde que se pidió la misión, de la más reciente a la más antigua. */
  sessions: AgentSession[];
  entry: EntryInfo | null;
  /** Valor total de la cartera ahora (la última valoración del panel). */
  totalUsd: number | null;
  /** Terminada: si llegó a tener posiciones (una cancelada sin ninguna no la revisa nadie). */
  hasPositions?: boolean;
  /** Compras de enter_with_exits que revirtieron (entry_exclusions): una prep_timeout con alguna sí tuvo candidatos. */
  revertedEntries?: number;
}

export interface Phase {
  id: PhaseId;
  label: string;
  /** Desde cuándo está en esta fase (ISO). */
  since: string | null;
  missionId: number | null;
  missionStatus: string | null;
  fast: boolean;
  costMode: string | null;
  planId: number | null;
  /** El agente que está trabajando ahora, si hay uno con la sesión abierta. */
  agent: { name: AgentName; since: string; lastAt: string } | null;
  /** Esperando señal: la última vuelta sin señal y el último candidato (el token que devolvió wait_for_signal). */
  signal?: {
    lastWait: { ts: string; summary: string; waitedS: number | null; seen: number | null } | null;
    candidate: { token: string; symbol: string | null; at: string } | null;
    rejection: { ts: string; summary: string } | null;
    /** Si el reloj no arranca antes, la misión se cancela. */
    prepEndsAt: string | null;
  };
  /** Reloj en marcha. */
  clock?: { startedAt: string; deadline: string; closing: boolean; initialUsd: number; targetUsd: number; totalUsd: number | null; entry: EntryInfo | null; latencyS: number | null };
  /** Revisando o en pausa: cómo acabó la misión. */
  result?: {
    status: string;
    endReason: string | null;
    resultPct: number | null;
    finalUsd: number | null;
    endedAt: string | null;
    reviewedAt: string | null;
    /** Si le toca retrospectiva (jugada hasta el final, o cancelada con posiciones). */
    reviewable: boolean;
    revertedEntries: number;
  };
  /** Pasos que esta misión no tuvo (sin reloj, o nada que revisar): el panel no los marca como hechos. */
  skipped?: PhaseId[];
  /** El plan vigente de su clase (esperando plan: el que va a sustituir, si hay). */
  classPlanId?: number | null;
}

const LABEL: Record<PhaseId, string> = {
  "sin-mision": "Sin misión",
  "esperando-plan": "Esperando plan",
  "esperando-senal": "Esperando señal",
  reloj: "Reloj en marcha",
  revisando: "Revisando",
  pausa: "En pausa entre misiones",
};

// Una sesión sin escribir nada en este tiempo ya no cuenta como en marcha. wait_for_signal y wait vuelven como mucho a
// los 4,5 min; una sesión del hilo principal que termina bien lo dice (cost-state), un subagente no.
const MAIN_IDLE_MS = 8 * 60_000;
const SUB_IDLE_MS = 6 * 60_000;

export function runningAgent(sessions: AgentSession[], nowMs: number): AgentSession | null {
  return sessions.find((s) => !s.ended && nowMs - Date.parse(s.lastAt) < (s.main ? MAIN_IDLE_MS : SUB_IDLE_MS)) ?? null;
}

const ACTIVE = new Set(["active", "closing"]);
/** Jugadas hasta el final: siempre tienen retrospectiva. Una cancelada, solo si llegó a operar (pendingReviews). */
const PLAYED = new Set(["succeeded", "expired", "bust"]);

/** La fase de ahora mismo a partir de la última misión, su plan, el diario y quién está trabajando. */
export function derivePhase(i: PhaseInput): Phase {
  const m = i.mission;
  const running = runningAgent(i.sessions, i.nowMs);
  const agent = running ? { name: running.agent, since: running.startedAt, lastAt: running.lastAt } : null;
  if (!m) {
    const id: PhaseId = running?.agent === "planner" ? "esperando-plan" : "sin-mision";
    return { id, label: LABEL[id], since: running?.startedAt ?? null, missionId: null, missionStatus: null, fast: false, costMode: null, planId: null, agent };
  }
  const base = { missionId: m.id, missionStatus: m.status, fast: isFastMission(m), costMode: m.cost_mode ?? "sim", agent };
  const requested = m.requested_at ?? m.created_at;
  const phase = (id: PhaseId, since: string | null, extra: Partial<Phase> = {}): Phase => ({ id, label: LABEL[id], since, planId: m.plan_id, ...base, ...extra });

  if (ACTIVE.has(m.status)) {
    if (m.started_at) {
      return phase("reloj", m.started_at, {
        clock: {
          startedAt: m.started_at,
          deadline: m.deadline,
          closing: m.status === "closing",
          initialUsd: m.initial_usd,
          targetUsd: m.target_usd,
          totalUsd: i.totalUsd,
          entry: i.entry,
          latencyS: m.entry_latency_s,
        },
      });
    }
    // Sin reloj: o falta el plan (el cerebro lo está escribiendo, o la clase no tiene ninguno), o se espera la señal.
    if (running?.agent === "planner" || (m.plan_id === null && !i.classPlan)) {
      return phase("esperando-plan", running?.agent === "planner" ? running.startedAt : requested, { planId: null, classPlanId: i.classPlan?.id ?? null });
    }
    const executor = running && (running.agent === "executor" || running.agent === "trader") ? running : null;
    const waitedS = i.lastSignal?.summary.match(/Sin señal en (\d+) s/)?.[1];
    const seen = i.lastSignal?.summary.match(/Tokens frescos vistos: (\d+)/)?.[1];
    const inMission = (ts: string | null | undefined) => !!ts && ts >= requested;
    const candidate = m.signal_token && inMission(m.signal_at) ? { token: m.signal_token, symbol: i.symbols?.[m.signal_token] ?? null, at: m.signal_at! } : null;
    return phase("esperando-senal", executor && executor.startedAt >= requested ? executor.startedAt : requested, {
      planId: m.plan_id ?? i.classPlan?.id ?? null,
      signal: {
        lastWait: i.lastSignal && inMission(i.lastSignal.ts) ? { ...i.lastSignal, waitedS: waitedS ? Number(waitedS) : null, seen: seen ? Number(seen) : null } : null,
        candidate,
        rejection: i.lastRejection && inMission(i.lastRejection.ts) ? i.lastRejection : null,
        prepEndsAt: new Date(Date.parse(requested) + PREP_TIMEOUT_MINUTES * 60_000).toISOString(),
      },
    });
  }

  const reviewable = PLAYED.has(m.status) || (m.status === "cancelled" && !!i.hasPositions);
  const result = {
    status: m.status,
    endReason: m.end_reason,
    // Sin reloj no hay resultado (la cartera no se tocó); una detenida con el reloj en marcha sí lo tiene.
    resultPct: m.final_usd === null || !m.started_at ? null : Number((((m.final_usd - m.initial_usd) / m.initial_usd) * 100).toFixed(1)),
    finalUsd: m.final_usd,
    endedAt: m.ended_at,
    reviewedAt: m.reviewed_at,
    reviewable,
    revertedEntries: i.revertedEntries ?? 0,
  };
  const skipped: PhaseId[] = [...(m.started_at ? [] : (["reloj"] as const)), ...(reviewable || m.reviewed_at ? [] : (["revisando"] as const))];
  // Terminada: el cerebro trabajando es el plan de la siguiente (se escribe antes de crearla en algunos flujos).
  if (running?.agent === "planner") return phase("esperando-plan", running.startedAt, { planId: null, classPlanId: i.classPlan?.id ?? null, result });
  if (reviewable && !m.reviewed_at) return phase("revisando", m.ended_at, { result, skipped });
  const since = [m.ended_at, m.reviewed_at].filter((x): x is string => !!x).sort().at(-1) ?? null;
  return phase("pausa", since, { result, skipped });
}

// ── Base de datos ───────────────────────────────────────────────────────────

const STABLES = ["USDC", "USDT", "SOL", "WSOL", "FDUSD", "USDbC"];

interface ValuationLike {
  totalUsd: number;
  holdings: Array<{ venue: string; asset: string; amount?: number; usd: number }>;
}

/** El token del reloj: la posición abierta más reciente que no sea un estable ni SOL (o la última, si ya no hay). */
function entryInfo(missionId: number, valuation: ValuationLike | null, valuedAt: string | null): EntryInfo | null {
  const pos = db
    .prepare(
      `SELECT asset, symbol, opened_at FROM positions WHERE mission_id = ? AND venue = 'solana' AND symbol NOT IN (${STABLES.map(() => "?").join(", ")})
       ORDER BY status = 'open' DESC, id DESC LIMIT 1`,
    )
    .get(missionId, ...STABLES) as { asset: string; symbol: string; opened_at: string } | undefined;
  if (!pos) return null;
  let entryPrice: number | null = null;
  let tpPrice: number | null = null;
  let usdIn: number | null = null;
  // v0.37.2 guarda la entrada del agente (la primera de enter_with_exits) con su precio y el de la toma de beneficio.
  if (columnsOf("agent_entries").has("entry_price_usd")) {
    const e = db.prepare("SELECT token, entry_price_usd, tp_price_usd, usd_in FROM agent_entries WHERE mission_id = ?").get(missionId) as
      | { token: string; entry_price_usd: number; tp_price_usd: number | null; usd_in: number }
      | undefined;
    if (e && e.token === pos.asset) [entryPrice, tpPrice, usdIn] = [e.entry_price_usd, e.tp_price_usd, e.usd_in];
  }
  if (entryPrice === null) {
    // Si no, la compra del diario: lo pagado entre los tokens recibidos.
    for (const j of db.prepare("SELECT details FROM journal WHERE mission_id = ? AND kind = 'swap' ORDER BY id").all(missionId) as Array<{ details: string | null }>) {
      try {
        const d = JSON.parse(j.details ?? "{}") as { outputMint?: string; sold?: string; received?: string };
        if (d.outputMint !== pos.asset) continue;
        const paid = parseFloat(String(d.sold ?? ""));
        const got = parseFloat(String(d.received ?? ""));
        if (paid > 0 && got > 0) [entryPrice, usdIn] = [paid / got, paid];
        break;
      } catch {
        continue;
      }
    }
  }
  if (tpPrice === null) {
    const o = db.prepare("SELECT trigger_price FROM orders WHERE mission_id = ? AND trigger_asset = ? AND condition = 'above' ORDER BY id DESC LIMIT 1").get(missionId, pos.asset) as
      | { trigger_price: number }
      | undefined;
    tpPrice = o?.trigger_price ?? null;
  }
  const h = valuation?.holdings.find((x) => x.venue === "solana" && x.asset === pos.asset);
  return {
    token: pos.asset,
    symbol: pos.symbol,
    enteredAt: pos.opened_at,
    entryPriceUsd: entryPrice,
    tpPriceUsd: tpPrice,
    usdIn,
    priceUsd: h && h.amount ? h.usd / h.amount : null,
    valueUsd: h ? h.usd : null,
    valuedAt: h ? valuedAt : null,
  };
}

/** La fase de ahora mismo para la misión que enseña el panel (la activa o la última). */
export function nowState(opts: {
  mission: PhaseMission | null;
  sessions: AgentSession[];
  symbols?: Record<string, string>;
  valuation: ValuationLike | null;
  valuedAt: string | null;
}): Phase {
  const m = opts.mission;
  const lastOf = (kind: string) =>
    m ? ((db.prepare("SELECT ts, summary FROM journal WHERE mission_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(m.id, kind) as { ts: string; summary: string } | undefined) ?? null) : null;
  const classPlan = m?.class
    ? ((db.prepare("SELECT id, created_at FROM plans WHERE class = ? AND active = 1 ORDER BY id DESC LIMIT 1").get(m.class) as { id: number; created_at: string } | undefined) ?? null)
    : null;
  const clock = !!m && ACTIVE.has(m.status) && !!m.started_at;
  const ended = !!m && !ACTIVE.has(m.status);
  // Una retrospectiva sin reviewed_at (las heredadas de versiones anteriores) también cuenta como revisada.
  const review =
    ended && !m.reviewed_at && columnsOf("mission_reviews").size
      ? ((db.prepare("SELECT created_at FROM mission_reviews WHERE mission_id = ?").get(m.id) as { created_at: string } | undefined) ?? null)
      : null;
  return derivePhase({
    nowMs: Date.now(),
    mission: m && review ? { ...m, reviewed_at: review.created_at } : m,
    classPlan,
    lastSignal: m && !m.started_at ? lastOf("signal") : null,
    lastRejection: m && !m.started_at ? lastOf("rejected") : null,
    symbols: opts.symbols,
    sessions: opts.sessions,
    entry: clock ? entryInfo(m.id, opts.valuation, opts.valuedAt) : null,
    totalUsd: clock ? (opts.valuation?.totalUsd ?? null) : null,
    hasPositions: ended ? !!db.prepare("SELECT 1 FROM positions WHERE mission_id = ? LIMIT 1").get(m.id) : undefined,
    revertedEntries:
      ended && columnsOf("entry_exclusions").size ? (db.prepare("SELECT COUNT(*) AS n FROM entry_exclusions WHERE mission_id = ?").get(m.id) as { n: number }).n : 0,
  });
}
