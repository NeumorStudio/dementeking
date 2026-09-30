// Freno en las compras: solo el que ha aprendido el agente. Rechaza un token que cumple una creencia negativa
// con evidencia fuerte (la escribe el revisor y la mide el simulador), y se puede saltar a sabiendas con
// thesis.overrides. No hay reglas fijas: un honeypot o un creador que ya le costó dinero son datos (el
// simulador hace que un honeypot no se pueda vender), y aprender de ellos es cosa de su memoria.
import type { ChainId } from "./types.js";
import type { TokenRef } from "./venues/types.js";
import { getChain } from "./venues/index.js";
import { blockingBeliefs } from "./memory.js";
import { creatorHistory, decisionContext } from "./positions.js";

export interface BeliefOverride {
  id: number;
  reason: string;
}

/**
 * Creencias negativas fuertes que frenarían comprar este token (sin contar las que se ignoran a sabiendas). La usan
 * checkBuyAgainstMemory y wait_for_signal, que no ofrece un candidato que la memoria va a rechazar al entrar.
 */
export async function memoryBlockers(a: {
  chain: ChainId;
  token: TokenRef;
  /** Para las creencias sobre cómo decide (tamaño, reentrada, tiempo): la misión y lo que se paga en USD. */
  missionId?: number;
  amountUsd?: number;
}) {
  const chain = getChain(a.chain);
  const features = await chain.entryFeatures(a.token.address).catch(() => null);
  if (!features) return [];
  const decision = a.missionId !== undefined ? decisionContext(a.missionId, chain.id, a.token.address, a.amountUsd ?? 0, false) : {};
  const entry = { ...features, ...creatorHistory(features.creator) } as unknown as Record<string, unknown>;
  return blockingBeliefs(chain.id, entry, a.token.address, decision);
}

/** Comprueba una compra (lo que se recibe no es efectivo ni el nativo). Lanza un error si hay que frenarla. */
export async function checkBuyAgainstMemory(a: {
  chain: ChainId;
  output: string;
  overrides?: BeliefOverride[];
  risksChecked?: string;
  /** Para las creencias sobre cómo decide (tamaño, reentrada, tiempo): la misión y lo que se paga. */
  missionId?: number;
  input?: string;
  amount?: number;
}): Promise<BeliefOverride[]> {
  const chain = getChain(a.chain);
  const out = await chain.resolveToken(a.output);
  if (chain.isCash(out.address) || out.address === chain.native.address) return [];
  // Checklist previo: antes de comprar, pensar en lo que puede salir mal (no solo en por qué entrar).
  if (!a.risksChecked || a.risksChecked.trim().length < 15) {
    throw new Error(
      `Antes de comprar ${out.symbol}, rellena thesis.risks_checked: qué creencias negativas de tu memoria podrían aplicar y qué dicen ` +
        "los datos de riskCheck en token_report, y por qué no descartan la compra.",
    );
  }
  const overridden = new Map((a.overrides ?? []).map((o) => [o.id, o]));
  // Lo que se paga en USD, si se paga con un estable (lo normal al comprar un memecoin).
  let amountUsd = 0;
  if (a.input && a.amount) {
    const input = await chain.resolveToken(a.input).catch(() => null);
    if (input && chain.isCash(input.address)) amountUsd = a.amount;
  }
  const blocking = (await memoryBlockers({ chain: chain.id, token: out, missionId: a.missionId, amountUsd })).filter((b) => !overridden.has(b.id));
  if (blocking.length) {
    const reasons = blocking.map((b) => `- #${b.id}: ${b.statement} (evidencia: ${b.verdict})`);
    throw new Error(
      `Tu memoria desaconseja esta compra de ${out.symbol}:\n${reasons.join("\n")}\n` +
        `Si aun así quieres comprarlo, repite la operación con thesis.overrides = [${blocking.map((b) => `{ id: ${b.id}, reason: "por qué esta vez es distinto" }`).join(", ")}].`,
    );
  }
  return [...overridden.values()];
}
