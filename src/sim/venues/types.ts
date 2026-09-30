// Contrato de cada sitio donde el agente puede tener saldo: una cadena (monedero propio, swaps en
// agregadores de DEX) o un exchange centralizado (órdenes contra el libro).
//
// En una cadena, operar se divide en dos pasos: `quote` hace toda la E/S de red y devuelve la
// cotización real; `settle` es puro y decide qué pasa con el monedero (saldos que cambian, costes
// de red, o el motivo por el que la transacción fallaría). Así las reglas se prueban sin red.
import type { ChainId, CexId, Features, Holding, VenueId } from "../types.js";

export interface TokenRef {
  /** Dirección normalizada del token en su cadena. */
  address: string;
  symbol: string;
  decimals: number;
}

export type CostKind =
  | "network_fee"
  | "l1_fee"
  | "rent"
  | "rent_refund"
  | "approval"
  | "tax_buy"
  | "tax_sell"
  | "cex_fee"
  | "withdraw_fee"
  | "bridge_fee";

export interface CostLine {
  kind: CostKind;
  asset: string;
  symbol: string;
  /** Positivo = coste; negativo = devolución (p. ej. renta recuperada). */
  amount: number;
}

/** Cambio de saldo de un activo. */
export interface Delta {
  asset: string;
  symbol: string;
  decimals: number;
  amount: number;
}

export interface SwapQuote {
  chain: ChainId;
  input: TokenRef;
  output: TokenRef;
  amountIn: number;
  /** Lo que da la ruta antes de impuestos del token. */
  grossOut: number;
  /** Lo que llega al monedero. */
  amountOut: number;
  priceImpactPct?: string | number;
  route: string[];
  slippageBps: number;
  /** Datos de la fuente para el diario (slot, ids…). */
  extra?: Record<string, unknown>;
  warnings: string[];
}

export interface WalletView {
  balance(asset: string): number;
  /** Cadenas EVM: si el monedero ya aprobó al router para gastar este token. */
  approved?(asset: string): boolean;
  /**
   * Costes de la misión cuando no son los de la simulación de siempre (misiones con costes realistas, costs.ts). Sin
   * esto, cada cadena aplica los suyos por defecto.
   */
  profile?: CostProfile;
}

/** Costes realistas de un monedero de Solana (costs.ts): fee con prioridad y renta que no se recupera. */
export interface CostProfile {
  /** Fee de red de cada transacción, en el nativo. */
  networkFee: number;
  /** Si al vaciar una cuenta de token se recupera su renta. */
  rentRefund: boolean;
  /** Si la cuenta del token ya existe (aunque esté a cero): recibirlo no paga renta. */
  hasAccount(asset: string): boolean;
}

export type Settlement =
  | { ok: true; deltas: Delta[]; costs: CostLine[]; info: Record<string, unknown>; approvals?: string[] }
  /** La transacción falla. `deltas` recoge lo que se pierde igualmente (p. ej. gas quemado). */
  | { ok: false; error: string; deltas: Delta[]; costs: CostLine[]; approvals?: string[] };

export interface Valued {
  usd: number;
  method: string;
  /** true si sale de una cotización real de venta; false si es un valor de reserva (precio spot). */
  reliable: boolean;
}

interface VenueBase {
  id: VenueId;
  label: string;
  /** Activos que cuentan como efectivo (stablecoins): no abren posición. */
  isCash(asset: string): boolean;
  /** Valor de liquidación de un saldo: cuánto se obtendría vendiéndolo ahora. */
  /** Valor si se vendiera ahora. Con `fresh`, sin reutilizar cotizaciones recientes de la caché. */
  liquidationValue(h: Holding, opts?: { fresh?: boolean }): Promise<Valued>;
  /** Precio que vigilan las órdenes condicionales (USD en cadenas; precio del par en exchanges). */
  triggerPrice(asset: string): Promise<number>;
}

export interface ChainAdapter extends VenueBase {
  kind: "chain";
  id: ChainId;
  /** Token nativo, con el que se paga la red. */
  native: TokenRef;
  /** Stablecoin a la que se liquida al cerrar posiciones. */
  cash: TokenRef;
  /** Todas las stablecoins que cuentan como efectivo en la cadena. */
  stables: TokenRef[];
  /** Nativo que se deja sin vender al liquidar, para pagar esa última transacción. */
  liquidationReserve: number;
  /** Cuánto del capital de la cadena se entrega en nativo para el gas al empezar una misión (USD). */
  gasBudgetUsd: { min: number; max: number };
  /** Resuelve una dirección o un alias (SOL, USDC…) a un token. */
  resolveToken(ref: string): Promise<TokenRef>;
  /** Precio en USD de varios tokens (los que no tengan precio no aparecen). */
  priceUsd(assets: string[]): Promise<Record<string, number>>;
  /** Con `fresh`, sin reutilizar una cotización idéntica de hace un momento (la que se pide tras la latencia). */
  quote(p: { input: TokenRef; output: TokenRef; amountIn: number; slippageBps: number; fresh?: boolean }): Promise<SwapQuote>;
  settle(q: SwapQuote, wallet: WalletView): Settlement;
  entryFeatures(asset: string): Promise<Features>;
  research: {
    scan(limit: number): Promise<unknown>;
    report(token: string): Promise<unknown>;
  };
}

export interface CexVenue extends VenueBase {
  kind: "cex";
  id: CexId;
}

export type Venue = ChainAdapter | CexVenue;
