// Planes del cerebro (el agente planner): las reglas con las que el executor opera un bloque de misiones de una misma
// clase ('graduado-10m-+25%'). Son reglas, no una lista de tokens: un plan pensado en esfuerzo máximo tarda 15-30 min
// y un token recién graduado caduca en minutos. El plan queda fijo durante un bloque de PLAN_BLOCK_SIZE misiones: si las
// reglas cambiaran en cada misión, no se mediría nada (ni si el cerebro acierta ni si mejora a la línea base).
import { db, logJournal, now } from "../db.js";
import { isFastMission } from "./mission-kind.js";

/** Misiones terminadas que juega un plan antes de poder sustituirlo sin motivo. */
export const PLAN_BLOCK_SIZE = 20;

/**
 * De dónde saca wait_for_signal los eventos. graduado: tokens de pump.fun recién migrados a su pool de PumpSwap
 * (el mercado de la misión rápida por defecto). shortlist: solo los tokens de la lista corta del plan (curvas de
 * pump.fun llenas al 90 % o más: los siguientes en graduarse), cuando se gradúan.
 */
export const SIGNAL_SOURCES = ["graduado", "shortlist"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/**
 * Mercado de lo que de verdad se opera con cada fuente: el de la clase del plan. Las dos esperan graduaciones de
 * pump.fun, así que las dos son 'graduado'. Si la etiqueta del plan dijera otro mercado (p. ej. momentum), la misión se
 * compararía con la línea base de ese mercado (16 % en vez de 35 %) y sin gemelo: un falso "el agente aporta".
 */
export const SOURCE_MARKET: Record<SignalSource, string> = { graduado: "graduado", shortlist: "graduado" };

/** Filtros mecánicos propios del plan. Los comprueba wait_for_signal sin LLM; todos son opcionales. */
export interface PlanFilters {
  /** Edad máxima del pool (o de la graduación) en minutos. Por defecto, 2. */
  max_pool_age_minutes?: number;
  /** Launchpads de origen admitidos, según Jupiter. Por defecto en graduado, solo pump.fun; [] = cualquiera. */
  launchpads?: string[];
  min_liquidity_usd?: number;
  max_liquidity_usd?: number;
  min_fdv_usd?: number;
  max_fdv_usd?: number;
  min_buys_5m?: number;
  min_buyers_5m?: number;
  min_buy_sell_ratio_5m?: number;
  min_volume_5m_usd?: number;
  min_price_change_5m_pct?: number;
  max_price_change_5m_pct?: number;
  /** Coste máximo de comprar y vender al momento con el capital de la misión (cotizaciones de Jupiter). */
  max_round_trip_cost_pct?: number;
}

/** Lo que escribe el planner (write_plan). Se guarda tal cual en plans.body. */
export interface PlanBody {
  /** El tipo de evento que dispara la entrada, en palabras. */
  event: string;
  source: SignalSource;
  filters: PlanFilters;
  /** Filtros propios que no se pueden comprobar sin mirar (los revisa el executor antes de entrar). */
  manual_filters?: string;
  /** Tamaño de la entrada, en palabras. Por defecto: todo el capital menos el gas. */
  sizing: string;
  /** Importe fijo de la entrada; sin él, todo el efectivo de la cadena. */
  usd_amount?: number;
  /** Precio de la toma de beneficio = precio de compra × tp_ratio (calculado con quote_swap para el capital). */
  tp_ratio?: number;
  /** Regla de reentrada, en palabras. */
  reentry: string;
  reentry_allowed: boolean;
  /** Lo comprobado en contra (creencias negativas, riskCheck): vale como risks_checked de cada compra del plan. */
  risks_checked: string;
  why: string;
  evidence: string;
  sources: string[];
  beliefs_applied?: number[];
  memory_note?: string;
  /** Opcional: curvas de pump.fun llenas al 90 % o más, las siguientes en graduarse. */
  shortlist?: Array<{ mint: string; note?: string }>;
  /** Solo si sustituye antes de tiempo al plan vigente de su clase: cuál y por qué. */
  replaces?: { id: number; reason: string };
}

export interface Plan {
  id: number;
  created_at: string;
  class: string;
  body: PlanBody;
  predicted_p: number | null;
  baseline_p: number | null;
  active: boolean;
}

interface PlanRow {
  id: number;
  created_at: string;
  class: string;
  body: string;
  predicted_p: number | null;
  baseline_p: number | null;
  active: number;
}

const toPlan = (r: PlanRow | undefined): Plan | undefined => (r ? { ...r, body: JSON.parse(r.body) as PlanBody, active: r.active === 1 } : undefined);

export const getPlan = (id: number) => toPlan(db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined);

export const activePlan = (cls: string) => toPlan(db.prepare("SELECT * FROM plans WHERE class = ? AND active = 1 ORDER BY id DESC LIMIT 1").get(cls) as PlanRow | undefined);

export const latestActivePlan = () => toPlan(db.prepare("SELECT * FROM plans WHERE active = 1 ORDER BY id DESC LIMIT 1").get() as PlanRow | undefined);

/**
 * Cómo va el bloque de un plan: misiones que lo han jugado hasta el final y cuántas lo consiguieron. Y las que se
 * prepararon con él pero se cancelaron a los 60 min sin que llegara ningún candidato (prep_timeout): no cuentan en el
 * bloque, pero si su fuente o sus filtros no dejan pasar nada, el plan no sirve y hay que sustituirlo.
 */
export function planBlock(planId: number) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(started_at IS NOT NULL), 0) AS played,
              COALESCE(SUM(started_at IS NOT NULL AND status IN ('succeeded', 'expired', 'bust')), 0) AS finished,
              COALESCE(SUM(started_at IS NOT NULL AND status = 'succeeded'), 0) AS succeeded,
              COALESCE(SUM(end_reason = 'prep_timeout'), 0) AS noCandidate
       FROM missions WHERE plan_id = ?`,
    )
    .get(planId) as { played: number; finished: number; succeeded: number; noCandidate: number };
  // La última misión terminada del plan (sin contar las que paró o sustituyó el usuario): ¿se canceló sin candidato?
  const last = db
    .prepare(
      `SELECT id, end_reason FROM missions WHERE plan_id = ? AND status NOT IN ('active', 'closing')
         AND (started_at IS NOT NULL OR end_reason = 'prep_timeout') ORDER BY id DESC LIMIT 1`,
    )
    .get(planId) as { id: number; end_reason: string | null } | undefined;
  return { ...r, left: Math.max(0, PLAN_BLOCK_SIZE - r.finished), lastWithoutCandidate: last?.end_reason === "prep_timeout" ? last.id : null };
}

/**
 * Guarda un plan y lo deja vigente para su clase. El anterior de la clase deja de estarlo, pero solo si ya ha jugado
 * su bloque entero, o con un motivo (replaceReason): p. ej. que su fuente no dé candidatos.
 */
export function writePlan(a: {
  cls: string;
  body: PlanBody;
  predictedP: number;
  baselineP: number;
  missionId: number | null;
  sessionId: number | null;
  replaceReason?: string;
}): { id: number; replaced?: number } {
  let id = 0;
  let current: Plan | undefined;
  // Comprobar y sustituir en la misma transacción: dos planners a la vez no dejan dos planes vigentes.
  db.exec("BEGIN IMMEDIATE");
  try {
    current = activePlan(a.cls);
    if (current) {
      const block = planBlock(current.id);
      if (block.finished < PLAN_BLOCK_SIZE && !a.replaceReason) {
        throw new Error(
          `La clase ${a.cls} ya tiene vigente el plan #${current.id}, que lleva ${block.finished} de ${PLAN_BLOCK_SIZE} misiones terminadas: ` +
            "el plan queda fijo durante su bloque (si cambia a mitad, no se mide nada). Si de verdad no sirve (p. ej. su fuente no da " +
            "candidatos), repite con replace_reason explicando por qué.",
        );
      }
    }
    const body: PlanBody = current && a.replaceReason ? { ...a.body, replaces: { id: current.id, reason: a.replaceReason } } : a.body;
    db.prepare("UPDATE plans SET active = 0 WHERE class = ? AND active = 1").run(a.cls);
    id = Number(
      db
        .prepare("INSERT INTO plans (created_at, class, body, predicted_p, baseline_p, active) VALUES (?, ?, ?, ?, ?, 1)")
        .run(now(), a.cls, JSON.stringify(body), a.predictedP, a.baselineP).lastInsertRowid,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const pct = (p: number) => `${Math.round(p * 100)} %`;
  logJournal({
    missionId: a.missionId,
    sessionId: a.sessionId,
    kind: "plan",
    summary:
      `Plan #${id} para ${a.cls}: ${a.body.event} (P ${pct(a.predictedP)} frente a ${pct(a.baselineP)} de la línea base)` +
      (current ? `; sustituye al #${current.id}` : ""),
    details: { planId: id, class: a.cls, ...(current ? { replaced: current.id, reason: a.replaceReason } : {}) },
  });
  return { id, ...(current ? { replaced: current.id } : {}) };
}

interface MissionRow {
  class: string | null;
  plan_id: number | null;
  created_at: string;
  deadline: string;
  started_at: string | null;
  mode: string | null;
}
const missionRow = (id: number) =>
  db.prepare("SELECT class, plan_id, created_at, deadline, started_at, mode FROM missions WHERE id = ?").get(id) as MissionRow | undefined;

/**
 * Plan de una misión. Con el reloj en marcha, el que tiene asignado: queda fijo aunque el planner lo sustituya a mitad.
 * Antes del reloj, el vigente de su clase (el asignado solo marca con cuál se preparó, y puede haberse sustituido); si
 * no hay ninguno vigente, el asignado. Solo de su clase exacta: un plan de otro mercado no se adopta.
 */
export function planForMission(missionId: number): Plan | undefined {
  const m = missionRow(missionId);
  if (!m) return undefined;
  if (m.plan_id !== null && m.started_at) return getPlan(m.plan_id);
  return preparedPlan(m);
}

/** El plan con el que se juega una misión que aún no lo tiene fijo: el vigente de su clase o, si no hay, el marcado. */
const preparedPlan = (m: MissionRow) => (m.class ? activePlan(m.class) : undefined) ?? (m.plan_id !== null ? getPlan(m.plan_id) : undefined);

/**
 * Antes del reloj (wait_for_signal): la misión queda marcada con el plan con el que se prepara. Si se cancela sin
 * candidato, el bloque de ese plan la cuenta (planBlock). Al arrancar el reloj se le asigna el plan de verdad.
 */
export function markPlanForMission(missionId: number, planId: number) {
  db.prepare("UPDATE missions SET plan_id = ? WHERE id = ? AND started_at IS NULL AND status = 'active'").run(planId, missionId);
}

/**
 * Asigna el plan a la misión: su id, la P que predice y la de la línea base, y su clase (el plan puede fijar otro
 * mercado). Con esto se compara después cada misión con lo que esperaba el cerebro y con la línea base.
 */
export function attachPlan(missionId: number, plan: Plan) {
  db.prepare("UPDATE missions SET plan_id = ?, predicted_p = ?, baseline_p = ?, class = ? WHERE id = ?").run(
    plan.id,
    plan.predicted_p,
    plan.baseline_p,
    plan.class,
    missionId,
  );
}

/** Al arrancar el reloj: si hay un plan para la misión, queda asignado (el executor lo cita con plan_ref). */
export function attachPlanForMission(missionId: number): Plan | undefined {
  const m = missionRow(missionId);
  // El reloj ya consta como arrancado: aquí es cuando el plan queda fijo, así que se elige como antes del reloj.
  const plan = m ? preparedPlan(m) : undefined;
  if (plan) attachPlan(missionId, plan);
  return plan;
}

/**
 * Tesis abreviada: en una misión rápida, una operación cita el plan (plan_ref) en lugar de escribir la tesis
 * entera, que costaba 1.000-1.300 tokens por decisión con el reloj en marcha. La tesis que queda en el diario es la
 * del plan, con su risks_checked ya validado por el cerebro.
 */
export function thesisFromPlan(planId: number, missionId: number) {
  const m = missionRow(missionId);
  if (!m) throw new Error("No hay ninguna misión");
  if (!isFastMission(m)) {
    throw new Error("plan_ref solo vale en misiones rápidas (simuladas de 15 min o menos): en esta, cada operación lleva su tesis completa");
  }
  const plan = getPlan(planId);
  if (!plan) throw new Error(`No existe el plan #${planId}: los vigentes los da get_plan`);
  if (!plan.active && m.plan_id !== plan.id) {
    const current = activePlan(plan.class);
    throw new Error(`El plan #${planId} ya no está vigente${current ? `: el de su clase (${plan.class}) es el #${current.id}` : ""}`);
  }
  if (m.class && m.class !== plan.class && m.plan_id !== plan.id) {
    throw new Error(`El plan #${planId} es para ${plan.class} y esta misión es ${m.class}: no son de la misma clase`);
  }
  const b = plan.body;
  return {
    why: `Plan #${plan.id} (${plan.class}): ${b.event}. ${b.why}`,
    evidence: b.evidence,
    sources: b.sources.length ? b.sources : [`plan #${plan.id}`],
    exit_plan:
      `Toma de beneficio ${b.tp_ratio ? `a ×${b.tp_ratio} del precio de compra` : "en el precio que deja el objetivo cumplido neto de costes"}; ` +
      `si no salta, venta al acabar el reloj. Reentrada: ${b.reentry_allowed ? b.reentry : "no"}`,
    beliefs_applied: b.beliefs_applied ?? [],
    memory_note: b.memory_note?.trim() || `Aplica el plan #${plan.id} del cerebro`,
    risks_checked: b.risks_checked,
  };
}

/** El plan tal como lo leen los agentes (get_plan y el briefing de una misión rápida). */
export function describePlan(plan: Plan) {
  const block = planBlock(plan.id);
  return {
    planId: plan.id,
    class: plan.class,
    status: plan.active ? "vigente" : "sustituido",
    createdAt: plan.created_at,
    predictedP: plan.predicted_p,
    baselineP: plan.baseline_p,
    block: `${block.finished} de ${PLAN_BLOCK_SIZE} misiones terminadas (${block.succeeded} conseguidas)`,
    ...(block.noCandidate
      ? {
          withoutCandidate: {
            missions: block.noCandidate,
            lastMissionWithoutCandidate: block.lastWithoutCandidate,
            note:
              `${block.noCandidate} misión(es) preparadas con este plan se cancelaron a los 60 min sin que llegara ningún candidato` +
              (block.lastWithoutCandidate !== null
                ? `, la última (#${block.lastWithoutCandidate}) incluida: si su fuente o sus filtros no dejan pasar nada, el planner lo sustituye con ` +
                  "replace_reason (los descartes de wait_for_signal están en el diario de esa misión: journal_history)"
                : ""),
          },
        }
      : {}),
    ...plan.body,
  };
}
