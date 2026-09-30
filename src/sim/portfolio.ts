// Cartera virtual. Todas las operaciones se calculan con datos de mercado reales
// en el momento de la llamada; nunca se firma ni se envía nada a una red real.
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { db, logJournal, now } from "../db.js";
import * as market from "../market/binance.js";
import { fetchJson, isTransientError } from "../market/http.js";
import { SOL_MINT, USDC_MINT } from "../market/jupiter.js";
import { costModeOf, latencyMs, sleep, solanaCostProfile, solanaTxFee } from "./costs.js";
import { NATIVE_DRIFT_MARGIN } from "./mission-kind.js";
import { recordTrade } from "./positions.js";
import { VENUES, type Allocation, type ChainId, type Holding, type TradeMeta, type VenueId } from "./types.js";
import { fillMarketOrder } from "./venues/binance.js";
import { allChains, binance, getChain, getVenue, type ChainAdapter, type CostLine, type Delta, type WalletView } from "./venues/index.js";

export type Venue = VenueId;
export type { Holding };

const DUST = 1e-12;

/** ¿La misión opera con dinero real? */
export function isLiveMission(missionId: number): boolean {
  return (db.prepare("SELECT mode FROM missions WHERE id = ?").get(missionId) as { mode?: string } | undefined)?.mode === "live";
}

export function assertSimulated(missionId: number, what: string) {
  if (isLiveMission(missionId)) {
    throw new Error(`Esta misión es REAL: ${what} no está disponible así. Con dinero real se opera con execute_swap (swaps) y execute_bridge (mover estables o el nativo entre cadenas); Binance no está disponible.`);
  }
}

export function getHoldings(missionId: number): Holding[] {
  return db
    .prepare("SELECT venue, asset, symbol, decimals, amount FROM holdings WHERE mission_id = ? AND amount > ? ORDER BY venue, symbol")
    .all(missionId, DUST) as unknown as Holding[];
}

export function balance(missionId: number, venue: Venue, asset: string): number {
  const row = db.prepare("SELECT amount FROM holdings WHERE mission_id = ? AND venue = ? AND asset = ?").get(missionId, venue, asset) as
    | { amount: number }
    | undefined;
  return row?.amount ?? 0;
}

function adjust(missionId: number, venue: Venue, asset: string, symbol: string, decimals: number, delta: number) {
  const next = balance(missionId, venue, asset) + delta;
  if (next < -DUST) throw new Error(`Saldo insuficiente de ${symbol} en ${venue}`);
  db.prepare(
    `INSERT INTO holdings (mission_id, venue, asset, symbol, decimals, amount) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(mission_id, venue, asset) DO UPDATE SET amount = excluded.amount`,
  ).run(missionId, venue, asset, symbol, decimals, Math.max(0, next));
}

/** Aplica varios movimientos de saldo de forma atómica. */
function applyAtomically(fn: () => void) {
  db.exec("SAVEPOINT apply");
  try {
    fn();
    db.exec("RELEASE apply");
  } catch (err) {
    db.exec("ROLLBACK TO apply");
    db.exec("RELEASE apply");
    throw err;
  }
}

/** El monedero de la misión en una cadena tal como lo ve settle: saldos, approvals y, con costes realistas, su perfil. */
export function walletView(missionId: number, chainId: ChainId): WalletView {
  return {
    balance: (asset) => balance(missionId, chainId, asset),
    approved: (asset) => Boolean(db.prepare("SELECT 1 FROM evm_approvals WHERE mission_id = ? AND chain = ? AND token = ?").get(missionId, chainId, asset)),
    ...(chainId === "solana" ? { profile: solanaCostProfile(missionId) } : {}),
  };
}

/** Nativo que se deja sin vender al liquidar: lo que cuesta esa última transacción (en Solana, según los costes de la misión). */
export function liquidationReserve(missionId: number, chain: ChainAdapter): number {
  return chain.id === "solana" ? solanaTxFee(costModeOf(missionId)) : chain.liquidationReserve;
}

/** Aplica cambios de saldo en un sitio de forma atómica (falla si alguno deja un saldo negativo). */
export function applyDeltas(missionId: number, venue: VenueId, deltas: Delta[]) {
  applyAtomically(() => {
    for (const d of deltas) if (d.amount !== 0) adjust(missionId, venue, d.asset, d.symbol, d.decimals, d.amount);
  });
}

export async function solUsdPrice(): Promise<number> {
  const info = await fetchJson<Array<Record<string, any>>>(`https://lite-api.jup.ag/tokens/v2/search?query=${SOL_MINT}`, 15_000, 30_000);
  const price = info.find((t) => t.id === SOL_MINT)?.usdPrice;
  if (typeof price !== "number") throw new Error("No se pudo obtener el precio de SOL");
  return price;
}

/** Comprueba un reparto: sitios conocidos, porcentajes no negativos que suman 100. */
export function validateAllocation(allocation: Allocation): Allocation {
  const clean: Allocation = {};
  for (const [venue, pct] of Object.entries(allocation)) {
    if (!VENUES.includes(venue as VenueId)) throw new Error(`Reparto: "${venue}" no existe. Disponibles: ${VENUES.join(", ")}`);
    if (!(typeof pct === "number" && pct >= 0)) throw new Error(`Reparto: el porcentaje de ${venue} debe ser un número positivo`);
    if (pct > 0) clean[venue as VenueId] = pct;
  }
  const total = Object.values(clean).reduce((t, x) => t + x, 0);
  if (Math.abs(total - 100) > 0.5) throw new Error(`Reparto: los porcentajes suman ${total} y deben sumar 100`);
  return clean;
}

/**
 * Cartera inicial según el reparto. En cada cadena, casi todo en su stablecoin y una parte en el
 * token nativo para pagar la red (un 3 % de lo asignado, entre el mínimo y el máximo de esa cadena,
 * y nunca más de la mitad). En Binance, todo en USDT. Puro: recibe los precios de los nativos.
 */
export function planPortfolio(initialUsd: number, allocation: Allocation, nativePrices: Partial<Record<ChainId, number>>): Holding[] {
  const holdings: Holding[] = [];
  for (const [venue, pct] of Object.entries(validateAllocation(allocation)) as Array<[VenueId, number]>) {
    const shareUsd = (initialUsd * pct) / 100;
    const v = getVenue(venue);
    if (v.kind === "cex") {
      holdings.push({ venue, asset: "USDT", symbol: "USDT", decimals: 8, amount: shareUsd });
      continue;
    }
    const price = nativePrices[v.id];
    if (!price) throw new Error(`Falta el precio de ${v.native.symbol} para preparar la cartera`);
    const gasUsd = Math.min(Math.max(shareUsd * 0.03, v.gasBudgetUsd.min), v.gasBudgetUsd.max, shareUsd * 0.5);
    const nativeAmount = Number((gasUsd / price).toFixed(9));
    holdings.push({ venue, asset: v.cash.address, symbol: v.cash.symbol, decimals: v.cash.decimals, amount: shareUsd - nativeAmount * price });
    holdings.push({ venue, asset: v.native.address, symbol: v.native.symbol, decimals: v.native.decimals, amount: nativeAmount });
  }
  return holdings;
}

/** Deja la cartera de la misión con los saldos indicados (los de planPortfolio). */
export function resetPortfolio(missionId: number, holdings: Holding[]) {
  applyAtomically(() => {
    db.prepare("DELETE FROM holdings WHERE mission_id = ?").run(missionId);
    for (const h of holdings) adjust(missionId, h.venue, h.asset, h.symbol, h.decimals, h.amount);
  });
}

/**
 * Cierra todas las posiciones a mercado con precios reales: en cada cadena, los tokens → su stablecoin
 * (conservando el nativo justo para pagar la red) y en Binance, los activos → USDC/USDT.
 * Devuelve lo que no se pudo vender.
 */
/**
 * Una venta del cierre que falla por la red o por el límite de peticiones (429) se reintenta: en la M2 de la
 * v0.35.2 un 429 dejó POND sin vender al acabar el plazo. Un fallo de otro tipo (sin ruta, saldo) no.
 */
async function withRetries<T>(fn: () => Promise<T>, attempts = 4, waitMs = LIQUIDATION_RETRY_MS): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isTransientError(err)) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
const LIQUIDATION_RETRY_MS = Number(process.env.LIQUIDATION_RETRY_MS ?? 20_000);

/**
 * Con costes realistas, una venta a mercado que revierte (el precio se movió más que su slippage durante la latencia) se
 * reenvía al momento, como se haría en la cadena; cada intento paga su red. Con los de siempre no hay latencia. Lo usan el
 * cierre (liquidateAll) y las órdenes que ejecutan a mercado (stops y órdenes por tiempo, orders.ts).
 */
export async function resending<T>(missionId: number, fn: () => Promise<T>, attempts = 3): Promise<T> {
  if (costModeOf(missionId) !== "real") return fn();
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !String((err as Error)?.message).startsWith("El swap revierte")) throw err;
    }
  }
}

/**
 * Vende todo a estables. Con `nativeOnly`, solo el nativo que quede (segundo paso de un cierre por objetivo);
 * con `keepNative`, todo menos el nativo (primer paso: si al final no se cierra, sigue habiendo gas).
 */
export async function liquidateAll(
  missionId: number,
  sessionId: number | null,
  reasoning: string,
  opts: {
    keepNative?: boolean;
    nativeOnly?: boolean;
    /**
     * Lo mínimo que tiene que dar la venta de cada token (`<cadena>:<token>` → su estable): el cierre por objetivo, para
     * que la venta no deje la misión por debajo. Si no llega (tampoco tras la latencia), no se vende ni se paga nada.
     */
    floors?: Map<string, number>;
  } = {},
): Promise<string[]> {
  // Primero los futuros: su margen vuelve como efectivo a su cadena.
  const { closeAllPerps } = await import("./perps.js");
  const problems: string[] = opts.nativeOnly ? [] : await closeAllPerps(missionId, reasoning);
  const holdings = getHoldings(missionId);
  const meta = { exitReason: reasoning };

  for (const chain of allChains()) {
    const tokens = opts.nativeOnly ? [] : holdings.filter((h) => h.venue === chain.id && !chain.isCash(h.asset) && h.asset !== chain.native.address);
    for (const h of tokens) {
      const floor = opts.floors?.get(`${chain.id}:${h.asset}`);
      const sell = () =>
        swap({ missionId, sessionId, chain: chain.id, input: h.asset, output: chain.cash.address, sellAll: true, slippageBps: 300, reasoning, meta, ...(floor !== undefined ? { minOut: floor } : {}) });
      // Con mínimo (el cierre por objetivo), un fallo no se reintenta aquí: la misión sigue con sus órdenes y se vuelve a
      // comprobar en la vuelta siguiente, en vez de quedarse cerrándose (y sin toma de beneficio) mientras espera.
      await (floor !== undefined ? sell() : withRetries(() => resending(missionId, sell))).catch((err) => problems.push(`${h.symbol} (${chain.label}): ${(err as Error).message}`));
    }
    // El nativo se vende al final, dejando lo necesario para la fee de esa última transacción.
    // Con dinero real no se vende: hace falta para pagar la red en las siguientes misiones.
    const nativeLeft = balance(missionId, chain.id, chain.native.address) - liquidationReserve(missionId, chain);
    if (nativeLeft > 0.000001 && !isLiveMission(missionId) && !opts.keepNative) {
      // La cantidad se calcula en cada intento: uno que revierte ya ha pagado su red.
      const sell = () => {
        const left = balance(missionId, chain.id, chain.native.address) - liquidationReserve(missionId, chain);
        const amount = Number(left.toFixed(chain.native.decimals));
        return swap({ missionId, sessionId, chain: chain.id, input: chain.native.address, output: chain.cash.address, amount, slippageBps: 100, reasoning, meta });
      };
      await withRetries(() => resending(missionId, sell)).catch((err) => problems.push(`${chain.native.symbol} (${chain.label}): ${(err as Error).message}`));
    }
  }

  for (const h of holdings.filter((h) => !opts.nativeOnly && h.venue === "binance" && !binance.isCash(h.asset))) {
    let sold = false;
    for (const quote of ["USDC", "USDT"]) {
      const symbol = `${h.asset}${quote}`;
      const info = await market.getSymbolInfo(symbol).catch(() => null);
      if (!info) continue;
      // Un resto por debajo del step del par no se puede vender (polvo): no es un problema de liquidación.
      if (balance(missionId, "binance", h.asset) < info.stepSize) {
        sold = true;
        break;
      }
      try {
        await binanceMarketOrder({ missionId, sessionId, symbol, side: "SELL", amount: balance(missionId, "binance", h.asset), reasoning, meta });
        sold = true;
        break;
      } catch {
        /* se prueba el siguiente par */
      }
    }
    if (!sold) problems.push(`${h.symbol} (Binance): sin par vendible a USDC/USDT`);
  }
  return problems;
}

/** Una línea de la valoración (valuation().holdings). */
type ValuedLine = { venue: string; asset: string; symbol: string; amount: number; usd: number };

/**
 * Lo que la valoración de una misión simulada cuenta de más frente a lo que quedará al cerrarla, con las mismas reglas
 * que la toma de beneficio en el objetivo (mission-kind.ts, restAtCloseUsd): cada token se vende pagando su red (en
 * Solana, liquidado en seco con las reglas del monedero y los costes de la misión: la renta que se abre o vuelve) y el
 * nativo que queda se convierte dejando la red de esa última venta, con su precio NATIVE_DRIFT_MARGIN más bajo. Con los
 * costes de siempre puede salir negativo: vender todo el token devuelve la renta de su cuenta. Con `sellTokens: false`,
 * solo la conversión del nativo (los tokens ya se han vendido).
 */
export function closingCostsUsd(missionId: number, holdings: ValuedLine[], opts: { sellTokens: boolean }): number {
  let cost = 0;
  for (const chain of allChains()) {
    const nativeLine = holdings.find((h) => h.venue === chain.id && h.asset === chain.native.address);
    if (!nativeLine || !(nativeLine.amount > 0)) continue;
    const price = nativeLine.usd / nativeLine.amount;
    let native = nativeLine.amount;
    if (opts.sellTokens) {
      // Los que valen algo: uno sin ruta de venta no se llega a enviar (no paga nada).
      const tokens = holdings.filter((h) => h.venue === chain.id && h.usd > 0 && !chain.isCash(h.asset) && h.asset !== chain.native.address);
      if (chain.id === "solana") {
        const bal = new Map(holdings.filter((h) => h.venue === chain.id).map((h) => [h.asset, h.amount]));
        const w: WalletView = { ...walletView(missionId, chain.id), balance: (a) => bal.get(a) ?? 0 };
        for (const t of tokens) {
          const input = { address: t.asset, symbol: t.symbol, decimals: 0 };
          const s = chain.settle({ chain: chain.id, input, output: chain.cash, amountIn: t.amount, grossOut: t.usd, amountOut: t.usd, route: [], slippageBps: 300, warnings: [] }, w);
          if (s.ok) for (const d of s.deltas) bal.set(d.asset, (bal.get(d.asset) ?? 0) + d.amount);
        }
        native = bal.get(chain.native.address) ?? 0;
      } else {
        // En las EVM, el gas de cada venta depende de la ruta: se cuenta como el de una transacción (como entry.ts).
        native -= tokens.length * chain.liquidationReserve;
      }
    }
    cost += nativeLine.usd - Math.max(0, native - liquidationReserve(missionId, chain)) * price * (1 - NATIVE_DRIFT_MARGIN);
  }
  return cost;
}

// ─── Swaps en cadenas (agregadores de DEX) ──────────────────────────────────

const describeCosts = (costs: CostLine[]) => costs.map((c) => `${c.kind}: ${Number(c.amount.toPrecision(6))} ${c.symbol}`);

/** Una orden límite que no se llena: no se ha enviado nada y sigue abierta (orders.ts). */
export class LimitNotFilled extends Error {}

/** El precio de ese momento no llega al fijado. */
export class LimitNotReached extends LimitNotFilled {
  constructor(readonly got: number, readonly min: number) {
    super(`El precio no llega al límite: saldrían ${got}, el límite pide ${min}`);
  }
}

/**
 * No hay cotización con la que comprobar el límite (Jupiter falla, tarda o no da ruta): como una orden límite real, que
 * solo se ejecuta si llega, no se envía nada. El gemelo mecánico hace lo mismo (shadow.ts).
 */
export class LimitUnquoted extends LimitNotFilled {
  constructor(err: unknown) {
    super(`sin cotización para comprobar el límite (${String((err as Error)?.message ?? err).slice(0, 160)})`);
  }
}

/**
 * Un swap a mercado que revierte porque la cotización de la ejecución da menos que la de referencia menos el slippage
 * (con costes realistas, la de antes de la latencia): el precio se ha movido en contra. Paga la red, como en la cadena.
 * enter_with_exits lo distingue de otros fallos: ese token queda descartado en la misión (entry.ts).
 */
export class SlippageExceeded extends Error {
  constructor(
    message: string,
    /** Cuánto peor ha salido que la referencia, en % (menos tokens o menos estable de los esperados). */
    readonly worsePct: number,
    readonly slippageBps: number,
    /** La latencia que pasó entre decidir y ejecutar (0 si la referencia era una cotización tuya). */
    readonly latencyMs: number,
    /** Lo que se pagó de red, en el nativo de la cadena. */
    readonly burnedNative: number,
    readonly nativeSymbol: string,
  ) {
    super(message);
  }
}

/**
 * La misión ya no está activa al ir a aplicar un swap (sustituida por otra, parada, cancelada por prep_timeout o
 * cerrándose): no se aplica nada, como una transacción que no se llega a enviar. Con costes realistas es fácil que pase
 * durante los 2 s de latencia; la compra de enter_with_exits, que va antes del reloj, no puede quedar en una misión cancelada.
 */
export class MissionNotActive extends Error {}

function missionState(missionId: number) {
  return db.prepare("SELECT status, end_reason FROM missions WHERE id = ?").get(missionId) as { status: string; end_reason: string | null } | undefined;
}

/**
 * Un swap solo se aplica a una misión activa; el cierre (status 'closing', liquidateAll) vende con swaps que ya empezaron
 * en ese estado. Si no, falla sin aplicar nada (MissionNotActive): p. ej. la misión se sustituyó, se paró o se canceló
 * mientras se cotizaba, durante la latencia o antes (en el preflight de enter_with_exits).
 */
function assertStillActive(missionId: number, startStatus: string | undefined) {
  const m = missionState(missionId);
  if (m?.status === "active" || (m?.status === "closing" && startStatus === "closing")) return;
  const why = m ? `${m.status}${m.end_reason ? `: ${m.end_reason}` : ""}` : "no existe";
  throw new MissionNotActive(
    `La misión #${missionId} ya no está activa (${why}): el swap no se ha enviado, así que no se ha comprado ni vendido nada ni se ha pagado la red`,
  );
}

/** fn en una transacción de escritura (BEGIN IMMEDIATE), o en la que ya esté abierta: nadie cambia la misión en medio. */
function inWriteTransaction<T>(fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export async function swap(args: {
  missionId: number;
  sessionId: number | null;
  chain: ChainId;
  input: string;
  output: string;
  /** Cantidad del token de entrada. Con `sellAll`, se vende todo el saldo. */
  amount?: number;
  sellAll?: boolean;
  slippageBps: number;
  reasoning: string;
  meta?: TradeMeta;
  /**
   * Mínimo que debe dar el swap (orden límite): si la cotización del momento da menos, no se ejecuta ni se
   * paga nada y se lanza LimitNotReached. Lo usan las tomas de beneficio de las órdenes condicionales.
   */
  minOut?: number;
  /**
   * Orden límite real (toma de beneficio): se llena exactamente a `minOut`, no al precio del pico. En las
   * órdenes límite de Jupiter recibes lo que fijaste; lo que el mercado dé por encima se lo queda quien la ejecuta.
   */
  fillAtLimit?: boolean;
}) {
  // Misión real: se ejecuta en la cadena con la cartera de la IA (firma el firmante, no este proceso).
  if (isLiveMission(args.missionId)) {
    const { liveSwap } = await import("../live/execute.js");
    return liveSwap(args);
  }
  const chain = getChain(args.chain);
  const m = args.missionId;
  // Si la misión deja de estar activa mientras se cotiza o durante la latencia, el swap no se aplica (assertStillActive).
  const startStatus = missionState(m)?.status;
  const [input, output] = await Promise.all([chain.resolveToken(args.input), chain.resolveToken(args.output)]);
  if (input.address === output.address) throw new Error("El token de entrada y salida son el mismo");

  const have = balance(m, chain.id, input.address);
  const amount = args.sellAll ? have : (args.amount ?? 0);
  if (!(amount > 0)) throw new Error(args.sellAll ? `No tienes ${input.symbol} en ${chain.label}` : "La cantidad debe ser positiva (o usa sell_all)");
  if (amount > have + DUST) throw new Error(`Saldo insuficiente: tienes ${have} ${input.symbol} y quieres vender ${amount}`);

  // Con un límite (minOut), una cotización que falla es una orden que no se llena: no se ha enviado nada (LimitUnquoted).
  const limitQuote = <T>(q: Promise<T>) => (args.minOut === undefined ? q : q.catch((err): never => { throw new LimitUnquoted(err); }));
  let quote = await limitQuote(chain.quote({ input, output, amountIn: amount, slippageBps: args.slippageBps }));
  if (args.minOut !== undefined && quote.amountOut < args.minOut) throw new LimitNotReached(quote.amountOut, args.minOut);
  // Costes realistas (costs.ts): la transacción no entra en el bloque al momento. Se decide con esta cotización, pasa la
  // latencia y se ejecuta a la de entonces: un swap a mercado, dentro de su slippage respecto a la primera (si no,
  // revierte más abajo); una toma de beneficio, solo si la nueva sigue llegando al límite (si no, o si esa cotización
  // falla, sigue abierta).
  let decided: { amountIn: number; amountOut: number; at: number } | undefined;
  const latency = chain.id === "solana" ? latencyMs(costModeOf(m)) : 0;
  if (latency > 0) {
    decided = { amountIn: amount, amountOut: quote.amountOut, at: Date.now() };
    await sleep(latency);
    quote = await limitQuote(chain.quote({ input, output, amountIn: amount, slippageBps: args.slippageBps, fresh: true }));
    if (args.minOut !== undefined && quote.amountOut < args.minOut) throw new LimitNotReached(quote.amountOut, args.minOut);
  }
  // Tras las esperas (cotizar, la latencia), la misión tiene que seguir activa: si la han sustituido, parado o cancelado,
  // no se envía nada (ni se paga la red). Se vuelve a mirar al aplicar, en la misma transacción (otro proceso puede cancelarla).
  assertStillActive(m, startStatus);
  if (args.fillAtLimit && args.minOut !== undefined && quote.amountOut > args.minOut) {
    const f = args.minOut / quote.amountOut;
    quote = { ...quote, amountOut: args.minOut, grossOut: quote.grossOut * f };
  }
  const settled = chain.settle(quote, walletView(m, chain.id));
  // Un approve enviado queda hecho aunque el swap después revierta.
  for (const token of settled.approvals ?? []) {
    db.prepare("INSERT OR IGNORE INTO evm_approvals (mission_id, chain, token, approved_at) VALUES (?, ?, ?, ?)").run(m, chain.id, token, now());
  }
  if (!settled.ok) {
    // Una transacción que falla en la cadena puede costar igualmente (gas quemado).
    if (settled.deltas.length) {
      applyDeltas(m, chain.id, settled.deltas);
      logJournal({
        missionId: m,
        sessionId: args.sessionId,
        kind: "failed_tx",
        summary: `Swap fallido en ${chain.label}: ${settled.error}`,
        reasoning: args.reasoning,
        details: { chain: chain.id, costs: describeCosts(settled.costs) },
      });
    }
    throw new Error(settled.error);
  }

  // Como al firmar la cotización que viste: si hace poco cotizaste este mismo swap, la ejecución no puede
  // salir peor que esa cotización menos tu slippage. Si sale peor, la transacción revierte y pagas la red.
  // Con costes realistas y sin cotización previa tuya, la referencia es la cotización con la que se decidió antes de la
  // latencia (una toma de beneficio no: la protege su límite).
  const key = quoteKey(m, chain.id, input.address, output.address);
  const stored = lastQuotes.get(key);
  lastQuotes.delete(key);
  const quoted = stored && Date.now() - stored.at <= QUOTE_TTL_MS && Math.abs(amount - stored.amountIn) <= stored.amountIn * 0.02 ? stored : undefined;
  const ref = quoted ?? (args.minOut === undefined ? decided : undefined);
  if (ref) {
    const expected = ref.amountOut * (amount / ref.amountIn);
    const minOut = expected * (1 - args.slippageBps / 10_000);
    if (quote.amountOut < minOut) {
      const burned = settled.costs.filter((c) => c.kind === "network_fee" || c.kind === "l1_fee" || c.kind === "approval").reduce((s, c) => s + c.amount, 0);
      if (burned > 0) applyDeltas(m, chain.id, [{ asset: chain.native.address, symbol: chain.native.symbol, decimals: chain.native.decimals, amount: -burned }]);
      const worse = (1 - quote.amountOut / expected) * 100;
      const error =
        `El swap revierte: el precio se ha movido más que tu slippage. ${quoted ? "Cotizaste" : `Al decidir (antes de ${latency / 1000} s de latencia) salían`} ${Number(expected.toPrecision(6))} ${output.symbol} y ahora ` +
        `saldrían ${Number(quote.amountOut.toPrecision(6))} (${worse.toFixed(1)} % menos; tu límite era ${args.slippageBps / 100} %). ` +
        `Has pagado la red (${Number(burned.toPrecision(3))} ${chain.native.symbol}).`;
      logJournal({ missionId: m, sessionId: args.sessionId, kind: "failed_tx", summary: `Swap fallido en ${chain.label}: slippage superado (${worse.toFixed(1)} % peor que tu cotización)`, reasoning: args.reasoning });
      throw new SlippageExceeded(error, worse, args.slippageBps, quoted ? 0 : latency, burned, chain.native.symbol);
    }
  }
  const result = {
    chain: chain.id,
    sold: `${amount} ${input.symbol}`,
    received: `${quote.amountOut} ${output.symbol}`,
    effectivePrice: `1 ${output.symbol} = ${(amount / quote.amountOut).toPrecision(6)} ${input.symbol}`,
    priceImpactPct: quote.priceImpactPct,
    route: quote.route,
    costs: describeCosts(settled.costs),
    ...settled.info,
    ...(quote.warnings.length ? { warnings: quote.warnings } : {}),
    // Costes realistas: lo que daba la cotización con la que se decidió y lo que dio tras la latencia.
    ...(decided ? { latency: { ms: latency, quotedOut: decided.amountOut, filledOut: quote.amountOut } } : {}),
  };
  // La comprobación, los saldos y la fila del diario, juntos: una misión que se cancela en paralelo (prep_timeout, en otro
  // proceso) o no ve la compra o la ve entera (cancelForPrepTimeout no cancela una misión con una compra recién hecha).
  inWriteTransaction(() => {
    assertStillActive(m, startStatus);
    applyDeltas(m, chain.id, settled.deltas);
    logJournal({
      missionId: m,
      sessionId: args.sessionId,
      kind: "swap",
      summary: `Swap ${Number(amount.toPrecision(6))} ${input.symbol} → ${Number(quote.amountOut.toPrecision(6))} ${output.symbol}${chain.id === "solana" ? "" : ` en ${chain.label}`}`,
      reasoning: args.reasoning,
      details: { inputMint: input.address, outputMint: output.address, ...result },
    });
  });

  // Valor de la operación en USD: el lado estable si lo hay (es exacto); si no, el precio de mercado.
  let valueUsd = chain.isCash(input.address) ? amount : chain.isCash(output.address) ? quote.amountOut : 0;
  if (!valueUsd) {
    const prices = await chain.priceUsd([input.address, output.address]).catch(() => ({}) as Record<string, number>);
    valueUsd = (prices[input.address] ?? 0) * amount || (prices[output.address] ?? 0) * quote.amountOut;
  }
  await recordTrade({
    missionId: m,
    venue: chain.id,
    sold: { asset: input.address, qty: amount },
    bought: { asset: output.address, symbol: output.symbol, qty: quote.amountOut },
    valueUsd,
    meta: args.meta,
  }).catch((err) => console.error(`No se pudo registrar la posición: ${(err as Error).message}`));
  return result;
}

// Última cotización de cada swap por misión: al ejecutar ese mismo swap poco después, el slippage se mide contra ella.
const lastQuotes = new Map<string, { amountIn: number; amountOut: number; at: number }>();
const QUOTE_TTL_MS = 60_000;
const quoteKey = (missionId: number, chain: string, input: string, output: string) => `${missionId}:${chain}:${input}:${output}`;

export async function quoteSwap(chainId: ChainId, inputRef: string, outputRef: string, amount: number, slippageBps = 50, missionId?: number | null) {
  const chain = getChain(chainId);
  const [input, output] = await Promise.all([chain.resolveToken(inputRef), chain.resolveToken(outputRef)]);
  const q = await chain.quote({ input, output, amountIn: amount, slippageBps });
  if (missionId != null) lastQuotes.set(quoteKey(missionId, chain.id, input.address, output.address), { amountIn: amount, amountOut: q.amountOut, at: Date.now() });
  return {
    chain: chain.id,
    input: `${amount} ${input.symbol} (${input.address})`,
    output: `${q.amountOut} ${output.symbol} (${output.address})`,
    priceImpactPct: q.priceImpactPct,
    route: q.route,
    ...(q.warnings.length ? { warnings: q.warnings } : {}),
    note:
      "Sin contar los costes de red: se calculan al ejecutar, según tu monedero. Si ejecutas este mismo swap (mismo importe) en menos " +
      "de 60 s, tu slippage se mide contra esta cotización: si el precio se ha movido más, el swap revierte y pagas solo la red.",
  };
}

// ─── Órdenes de mercado en Binance ──────────────────────────────────────────

export async function binanceMarketOrder(args: {
  missionId: number;
  sessionId: number | null;
  symbol: string;
  side: "BUY" | "SELL";
  amount: number; // BUY: cantidad de quote a gastar. SELL: cantidad base a vender.
  reasoning: string;
  meta?: TradeMeta;
}) {
  assertSimulated(args.missionId, "operar en Binance");
  const info = await market.getSymbolInfo(args.symbol);
  const book = await market.getOrderBook(info.symbol);
  const m = args.missionId;
  const { fill, feePaid, feeAsset, deltas } = fillMarketOrder({
    info,
    book,
    side: args.side,
    amount: args.amount,
    balance: (asset) => balance(m, "binance", asset),
    takerFee: config.binanceTakerFee,
  });
  applyDeltas(m, "binance", deltas);

  const result = {
    symbol: info.symbol,
    side: args.side,
    baseQty: fill.baseQty,
    quoteQty: fill.quoteQty,
    avgPrice: fill.avgPrice,
    bestPrice: fill.bestPrice,
    slippagePct: fill.slippagePct,
    fee: `${feePaid} ${feeAsset}`,
  };
  logJournal({
    missionId: m,
    sessionId: args.sessionId,
    kind: "cex_order",
    summary: `Binance ${args.side} ${fill.baseQty.toPrecision(6)} ${info.baseAsset} @ ${fill.avgPrice.toPrecision(6)} ${info.quoteAsset}`,
    reasoning: args.reasoning,
    details: result,
  });

  // Lo que queda por debajo del step del par no se puede vender: es polvo y la posición se da por cerrada.
  const dust = args.side === "SELL" ? balance(m, "binance", info.baseAsset) : 0;
  const soldQty = dust > 0 && dust < info.stepSize ? fill.baseQty + dust : fill.baseQty;

  // Valor en USD del lado quote: casi siempre una stablecoin; si no, su valor de liquidación.
  const quoteNet = args.side === "BUY" ? fill.quoteQty : fill.quoteQty - feePaid;
  const valueUsd = binance.isCash(info.quoteAsset)
    ? quoteNet
    : (
        await binance
          .liquidationValue({ venue: "binance", asset: info.quoteAsset, symbol: info.quoteAsset, decimals: 8, amount: quoteNet })
          .catch(() => ({ usd: 0 }))
      ).usd;
  await recordTrade({
    missionId: m,
    venue: "binance",
    sold: args.side === "BUY" ? { asset: info.quoteAsset, qty: fill.quoteQty } : { asset: info.baseAsset, qty: soldQty },
    bought:
      args.side === "BUY"
        ? { asset: info.baseAsset, symbol: info.baseAsset, qty: fill.baseQty - feePaid }
        : { asset: info.quoteAsset, symbol: info.quoteAsset, qty: fill.quoteQty - feePaid },
    valueUsd,
    meta: args.meta,
  }).catch((err) => console.error(`No se pudo registrar la posición: ${(err as Error).message}`));
  return result;
}

/**
 * Dirección del monedero EVM de la misión (la misma en Base y BNB Chain, como en MetaMask).
 * Es ficticia: se deriva del id de la misión y no corresponde a ninguna clave real.
 */
export const evmAddress = (missionId: number) => `0x${createHash("sha256").update(`cryptoagent-mission-${missionId}`).digest("hex").slice(0, 40)}`;

// ─── Valoración a precio de mercado ─────────────────────────────────────────

export async function valuation(missionId: number, recordSnapshot = false, opts: { fresh?: boolean } = {}) {
  // Saldos y tránsito se leen en la misma instantánea: si otro proceso abona una transferencia entre
  // las dos lecturas, se contaría dos veces (en la cartera y en tránsito).
  let holdings: Holding[] = [];
  let pending: Array<{ id: number; to_venue: VenueId; asset_in: string; symbol_in: string; decimals_in: number; amount_in: number; arrives_at: string; carry: string | null }> = [];
  applyAtomically(() => {
    holdings = getHoldings(missionId);
    // Lo que está en tránsito (transferencias y puentes) se valora en su destino.
    pending = db
      .prepare("SELECT id, to_venue, asset_in, symbol_in, decimals_in, amount_in, arrives_at, carry FROM transfers WHERE mission_id = ? AND status = 'pending' ORDER BY id")
      .all(missionId) as typeof pending;
    // Puente real: si ya ha llegado algo al destino (el saldo supera el de antes del envío), no se cuenta
    // también en tránsito mientras Li.Fi no lo confirma.
    for (const t of pending) {
      const live = t.carry ? (JSON.parse(t.carry) as { live?: { baseline: number } }).live : undefined;
      if (live) t.amount_in = Math.max(0, t.amount_in - Math.max(0, balance(missionId, t.to_venue, t.asset_in) - live.baseline));
    }
    pending = pending.filter((t) => t.amount_in > 0);
  });
  const lines = await Promise.all(holdings.map(async (h) => ({ ...h, ...(await getVenue(h.venue).liquidationValue(h, opts)) })));
  const transit = await Promise.all(
    pending.map(async (t) => ({
      ...t,
      ...(await getVenue(t.to_venue).liquidationValue({ venue: t.to_venue, asset: t.asset_in, symbol: t.symbol_in, decimals: t.decimals_in, amount: t.amount_in })),
    })),
  );
  let totalUsd = lines.reduce((s, l) => s + l.usd, 0) + transit.reduce((s, t) => s + t.usd, 0);
  const mission = db.prepare("SELECT created_at, initial_usd, benchmark_sol_price, benchmark FROM missions WHERE id = ?").get(missionId) as
    | { created_at: string; initial_usd: number; benchmark_sol_price: number | null; benchmark: string | null }
    | undefined;
  const initialUsd = mission?.initial_usd ?? config.initialUsd;
  // Referencia informativa: si falta un precio, no debe romper la valoración.
  let benchmarkUsd = initialUsd;
  let benchmarkLabel = "capital inicial";
  if (mission?.benchmark) {
    // La cartera inicial sin tocar, valorada ahora.
    const start = JSON.parse(mission.benchmark) as Holding[];
    const values = await Promise.all(start.map((h) => getVenue(h.venue).liquidationValue(h).catch(() => ({ usd: h.amount }))));
    benchmarkUsd = values.reduce((t, x) => t + x.usd, 0);
    benchmarkLabel = "sin operar (la cartera inicial, a precios de ahora)";
  } else if (mission?.benchmark_sol_price) {
    // Misiones antiguas: haber mantenido SOL.
    const solNow = await solUsdPrice().catch(() => null);
    if (solNow) {
      benchmarkUsd = (initialUsd / mission.benchmark_sol_price) * solNow;
      benchmarkLabel = "mantener SOL";
    }
  }

  // Futuros abiertos: cuentan por lo que volvería a la cartera si se cerraran ahora.
  const { openPerps } = await import("./perps.js");
  const perps = await openPerps(missionId).catch(() => []);
  totalUsd += perps.reduce((s, p) => s + p.valueIfClosedUsd, 0);

  if (recordSnapshot) {
    db.prepare("INSERT INTO snapshots (ts, mission_id, total_usd, benchmark_usd, details) VALUES (?, ?, ?, ?, ?)").run(
      now(),
      missionId,
      totalUsd,
      benchmarkUsd,
      JSON.stringify(lines.map((l) => ({ venue: l.venue, symbol: l.symbol, amount: l.amount, usd: l.usd }))),
    );
  }
  return {
    missionId,
    startedAt: mission?.created_at,
    initialUsd,
    totalUsd,
    /** false si algún saldo se valoró sin cotización real: el total es orientativo. */
    reliable: lines.every((l) => l.reliable) && transit.every((t) => t.reliable),
    pnlUsd: totalUsd - initialUsd,
    pnlPct: ((totalUsd - initialUsd) / initialUsd) * 100,
    benchmarkUsd,
    benchmarkLabel,
    evmWallet: evmAddress(missionId),
    holdings: lines.map((l) => ({
      venue: l.venue,
      symbol: l.symbol,
      asset: l.asset,
      amount: l.amount,
      usd: Number(l.usd.toFixed(4)),
      valuedBy: l.method,
    })),
    ...(perps.length ? { perps } : {}),
    ...(transit.length
      ? {
          inTransit: transit.map((t) => ({
            transferId: t.id,
            to: t.to_venue,
            symbol: t.symbol_in,
            amount: t.amount_in,
            usd: Number(t.usd.toFixed(4)),
            arrivesAt: t.arrives_at,
          })),
        }
      : {}),
  };
}
