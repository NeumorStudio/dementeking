// Seguimiento por clase de misión ('graduado-10m-+25%'): lo que necesita el revisor para contestar "¿aporta algo el
// agente?". Para cada clase: cuántas misiones y cuántas conseguidas (con su intervalo de Wilson al 95 %), la suma de las
// P que predijo el cerebro frente a los aciertos (calibración), la línea base de la tabla, los aciertos del gemelo
// mecánico medidos en la misma franja, y la comparación misión a misión con el gemelo.
// Las misiones con costes realistas (costs.ts) son otra serie: cada clase se agrupa también por su modo de costes, y las
// dos nunca se mezclan (con fee con prioridad, renta sin devolver y latencia, la toma de beneficio queda más lejos).
// Con menos de MIN_MISSIONS_FOR_VERDICT misiones por clase no se saca ninguna conclusión: 7 de 20 deja un intervalo
// del 18 al 57 %, y con P = 35 % ver 3 aciertos seguidos en 50 misiones pasa el 78 % de las veces por puro azar.
import { db } from "../db.js";
import { baselineForClass } from "./baselines.js";
import { asCostMode, type CostMode } from "./costs.js";
import { wilson } from "./stats.js";

/** Misiones por clase antes de sacar conclusiones (y de cambiar reglas): un bloque de plan. */
export const MIN_MISSIONS_FOR_VERDICT = 20;

interface Row {
  id: number;
  class: string;
  status: "succeeded" | "expired" | "bust";
  initial_usd: number;
  final_usd: number | null;
  predicted_p: number | null;
  baseline_p: number | null;
  plan_id: number | null;
  shadow_hits: number | null;
  shadow_return: number | null;
  ended_at: string | null;
  cost_mode: string | null;
}

const pct1 = (x: number) => Number((x * 100).toFixed(1));
const num = (x: number, d = 1) => String(Number(x.toFixed(d))).replace(".", ",");
const rate = (k: number, n: number) => {
  const ci = wilson(k, n);
  return { text: `${k} de ${n} (${n ? Math.round((k / n) * 100) : 0} %; IC95 ${ci.low}-${ci.high} %)`, ci95Pct: [ci.low, ci.high] as [number, number] };
};

/**
 * Tasa del gemelo por misión: la media de aciertos/terminados de cada misión, con el intervalo de Wilson sobre las
 * misiones (n = misiones). El texto dice también los gemelos que hay detrás.
 */
const missionRate = (meanRate: number, missions: number, hits: number, twinsDone: number) => {
  const ci = wilson(meanRate * missions, missions);
  return {
    text:
      `${Math.round(meanRate * 100)} % de media por misión en ${missions} misiones (${hits} de ${twinsDone} gemelos); ` +
      `IC95 ${ci.low}-${ci.high} % con n = misiones`,
    ci95Pct: [ci.low, ci.high] as [number, number],
  };
};

/** El gemelo de cada misión: cuántos terminados, cuántos aciertos y si sigue en curso (shadow.ts). */
export function twinCounts() {
  const rows = db
    .prepare(
      `SELECT r.mission_id, r.status AS run_status,
              COALESCE(SUM(p.status IN ('hit', 'expired')), 0) AS done,
              COALESCE(SUM(p.status = 'hit'), 0) AS hits,
              COALESCE(SUM(p.status = 'open'), 0) AS open,
              COALESCE(SUM(p.status = 'abandoned'), 0) AS dropped
       FROM shadow_runs r LEFT JOIN shadow_positions p ON p.mission_id = r.mission_id
       GROUP BY r.mission_id`,
    )
    .all() as Array<{ mission_id: number; run_status: string; done: number; hits: number; open: number; dropped: number }>;
  return new Map(rows.map((r) => [r.mission_id, r]));
}

/**
 * Una fila por misión con lo que hace falta para compararla con su predicción y con su gemelo. Lo usan missionHistory
 * (mission.ts), recentApproach (memory.ts) y las estadísticas de su clase.
 */
export function missionComparison(
  m: Pick<Row, "id" | "initial_usd" | "final_usd" | "predicted_p" | "baseline_p" | "plan_id" | "shadow_hits" | "shadow_return"> & { status: string },
  twins = twinCounts(),
) {
  const t = twins.get(m.id);
  const resultPct = m.final_usd === null ? null : pct1((m.final_usd - m.initial_usd) / m.initial_usd);
  const twinReturnPct = m.shadow_return === null ? null : pct1(m.shadow_return);
  const twin =
    m.shadow_hits !== null && t
      ? `${m.shadow_hits} de ${t.done}`
      : t?.run_status === "running"
        ? `en curso (${t.done} terminados, ${t.open} abiertos)`
        : t?.run_status === "done"
          ? t.dropped
            ? "sin gemelos observados hasta el final de su plazo"
            : "sin eventos en su plazo"
          : t?.run_status === "abandoned"
            ? "abandonado"
            : "sin gemelo";
  return {
    ...(m.plan_id !== null ? { planId: m.plan_id } : {}),
    hit: m.status === "succeeded",
    resultPct,
    ...(m.predicted_p !== null ? { predictedPct: pct1(m.predicted_p) } : {}),
    ...(m.baseline_p !== null ? { baselinePct: pct1(m.baseline_p) } : {}),
    twin,
    ...(twinReturnPct !== null ? { twinReturnPct } : {}),
    // Puntos de resultado del agente por encima (o por debajo) del gemelo, sobre el capital de la misión.
    ...(twinReturnPct !== null && resultPct !== null ? { vsTwinPoints: Number((resultPct - twinReturnPct).toFixed(1)) } : {}),
  };
}

/**
 * Estadísticas por clase y modo de costes de las misiones jugadas hasta el final (conseguidas, por tiempo o en
 * bancarrota; las canceladas no cuentan). Con cls, solo esa clase; con costMode, solo ese modo. perMissionLimit recorta
 * la lista misión a misión (las últimas).
 */
export function classStats(opts: { cls?: string | null; costMode?: CostMode | null; perMissionLimit?: number } = {}) {
  const rows = db
    .prepare(
      `SELECT id, class, status, initial_usd, final_usd, predicted_p, baseline_p, plan_id, shadow_hits, shadow_return, ended_at, cost_mode
       FROM missions
       WHERE status IN ('succeeded', 'expired', 'bust') AND class IS NOT NULL AND started_at IS NOT NULL ${opts.cls ? "AND class = ?" : ""}
       ORDER BY id`,
    )
    .all(...(opts.cls ? [opts.cls] : [])) as unknown as Row[];
  const twins = twinCounts();
  // Una serie por clase y modo de costes: las de costes realistas no se mezclan con las de siempre.
  const groups = new Map<string, { cls: string; costs: CostMode; ms: Row[] }>();
  for (const r of rows) {
    const costs = asCostMode(r.cost_mode);
    if (opts.costMode && costs !== opts.costMode) continue;
    const key = `${r.class}|${costs}`;
    const g = groups.get(key) ?? { cls: r.class, costs, ms: [] };
    g.ms.push(r);
    groups.set(key, g);
  }

  return [...groups.values()].map(({ cls, costs, ms }) => {
    const n = ms.length;
    const hits = ms.filter((m) => m.status === "succeeded").length;
    const agent = rate(hits, n);

    // Calibración: con las misiones que tenían P predicha (un plan), la suma de P es el número de aciertos esperado.
    const predicted = ms.filter((m) => m.predicted_p !== null);
    const expected = predicted.reduce((s, m) => s + m.predicted_p!, 0);
    const predictedHits = predicted.filter((m) => m.status === "succeeded").length;
    const withBaseline = ms.filter((m) => m.baseline_p !== null);
    const baselineExpected = withBaseline.reduce((s, m) => s + m.baseline_p!, 0);
    const table = baselineForClass(cls);

    // Gemelo: solo las misiones cuyo gemelo ha terminado con algún evento. Los gemelos de una misión caen en la misma
    // franja y comparten régimen (para eso están), así que no son independientes: su tasa es la media por misión de
    // aciertos/terminados, y su intervalo va con n = misiones, no con n = gemelos (saldría ~√3 más estrecho y
    // "los intervalos no se solapan" llegaría demasiado pronto).
    const withTwin = ms.filter((m) => m.shadow_hits !== null && (twins.get(m.id)?.done ?? 0) > 0);
    const twinN = withTwin.reduce((s, m) => s + twins.get(m.id)!.done, 0);
    const twinHits = withTwin.reduce((s, m) => s + m.shadow_hits!, 0);
    const twinRates = withTwin.map((m) => m.shadow_hits! / twins.get(m.id)!.done);
    const twinMeanRate = twinRates.length ? twinRates.reduce((s, r) => s + r, 0) / twinRates.length : 0;
    const pending = ms.filter((m) => twins.get(m.id)?.run_status === "running").length;
    const twin = withTwin.length ? missionRate(twinMeanRate, withTwin.length, twinHits, twinN) : null;
    const agentOnTwinMissions = withTwin.length ? rate(withTwin.filter((m) => m.status === "succeeded").length, withTwin.length) : null;

    let vsTwin: string;
    if (!twin || !agentOnTwinMissions) vsTwin = pending ? "el gemelo aún no ha terminado" : "sin gemelo con el que comparar";
    else {
      const [aLo, aHi] = agentOnTwinMissions.ci95Pct;
      const [tLo, tHi] = twin.ci95Pct;
      vsTwin =
        `en las ${withTwin.length} misiones con gemelo, el agente ${agentOnTwinMissions.text} frente al gemelo ${twin.text}: ` +
        (aLo > tHi
          ? "el agente acierta más (los intervalos no se solapan)"
          : aHi < tLo
            ? "el agente acierta menos (los intervalos no se solapan)"
            : "los intervalos se solapan: con esta muestra no se distingue al agente del gemelo");
    }

    const limit = opts.perMissionLimit ?? n;
    return {
      class: cls,
      costs,
      missions: n,
      hits,
      hitRate: agent.text,
      ci95Pct: agent.ci95Pct,
      avgResultPct: pct1(ms.reduce((s, m) => s + (m.final_usd! - m.initial_usd) / m.initial_usd, 0) / n),
      calibration: predicted.length
        ? {
            missions: predicted.length,
            predictedHits: Number(expected.toFixed(1)),
            actualHits: predictedHits,
            reading: `el cerebro esperaba ${num(expected)} aciertos en ${predicted.length} misiones y hubo ${predictedHits}`,
          }
        : "ninguna misión con P predicha (sin plan)",
      baseline: {
        ...(table ? { tablePct: pct1(table.p), table: table.basis } : { table: "su mercado no está en la tabla medida" }),
        ...(withBaseline.length ? { expectedHits: Number(baselineExpected.toFixed(1)), reading: `la línea base esperaba ${num(baselineExpected)} aciertos en ${withBaseline.length} misiones y hubo ${withBaseline.filter((m) => m.status === "succeeded").length}` } : {}),
      },
      twin: twin
        ? {
            missions: withTwin.length,
            twins: twinN,
            hits: twinHits,
            meanRatePct: pct1(twinMeanRate),
            hitRate: twin.text,
            ci95Pct: twin.ci95Pct,
            avgReturnPct: pct1(withTwin.reduce((s, m) => s + m.shadow_return!, 0) / withTwin.length),
            ...(pending ? { pending } : {}),
          }
        : pending
          ? `${pending} gemelos aún en curso`
          : "sin gemelo",
      vsTwin,
      verdict:
        n < MIN_MISSIONS_FOR_VERDICT
          ? `${n} de ${MIN_MISSIONS_FOR_VERDICT} misiones: aún no se saca ninguna conclusión ni se cambian las reglas del bloque`
          : "muestra suficiente para un primer veredicto, solo si la diferencia es grande (×2); para mejoras moderadas hacen falta 50-130",
      perMission: ms.slice(-limit).map((m) => ({ missionId: m.id, ...missionComparison(m, twins) })),
    };
  });
}
