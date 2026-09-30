// Modo de costes de una misión simulada (create_mission con costs): 'sim', los de siempre, o 'real', los que paga de
// verdad una cartera de Solana al operar un memecoin recién graduado:
// - fee con prioridad en cada transacción (0,00075 SOL, frente a 0,0001);
// - la renta de la cuenta de un token nuevo (0,00203928 SOL) se paga al crearla y no vuelve al venderlo: la cuenta se
//   queda abierta a cero (Jupiter no la cierra), así que volver a recibir ese token no paga otra vez;
// - latencia: entre decidir con una cotización y que la transacción entre en un bloque pasan LATENCY_MS (2 s por
//   defecto). Se vuelve a cotizar y el swap se llena a esa cotización; si ha empeorado más que su slippage, revierte y
//   paga la red, como en la cadena. Una toma de beneficio salta con una cotización y solo se llena si la de después de
//   la latencia sigue llegando al límite (si no, sigue abierta).
// Se aplica a los swaps de Solana de la misión (la misión rápida opera ahí) y a su gemelo mecánico. Las misiones de un
// modo y del otro no se mezclan en las estadísticas por clase (class-stats.ts).
import { config } from "../config.js";
import { db } from "../db.js";
import type { CostProfile } from "./venues/types.js";

export const COST_MODES = ["sim", "real"] as const;
export type CostMode = (typeof COST_MODES)[number];

export const asCostMode = (v: unknown): CostMode => (v === "real" ? "real" : "sim");

export function costModeOf(missionId: number): CostMode {
  const row = db.prepare("SELECT cost_mode FROM missions WHERE id = ?").get(missionId) as { cost_mode?: string } | undefined;
  return asCostMode(row?.cost_mode);
}

/** Fee de red de una transacción de Solana según el modo de costes. */
export const solanaTxFee = (mode: CostMode) => (mode === "real" ? config.realSolanaTxFeeSol : config.solanaTxFeeSol);

/** Lo que tarda una transacción desde que se cotiza hasta que se ejecuta (ms): solo con costes realistas. */
export const latencyMs = (mode: CostMode) => (mode === "real" ? Math.max(0, config.latencyMs) : 0);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Los costes con los que se liquida un swap de Solana de la misión: undefined con los de siempre. Con los realistas, la
 * cuenta de un token existe si la cartera lo ha tenido alguna vez (su fila en holdings se queda a cero al venderlo).
 */
export function solanaCostProfile(missionId: number, mode = costModeOf(missionId)): CostProfile | undefined {
  if (mode !== "real") return undefined;
  const exists = db.prepare("SELECT 1 FROM holdings WHERE mission_id = ? AND venue = 'solana' AND asset = ?");
  return { networkFee: config.realSolanaTxFeeSol, rentRefund: false, hasAccount: (asset) => !!exists.get(missionId, asset) };
}

/** El modo de costes en una línea, para mission_status y status_report. */
export function describeCostMode(mode: CostMode): string {
  if (mode === "sim") return "sim: los de siempre (fee de 0,0001 SOL, la renta de la cuenta vuelve al venderlo todo, sin latencia)";
  return (
    `real: fee con prioridad de ${String(config.realSolanaTxFeeSol).replace(".", ",")} SOL por transacción, la renta de cada cuenta de token ` +
    `nueva no vuelve al venderlo y ${String(config.latencyMs / 1000).replace(".", ",")} s de latencia entre cotizar y ejecutar`
  );
}
