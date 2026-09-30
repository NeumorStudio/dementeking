// Datos reales de Solana vía la API pública de Jupiter (agregador de DEX).
// Una cotización de Jupiter es exactamente lo que devolvería el swap en mainnet
// en ese instante (ruta, liquidez y comisiones de los pools incluidas).
import { fetchJson } from "./http.js";

const BASE = "https://lite-api.jup.ag";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const ALIASES: Record<string, string> = { SOL: SOL_MINT, USDC: USDC_MINT, USDT: USDT_MINT };

export function resolveMint(mintOrAlias: string): string {
  return ALIASES[mintOrAlias.toUpperCase()] ?? mintOrAlias;
}

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  usdPrice: number | null;
}

const tokenCache = new Map<string, TokenInfo>();

export async function getTokenInfo(mint: string): Promise<TokenInfo> {
  const cached = tokenCache.get(mint);
  if (cached) return cached;
  const results = await fetchJson<Array<Record<string, any>>>(`${BASE}/tokens/v2/search?query=${encodeURIComponent(mint)}`, 15_000, 30_000);
  const hit = results.find((t) => t.id === mint);
  if (!hit) throw new Error(`Token no encontrado en Solana: ${mint}`);
  const info: TokenInfo = {
    mint,
    symbol: String(hit.symbol ?? "?"),
    name: String(hit.name ?? ""),
    decimals: Number(hit.decimals),
    usdPrice: typeof hit.usdPrice === "number" ? hit.usdPrice : null,
  };
  tokenCache.set(mint, info);
  return info;
}

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: Array<{ percent: number; swapInfo: { label?: string; ammKey: string } }>;
  contextSlot?: number;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountBase: bigint,
  slippageBps: number,
  ttlMs = 2_000,
  opts: { lowPriority?: boolean; fresh?: boolean } = {},
): Promise<JupiterQuote> {
  const url =
    `${BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountBase.toString()}&slippageBps=${slippageBps}`;
  // Determina el precio de ejecución: caché muy corta (solo agrupa peticiones idénticas casi simultáneas).
  // Con lowPriority (el gemelo mecánico), solo turnos libres de Jupiter: el agente va por delante. Con fresh (la
  // cotización de después de la latencia), nunca la de la caché.
  const quote = await fetchJson<JupiterQuote & { error?: string }>(url, { timeoutMs: 15_000, ttlMs, lowPriority: opts.lowPriority, fresh: opts.fresh });
  if (quote.error) throw new Error(`Jupiter: ${quote.error}`);
  return quote;
}

/** Convierte una cantidad decimal a unidades base (entero) sin perder precisión. */
export function toBaseUnits(amount: number, decimals: number): bigint {
  const [int, frac = ""] = amount.toFixed(decimals).split(".");
  return BigInt(int + frac.padEnd(decimals, "0"));
}

export function fromBaseUnits(base: string | bigint, decimals: number): number {
  return Number(BigInt(base)) / 10 ** decimals;
}
