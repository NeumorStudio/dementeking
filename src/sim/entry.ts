// Entrada de una misión rápida en una sola llamada (enter_with_exits): comprar con todo el efectivo de la cadena y
// dejar puesta al momento la toma de beneficio. Es lo más parecido a una orden preparada que admite un memecoin: el
// token no se conoce hasta que llega el evento. Medido en las misiones anteriores: entre start_session y la primera
// operación pasaban 84-111 s, y cada minuto de retraso al entrar cuesta 3-4 puntos de P.
import { logJournal } from "../db.js";
import { getMission, minutesLeft } from "./mission.js";
import { TP_TARGET_MARGIN } from "./mission-kind.js";
import { placeOrder } from "./orders.js";
import { balance, swap, valuation } from "./portfolio.js";
import type { ChainId, TradeMeta } from "./types.js";
import { getChain } from "./venues/index.js";

// El margen sobre el objetivo vive en mission-kind.ts: el gemelo mecánico pone la misma toma de beneficio.
export { TP_TARGET_MARGIN };

/**
 * El efectivo con el que se entra: el estable de la cadena con más saldo, entero o el importe pedido. Con upTo (el
 * importe fijo de un plan), como mucho eso, recortado a lo que haya: el plan no sabe el capital de cada misión de su
 * clase, y el gemelo mecánico recorta igual.
 */
export function entryCash(missionId: number, chainId: ChainId, usdAmount?: number, upTo?: number) {
  const chain = getChain(chainId);
  const [stable, have] = chain.stables.map((s) => [s, balance(missionId, chain.id, s.address)] as const).sort((a, b) => b[1] - a[1])[0]!;
  const amount = usdAmount ?? Math.min(upTo ?? have, have);
  if (!(have >= 1)) throw new Error(`No tienes efectivo en ${chain.label} para entrar (el nativo se queda para pagar la red)`);
  if (amount > have * 1.000001) throw new Error(`Solo tienes ${Number(have.toFixed(2))} ${stable.symbol} en ${chain.label}: usd_amount no puede pasar de ahí`);
  return { stable, amount: Math.min(amount, have) };
}

/**
 * Lo que enter_with_exits comprueba antes de arrancar el reloj, sin operar: el efectivo, el token (que exista y no sea
 * el efectivo ni el nativo) y una cotización de comprarlo y venderlo al momento. Si la venta inmediata devuelve menos
 * de lo que deja maxRoundTripCostPct, no se entra: es un pool vaciado o sin liquidez, y la misión se perdería en la
 * entrada (en una prueba en vivo, 48,50 $ → 1,34 $ y una toma de beneficio que pedía un +4.453 %).
 */
export async function prepareEntry(a: {
  missionId: number;
  chain: ChainId;
  token: string;
  usdAmount?: number;
  /** Importe fijo del plan: se recorta al efectivo que haya. */
  planUsdAmount?: number;
  slippageBps: number;
  maxRoundTripCostPct: number;
}) {
  const chain = getChain(a.chain);
  const { stable, amount } = entryCash(a.missionId, chain.id, a.usdAmount, a.planUsdAmount);
  const token = await chain.resolveToken(a.token);
  if (chain.isCash(token.address) || token.address === chain.native.address) {
    throw new Error("enter_with_exits compra un token: ni el efectivo ni el nativo de la cadena");
  }
  let backUsd: number;
  try {
    const buy = await chain.quote({ input: stable, output: token, amountIn: amount, slippageBps: a.slippageBps });
    if (!(buy.amountOut > 0)) throw new Error("la compra no da tokens");
    backUsd = (await chain.quote({ input: token, output: stable, amountIn: buy.amountOut, slippageBps: a.slippageBps })).amountOut;
  } catch (err) {
    throw new Error(`No hay cotización de compra y venta de ${token.symbol} en ${chain.label} (${(err as Error).message.slice(0, 160)}): no se entra`);
  }
  const roundTripCostPct = (1 - backUsd / amount) * 100;
  if (roundTripCostPct > a.maxRoundTripCostPct) {
    throw new Error(
      `Comprar ${Number(amount.toFixed(2))} ${stable.symbol} de ${token.symbol} y venderlo al momento devolvería ${Number(backUsd.toFixed(2))} ${stable.symbol}: ` +
        `una ida y vuelta del ${roundTripCostPct.toFixed(1)} %, por encima del ${a.maxRoundTripCostPct} % (pool vaciado o sin liquidez). No se entra: espera al siguiente candidato`,
    );
  }
  return { stable, amount, token, roundTrip: { backUsd, costPct: Number(roundTripCostPct.toFixed(2)) } };
}

/**
 * Compra el token y pone la toma de beneficio: una orden límite que vende todo el saldo del token a un precio fijo.
 * El precio sale de tpRatio (× el precio de compra) o, sin él, del objetivo de la misión: el que, al venderlo todo,
 * deja la cartera en el objetivo neto de costes (con lo demás que tenga, gas incluido). Si la orden no se puede poner,
 * la compra queda hecha y la respuesta lo dice.
 */
export async function enterWithExits(a: {
  missionId: number;
  sessionId: number | null;
  chain: ChainId;
  token: string;
  usdAmount?: number;
  tpRatio?: number;
  /** De dónde sale tpRatio (para la respuesta y el diario): 'parámetro' o 'plan #N'. */
  tpRatioFrom?: string;
  slippageBps: number;
  reasoning: string;
  meta?: TradeMeta;
}) {
  const chain = getChain(a.chain);
  const token = await chain.resolveToken(a.token);
  if (chain.isCash(token.address) || token.address === chain.native.address) {
    throw new Error("enter_with_exits compra un token: ni el efectivo ni el nativo de la cadena");
  }
  const { stable, amount } = entryCash(a.missionId, chain.id, a.usdAmount);
  const before = balance(a.missionId, chain.id, token.address);
  const buy = await swap({
    missionId: a.missionId,
    sessionId: a.sessionId,
    chain: chain.id,
    input: stable.address,
    output: token.address,
    amount,
    slippageBps: a.slippageBps,
    reasoning: a.reasoning,
    meta: a.meta,
  });
  const qty = balance(a.missionId, chain.id, token.address);
  const bought = qty - before;
  const entryPrice = amount / bought;

  // Lo que vale ahora cada parte de la cartera (el token, a precio de venta real con esa cantidad).
  const mission = getMission(a.missionId)!;
  const v = await valuation(a.missionId);
  const tokenUsd = v.holdings.find((h) => h.venue === chain.id && h.asset === token.address)?.usd ?? 0;
  const sellPrice = qty > 0 ? tokenUsd / qty : 0;
  const fromTarget = a.tpRatio === undefined;
  const triggerPrice = fromTarget ? (mission.target_usd * (1 + TP_TARGET_MARGIN) - (v.totalUsd - tokenUsd)) / qty : entryPrice * a.tpRatio!;
  const basis = fromTarget ? "el objetivo de la misión, neto de costes" : `×${a.tpRatio} del precio de compra (${a.tpRatioFrom ?? "parámetro"})`;

  let takeProfit: Record<string, unknown>;
  try {
    const order = await placeOrder({
      missionId: a.missionId,
      sessionId: a.sessionId,
      venue: chain.id,
      triggerAsset: token.address,
      condition: "above",
      triggerPrice,
      action: { input: token.address, output: stable.symbol, amount: 0, sellAll: true, slippageBps: a.slippageBps },
      reasoning: `Toma de beneficio de enter_with_exits: ${basis}.\n${a.reasoning}`,
    });
    takeProfit = {
      orderId: order.id,
      summary: order.summary,
      triggerPrice,
      basis,
      tpRatio: Number((triggerPrice / entryPrice).toFixed(4)),
      // Lo que tiene que subir el precio de venta de ahora (ya con el coste de ida y vuelta) para que salte.
      riseNeededPct: sellPrice > 0 ? (triggerPrice / sellPrice - 1) * 100 : undefined,
      sellsFor: `${Number((triggerPrice * qty).toFixed(2))} ${stable.symbol}`,
    };
  } catch (err) {
    const message = (err as Error).message;
    logJournal({ missionId: a.missionId, sessionId: a.sessionId, kind: "rejected", summary: `enter_with_exits: la toma de beneficio no se pudo poner: ${message}` });
    takeProfit = {
      error: `La toma de beneficio NO se ha puesto (${message}). La compra sí está hecha: ponla con place_swap_trigger_order si sigue haciendo falta.`,
    };
  }

  const now = getMission(a.missionId)!;
  return {
    clock: now.started_at ? { startedAt: now.started_at, deadline: now.deadline, minutesLeft: Number(minutesLeft(now).toFixed(1)) } : undefined,
    buy,
    tokensBought: bought,
    entryPrice,
    takeProfit,
    mission: { valueUsd: v.totalUsd, targetUsd: mission.target_usd },
  };
}
