import { db, now } from "../db.js";
import { getBriefing, markBriefingSeen, recallSummary } from "./memory.js";
import { getMission, isFastMission, missionStatus, type Mission } from "./mission.js";
import { listOrders } from "./orders.js";
import { describePlan, planForMission } from "./plans.js";
import { valuation } from "./portfolio.js";
import { toText } from "../tools/format.js";

export function startSession(missionId: number | null): number {
  return Number(db.prepare("INSERT INTO sessions (started_at, mission_id) VALUES (?, ?)").run(now(), missionId).lastInsertRowid);
}

/** Lo que el agente ve al empezar cada sesión: su misión, su memoria, su cartera, sus notas y su diario reciente. */
export async function sessionBriefing(sessionId: number, missionId: number | null): Promise<string> {
  const header = `Sesión #${sessionId}. Fecha y hora actual: ${now()}.`;
  if (missionId === null) return [header, "", toText(await missionStatus())].join("\n");

  const mission = getMission(missionId)!;
  if (isFastMission(mission)) return fastBriefing(header, mission);
  const portfolio = await valuation(missionId, true);
  const notes = db.prepare("SELECT id, ts, text FROM notes WHERE mission_id = ? ORDER BY id").all(missionId) as Array<{ id: number; ts: string; text: string }>;
  const openOrders = listOrders(missionId, "open");
  const recent = db
    .prepare("SELECT ts, kind, summary FROM journal WHERE mission_id = ? ORDER BY id DESC LIMIT 15")
    .all(missionId) as Array<{ ts: string; kind: string; summary: string }>;

  const memoryLines: string[] = [];
  {
    const briefing = getBriefing(missionId);
    if (briefing) {
      memoryLines.push("Briefing del revisor para esta misión (lo prepara otro agente a partir de tu memoria):", briefing.text, "");
      markBriefingSeen(missionId);
    }
    // El mismo resumen que da recall_memory, para que no haga falta pedirlo otra vez (la misión ya va arriba).
    const { currentMission: _m, note: _n, ...mem } = recallSummary(missionId);
    memoryLines.push(
      mem.missionHistory.length || mem.totalBeliefs || mem.howtos.length
        ? "Tu memoria, resumida y ordenada por parecido con esta misión. Es lo mismo que recall_memory sin parámetros: no hace falta " +
            "pedirla otra vez. Con recall_memory y howto_ids lees el texto de los howtos que te sirvan:\n" +
            toText(mem)
        : "Es tu primera misión: todavía no tienes memoria.",
      "",
    );
  }

  // Qué estrategias encajan con esta misión (objetivo y tiempo), con datos reales.
  const fit =
    mission.status === "active"
      ? await import("./fit.js")
          .then(({ strategyFit }) => strategyFit(mission))
          .then((f) => `Encaje de estrategias (falta +${f.needPct} % en ${f.minutesLeft} min; detalle con strategy_fit):\n` + toText(f.strategies.map(({ basis: _b, ...r }) => r)))
          .catch(() => "")
      : "";

  return [
    header,
    "",
    "Misión:",
    toText(await missionStatus(missionId)),
    "",
    ...(fit ? [fit, ""] : []),
    ...memoryLines,
    "Cartera:",
    toText(portfolio),
    "",
    notes.length ? "Tus notas:\n" + notes.map((n) => `- (id ${n.id}, ${n.ts}) ${n.text}`).join("\n") : "No tienes notas guardadas.",
    "",
    openOrders.length ? "Órdenes condicionales abiertas:\n" + toText(openOrders) : "No tienes órdenes condicionales abiertas.",
    "",
    recent.length
      ? "Últimas entradas del diario:\n" + recent.reverse().map((j) => `- ${j.ts} [${j.kind}] ${j.summary}`).join("\n")
      : "El diario está vacío: es tu primera sesión.",
  ].join("\n");
}

/**
 * Briefing de una misión rápida (15 min o menos): solo el reloj, el plan y la cartera (y las órdenes abiertas, si
 * hay). Sin el resumen de memoria ni recalcular strategy_fit: lo pensó el cerebro antes del reloj, y cada token de
 * más se relee en cada turno con el reloj corriendo.
 */
async function fastBriefing(header: string, mission: Mission): Promise<string> {
  const plan = planForMission(mission.id);
  const openOrders = listOrders(mission.id, "open");
  return [
    header,
    "",
    "Misión rápida:",
    toText(await missionStatus(mission.id)),
    "",
    plan
      ? `Plan vigente (cítalo con plan_ref: ${plan.id}):\n${toText(describePlan(plan))}`
      : `No hay plan vigente para ${mission.class ?? "esta clase"}: lo escribe el planner con write_plan antes del reloj.`,
    "",
    "Cartera:",
    toText(await valuation(mission.id, true)),
    ...(openOrders.length ? ["", "Órdenes condicionales abiertas:\n" + toText(openOrders)] : []),
  ].join("\n");
}

export async function endSession(sessionId: number, missionId: number | null, finalText: string, tokens?: { input: number; output: number }) {
  const end = missionId !== null ? await valuation(missionId, true) : null;
  db.prepare("UPDATE sessions SET ended_at = ?, final_text = ?, input_tokens = ?, output_tokens = ? WHERE id = ?").run(
    now(),
    finalText,
    tokens?.input ?? 0,
    tokens?.output ?? 0,
    sessionId,
  );
  return end;
}
