// La carrera del panel: la cifra grande, su variación y dónde va el corredor en la pista. Siempre de la misión que se
// enseña: una misión sin reloj todavía no ha operado, así que enseña su propio punto de partida (el capital inicial, la
// meta, «sin arrancar» y la pista vacía), nunca el resultado de la anterior ni una valoración de antes de la salida.
// heroModel es una función pura (se prueba sola); el panel la calcula en cada /api/state.

export interface HeroMission {
  id: number;
  status: string;
  started_at: string | null;
  initial_usd: number;
  target_usd: number;
  final_usd: number | null;
}

export interface HeroValuation {
  missionId: number;
  totalUsd: number;
  benchmarkUsd?: number | null;
}

export interface Hero {
  missionId: number;
  /**
   * prep: activa sin reloj (se prepara: plan, señal); live: en carrera con valoración; valuing: en carrera o terminada
   * sin valor que enseñar todavía; ended: terminada (o cerrando), con su resultado.
   */
  mode: "prep" | "live" | "valuing" | "ended";
  /** La cifra grande. Antes del reloj, el capital inicial; sin valoración, null. */
  valueUsd: number | null;
  /** Variación sobre el capital inicial, en %. Antes del reloj o sin valoración, null: no hay resultado. */
  deltaPct: number | null;
  /** Lo que falta para la meta (0 si ya está). */
  toGoUsd: number | null;
  /** Dónde va el corredor en la pista: el valor de ahora, o la salida si aún no hay. */
  runnerUsd: number;
  /** El fantasma (lo que valdría sin operar): solo en carrera. */
  benchmarkUsd: number | null;
  initialUsd: number;
  targetUsd: number;
}

export function heroModel(m: HeroMission, v: HeroValuation | null): Hero {
  // Una valoración de otra misión (la caché del panel justo después de crear otra) no vale para esta.
  const val = v && v.missionId === m.id ? v : null;
  const base = { missionId: m.id, initialUsd: m.initial_usd, targetUsd: m.target_usd };
  if (m.status === "active" && !m.started_at) {
    return { ...base, mode: "prep", valueUsd: m.initial_usd, deltaPct: null, toGoUsd: m.target_usd - m.initial_usd, runnerUsd: m.initial_usd, benchmarkUsd: null };
  }
  const live = m.status === "active";
  const value = live ? (val?.totalUsd ?? null) : (m.final_usd ?? val?.totalUsd ?? null);
  if (value === null) {
    return { ...base, mode: "valuing", valueUsd: null, deltaPct: null, toGoUsd: null, runnerUsd: m.initial_usd, benchmarkUsd: null };
  }
  return {
    ...base,
    mode: live ? "live" : "ended",
    valueUsd: value,
    deltaPct: ((value - m.initial_usd) / m.initial_usd) * 100,
    toGoUsd: Math.max(0, m.target_usd - value),
    runnerUsd: value,
    benchmarkUsd: live ? (val?.benchmarkUsd ?? null) : null,
  };
}
