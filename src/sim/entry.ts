// Entrada de una misión rápida en una sola llamada (enter_with_exits): comprar con todo el efectivo de la cadena y
// dejar puesta al momento la toma de beneficio. Es lo más parecido a una orden preparada que admite un memecoin: el
// token no se conoce hasta que llega el evento. Medido en las misiones anteriores: entre start_session y la primera
// operación pasaban 84-111 s, y cada minuto de retraso al entrar cuesta 3-4 puntos de P.
import { db, logJournal, now } from "../db.js";
import { fetchJsonAt } from "../market/http.js";
import { fichaAt, jupiterValues, parseSnapshot, snapshotFrom } from "./ficha.js";
import { getMission, minutesLeft, recordEntry, type ClockStart } from "./mission.js";
import { isFastMission, liftTakeProfit, restAtCloseUsd, takeProfitProceeds, TP_TARGET_MARGIN, type RestAfterSale } from "./mission-kind.js";
import { placeOrder } from "./orders.js";
import { balance, getHoldings, liquidationReserve, SlippageExceeded, swap, valuation, walletView } from "./portfolio.js";
import type { ChainId, TradeMeta } from "./types.js";
import { getChain, type TokenRef } from "./venues/index.js";

// El margen sobre el objetivo vive en mission-kind.ts: el gemelo mecánico pone la misma toma de beneficio.
export { TP_TARGET_MARGIN };

/**
 * El resto de la cartera (lo que no es el token) tal como quedará tras vender todo el token y al cerrar la misión: el
 * nativo de la cadena menos lo que cuesta la venta (su red y, si abre la cuenta del estable, la renta; si la cierra, lo que
 * vuelve), según los costes de la misión. Se calcula con las mismas reglas del monedero que aplicará la venta (settle).
 */
export function restAfterTakeProfit(a: {
  missionId: number;
  chainId: ChainId;
  token: TokenRef;
  stable: TokenRef;
  qty: number;
  v: Awaited<ReturnType<typeof valuation>>;
  tokenUsd: number;
  slippageBps: number;
}): RestAfterSale {
  const chain = getChain(a.chainId);
  const nativeLine = a.v.holdings.find((h) => h.venue === chain.id && h.asset === chain.native.address);
  const native = nativeLine?.amount ?? 0;
  const closeFeeNative = liquidationReserve(a.missionId, chain);
  let saleNative = -closeFeeNative;
  // En Solana, la venta se liquida en seco con las reglas del monedero (red, renta que se abre o vuelve). En las EVM, su
  // gas depende de la ruta cotizada: se cuenta como el de una transacción.
  if (chain.id === "solana") {
    const s = chain.settle(
      { chain: chain.id, input: a.token, output: a.stable, amountIn: a.qty, grossOut: 0, amountOut: 0, route: [], slippageBps: a.slippageBps, warnings: [] },
      walletView(a.missionId, chain.id),
    );
    if (s.ok) saleNative = s.deltas.filter((d) => d.asset === chain.native.address).reduce((t, d) => t + d.amount, 0);
  }
  return {
    otherUsd: a.v.totalUsd - a.tokenUsd - (nativeLine?.usd ?? 0),
    nativeAfterSale: native + saleNative,
    closeFeeNative,
    nativeUsd: native > 0 ? (nativeLine?.usd ?? 0) / native : 0,
  };
}

/**
 * La primera entrada del agente en una misión rápida (agent_entries): lo pagado, los tokens, el precio de la toma de
 * beneficio y su ficha (ficha.ts). La ficha es la de la señal de wait_for_signal si compró ese token (con su pool); si no,
 * se completa aparte con la búsqueda de Jupiter, sin hacer esperar al agente. Se mide hasta el plazo de la misión.
 * Solo en Solana: la medida con velas (candles.ts) busca el pool en la red solana de GeckoTerminal y en Jupiter, y los
 * gemelos son de Solana; una entrada en Base o BNB Chain no se podría medir (y gastaría peticiones con 404).
 */
export function recordAgentEntry(a: {
  missionId: number;
  chain: ChainId;
  token: TokenRef;
  usdIn: number;
  tokens: number;
  entryPrice: number;
  tpPrice?: number;
  enteredMs: number;
}): boolean {
  if (a.chain !== "solana") return false;
  const m = getMission(a.missionId);
  if (!m || !isFastMission(m) || !(a.tokens > 0) || !(a.usdIn > 0)) return false;
  const signal = m.signal_token === a.token.address ? parseSnapshot(m.signal_features) : null;
  const changed = db
    .prepare(
      `INSERT OR IGNORE INTO agent_entries (mission_id, token, symbol, pool, entered_at, horizon_end, usd_in, tokens, entry_price_usd, tp_price_usd, features)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      a.missionId,
      a.token.address,
      a.token.symbol ?? null,
      signal?.pool ?? null,
      new Date(a.enteredMs).toISOString(),
      m.deadline,
      a.usdIn,
      a.tokens,
      a.entryPrice,
      a.tpPrice ?? null,
      signal ? JSON.stringify(fichaAt(signal, a.enteredMs, "señal")) : null,
    ).changes;
  if (changed && !signal) void completeAgentFicha(a.missionId, a.token.address, a.enteredMs).catch(() => undefined);
  return changed > 0;
}

/**
 * Ficha de una entrada del agente sin señal (compró otro token que el de wait_for_signal): la búsqueda de Jupiter, que la
 * compra suele dejar en caché, por el carril de baja prioridad. Con ella llega también el pool (graduatedPool).
 */
export async function completeAgentFicha(missionId: number, mint: string, enteredMs: number) {
  const { data: list, atMs } = await fetchJsonAt<Array<Record<string, any>>>(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, {
    timeoutMs: 15_000,
    ttlMs: 30_000,
    lowPriority: true,
  });
  const jupiter = jupiterValues(list.find((t) => t.id === mint));
  const snap = snapshotFrom({ capturedAtMs: Date.now(), jupiter, jupiterAtMs: atMs });
  db.prepare("UPDATE agent_entries SET features = ?, pool = COALESCE(pool, ?) WHERE mission_id = ? AND features IS NULL").run(
    JSON.stringify(fichaAt(snap, enteredMs, "jupiter (tras la compra)")),
    snap.pool ?? null,
    missionId,
  );
}

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
 * Tokens descartados en una misión: su compra de enter_with_exits revirtió porque el precio se movió más que el slippage.
 * wait_for_signal no los vuelve a ofrecer y enter_with_exits no los compra: en la M18 (costes reales) la compra de un
 * candidato revirtió dos veces con el precio moviéndose un 12 % en la latencia, a la tercera se forzó subiendo el slippage
 * al 25 % y el token cayó un 79 %. Un precio que se mueve así de rápido es justo de lo que protege la reversión.
 */
export function excludedTokens(missionId: number): string[] {
  return (db.prepare("SELECT token FROM entry_exclusions WHERE mission_id = ? ORDER BY ts").all(missionId) as Array<{ token: string }>).map((r) => r.token);
}

export function entryExclusion(missionId: number, token: string): { ts: string; reason: string } | undefined {
  return db.prepare("SELECT ts, reason FROM entry_exclusions WHERE mission_id = ? AND token = ?").get(missionId, token) as { ts: string; reason: string } | undefined;
}

export function excludeFromEntry(missionId: number, token: string, reason: string) {
  db.prepare("INSERT OR IGNORE INTO entry_exclusions (mission_id, token, ts, reason) VALUES (?, ?, ?, ?)").run(missionId, token, now(), reason);
}

/** La compra de enter_with_exits, ya llenada: con ella arranca el reloj si no corría (runTool, ToolDef.entry). */
export interface EntryFill {
  buy: Awaited<ReturnType<typeof swap>>;
  token: TokenRef;
  stable: TokenRef;
  /** Lo pagado, en el estable. */
  amount: number;
  /** Los tokens que ha dado la compra. */
  bought: number;
  entryPrice: number;
  /** Con qué arranca el reloj: la hora en que se llenó la compra y la cartera de justo antes (para el gemelo). */
  clock: ClockStart & { atMs: number };
}

/**
 * La compra de enter_with_exits. Es la única operación que se admite antes del reloj, y solo dentro de esa herramienta:
 * el reloj arranca cuando se llena (runTool), así que si falla no queda nada (ni reloj, ni sesión, ni gemelo, ni plan
 * asignado). Si revierte porque el precio se ha movido más que el slippage (costes reales: en los 2 s de latencia), el
 * token queda descartado en la misión y el error lo explica.
 */
export async function buyEntry(a: {
  missionId: number;
  sessionId: number | null;
  chain: ChainId;
  token: TokenRef;
  stable: TokenRef;
  amount: number;
  slippageBps: number;
  reasoning: string;
  meta?: TradeMeta;
}): Promise<EntryFill> {
  const chain = getChain(a.chain);
  const clockRunning = !!getMission(a.missionId)?.started_at;
  const walletBefore = getHoldings(a.missionId);
  const before = balance(a.missionId, chain.id, a.token.address);
  let buy: Awaited<ReturnType<typeof swap>>;
  try {
    buy = await swap({
      missionId: a.missionId,
      sessionId: a.sessionId,
      chain: chain.id,
      input: a.stable.address,
      output: a.token.address,
      amount: a.amount,
      slippageBps: a.slippageBps,
      reasoning: a.reasoning,
      meta: a.meta,
    });
  } catch (err) {
    if (!(err instanceof SlippageExceeded)) throw err;
    const sym = a.token.symbol ?? a.token.address;
    const pct = err.worsePct.toFixed(1);
    const during = err.latencyMs > 0 ? `durante los ${err.latencyMs / 1000} s de latencia entre cotizar y ejecutar` : "desde tu última cotización";
    const why = `el precio se ha movido en tu contra un ${pct} % ${during} (la compra daba un ${pct} % menos de ${sym}), más que tu slippage del ${err.slippageBps / 100} %`;
    excludeFromEntry(a.missionId, a.token.address, `la compra revirtió: ${why}`);
    throw new Error(
      `La compra de ${sym} ha revertido${clockRunning ? "" : " y el reloj no ha arrancado"}: ${why}. ` +
        `No se ha comprado nada; solo has pagado la red (${Number(err.burnedNative.toPrecision(3))} ${err.nativeSymbol}). ` +
        `${sym} queda descartado en esta misión: wait_for_signal no te lo volverá a dar y enter_with_exits no lo compra. ` +
        "No lo reintentes ni subas el slippage: un precio que se mueve así de rápido es justo de lo que te protege la reversión. " +
        (clockRunning ? "Si aún te queda reloj, vuelve a wait_for_signal." : "Vuelve a wait_for_signal: el reloj sigue parado."),
    );
  }
  const filledAtMs = Date.now();
  const bought = balance(a.missionId, chain.id, a.token.address) - before;
  recordEntry(a.missionId, a.token.address);
  return {
    buy,
    token: a.token,
    stable: a.stable,
    amount: a.amount,
    bought,
    entryPrice: a.amount / bought,
    clock: { atMs: filledAtMs, walletBefore, cause: `con la compra de ${a.token.symbol ?? a.token.address} (enter_with_exits)` },
  };
}

/**
 * Tras la compra (y con el reloj ya en marcha), la toma de beneficio: una orden límite que vende todo el saldo del token
 * a un precio fijo. El precio sale de tpRatio (× el precio de compra) o, sin él, del objetivo de la misión: el que, al
 * venderlo todo, deja la cartera en el objetivo neto de costes (con lo demás que tenga, gas incluido). Si la orden no se
 * puede poner, la compra queda hecha y la respuesta lo dice.
 */
export async function placeExits(a: {
  missionId: number;
  sessionId: number | null;
  chain: ChainId;
  fill: EntryFill;
  tpRatio?: number;
  /** De dónde sale tpRatio (para la respuesta y el diario): 'parámetro' o 'plan #N'. */
  tpRatioFrom?: string;
  slippageBps: number;
  reasoning: string;
}) {
  const chain = getChain(a.chain);
  const { token, stable, amount, bought, entryPrice, buy } = a.fill;
  const enteredMs = a.fill.clock.atMs;
  const qty = balance(a.missionId, chain.id, token.address);

  // Lo que vale ahora cada parte de la cartera (el token, a precio de venta real con esa cantidad).
  const mission = getMission(a.missionId)!;
  const v = await valuation(a.missionId);
  const tokenUsd = v.holdings.find((h) => h.venue === chain.id && h.asset === token.address)?.usd ?? 0;
  const sellPrice = qty > 0 ? tokenUsd / qty : 0;
  // El resto de la cartera tal como quedará al cerrar: la toma de beneficio en el objetivo tiene que dejarlo cumplido de
  // verdad, con la red de la venta pagada y el gas valorado a la baja (mission-kind.ts, takeProfitProceeds).
  const rest = restAfterTakeProfit({ missionId: a.missionId, chainId: chain.id, token, stable, qty, v, tokenUsd, slippageBps: a.slippageBps });
  const fromTarget = a.tpRatio === undefined;
  const lift = fromTarget ? undefined : liftTakeProfit({ ratioProceeds: entryPrice * a.tpRatio! * qty, targetUsd: mission.target_usd, rest });
  const lifted = lift?.liftedFromUsd !== undefined;
  const triggerPrice = fromTarget || lifted ? takeProfitProceeds(mission.target_usd, rest) / qty : entryPrice * a.tpRatio!;
  const ratioBasis = `×${a.tpRatio} del precio de compra (${a.tpRatioFrom ?? "parámetro"})`;
  const basis = fromTarget
    ? "el objetivo de la misión, neto de costes"
    : lifted
      ? `el objetivo de la misión, neto de costes: con ${ratioBasis}, al saltar la cartera se quedaba en ${lift!.liftedFromUsd!.toFixed(2)} $, por debajo del objetivo`
      : ratioBasis;
  // Lo que valdrá como mínimo la cartera si salta: la venta más el resto, con el gas valorado a la baja.
  const leavesAtLeastUsd = triggerPrice * qty + restAtCloseUsd(rest);

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
      // Si salta: la cartera con el gas ya convertido y su precio un 0,5 % más bajo. Por debajo del objetivo, no lo cumple.
      leavesAtLeastUsd: Number(leavesAtLeastUsd.toFixed(2)),
      ...(leavesAtLeastUsd < mission.target_usd ? { belowTarget: `si salta, la cartera se queda por debajo del objetivo (${mission.target_usd} $)` } : {}),
    };
  } catch (err) {
    const message = (err as Error).message;
    logJournal({ missionId: a.missionId, sessionId: a.sessionId, kind: "rejected", summary: `enter_with_exits: la toma de beneficio no se pudo poner: ${message}` });
    takeProfit = {
      error: `La toma de beneficio NO se ha puesto (${message}). La compra sí está hecha: ponla con place_swap_trigger_order si sigue haciendo falta, con este triggerPrice.`,
      triggerPrice,
      basis,
    };
  }

  // Misión rápida: la entrada queda para medirla con velas como a los gemelos (candles.ts), con su ficha.
  recordAgentEntry({ missionId: a.missionId, chain: chain.id, token, usdIn: amount, tokens: bought, entryPrice, tpPrice: triggerPrice, enteredMs });

  const after = getMission(a.missionId)!;
  return {
    clock: after.started_at ? { startedAt: after.started_at, deadline: after.deadline, minutesLeft: Number(minutesLeft(after).toFixed(1)) } : undefined,
    buy,
    tokensBought: bought,
    entryPrice,
    takeProfit,
    mission: { valueUsd: v.totalUsd, targetUsd: mission.target_usd },
  };
}
