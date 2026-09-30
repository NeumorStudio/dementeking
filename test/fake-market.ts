// Mercado falso para tests: responde como Jupiter y Binance con precios fijados por el test.
import { SOL_MINT, USDC_MINT } from "../src/market/jupiter.js";
import { setFetchImpl } from "../src/market/http.js";

export const MEME = "MeMe1111111111111111111111111111111111111pump";
export const MEME_DEV = "DevRug11111111111111111111111111111111111111";

interface Token {
  symbol: string;
  decimals: number;
  price: number;
  /** Lo que Jupiter dice de su origen: launchpad y cuándo se graduó (ISO). */
  launchpad?: string;
  graduatedAt?: string;
}

export const tokens: Record<string, Token> = {
  [SOL_MINT]: { symbol: "SOL", decimals: 9, price: 150 },
  [USDC_MINT]: { symbol: "USDC", decimals: 6, price: 1 },
  [MEME]: { symbol: "MEME", decimals: 6, price: 0.01 },
};

/** Comisión de la ruta falsa de Jupiter (0,3 %). */
export const POOL_FEE = 0.003;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// ─── Base y BNB Chain ───────────────────────────────────────────────────────

type EvmChain = "base" | "bsc";
export const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const BSC_USDT = "0x55d398326f99059ff775485246999027b3197955";
/** Token con impuesto del 5 % al comprar y al vender. */
export const TAXED = "0x1111111111111111111111111111111111111111";
/** Honeypot: se puede comprar, pero no vender. */
export const HONEY = "0x2222222222222222222222222222222222222222";
export const CAKE = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";

interface EvmToken extends Token {
  buyTax?: string;
  sellTax?: string;
  honeypot?: boolean;
}

export const evmTokens: Record<EvmChain, Record<string, EvmToken>> = {
  base: {
    [NATIVE]: { symbol: "ETH", decimals: 18, price: 3000 },
    [BASE_USDC]: { symbol: "USDC", decimals: 6, price: 1 },
    [TAXED]: { symbol: "TAX", decimals: 18, price: 0.5, buyTax: "0.05", sellTax: "0.05" },
    [HONEY]: { symbol: "HONEY", decimals: 18, price: 1, buyTax: "0", sellTax: "0", honeypot: true },
  },
  bsc: {
    [NATIVE]: { symbol: "BNB", decimals: 18, price: 600 },
    [BSC_USDT]: { symbol: "USDT", decimals: 18, price: 1 },
    [CAKE]: { symbol: "CAKE", decimals: 18, price: 2, buyTax: "0", sellTax: "0" },
  },
};

const EVM_HOSTS: Record<EvmChain, string> = { base: "mainnet.base.org", bsc: "bsc-dataseed.binance.org" };
/** Gas de un swap y precio del gas (wei): 0,01 gwei en Base y 0,05 gwei en BNB Chain. */
export const EVM_GAS = 200_000;
export const EVM_GAS_PRICE: Record<EvmChain, number> = { base: 10_000_000, bsc: 50_000_000 };

/** Rutas extra de un test (p. ej. GeckoTerminal): si devuelve una respuesta, se usa esa. */
let extraRoutes: ((url: URL) => Response | undefined) | null = null;
export function setExtraRoutes(fn: ((url: URL) => Response | undefined) | null) {
  extraRoutes = fn;
  installFakeMarket();
}

function handle(url: URL, body?: unknown): Response {
  const extra = extraRoutes?.(url);
  if (extra) return extra;
  if (url.host === "lite-api.jup.ag") {
    if (url.pathname === "/tokens/v2/search") {
      const t = tokens[url.searchParams.get("query")!];
      const id = url.searchParams.get("query");
      // MEME lo lanzó un creador "en serie" (40 tokens, ninguno graduado).
      const creator = id === MEME ? { dev: MEME_DEV, audit: { devMints: 40, devMigrations: 0, devBalancePercentage: 8 } } : {};
      const origin = t ? { launchpad: t.launchpad, graduatedAt: t.graduatedAt } : {};
      return json(t ? [{ id, symbol: t.symbol, name: t.symbol, decimals: t.decimals, usdPrice: t.price, ...creator, ...origin }] : []);
    }
    if (url.pathname === "/price/v3") {
      const ids = url.searchParams.get("ids")!.split(",");
      return json(Object.fromEntries(ids.map((id) => [id, tokens[id] ? { usdPrice: tokens[id]!.price } : null])));
    }
    if (url.pathname === "/swap/v1/quote") {
      const a = tokens[url.searchParams.get("inputMint")!];
      const b = tokens[url.searchParams.get("outputMint")!];
      if (!a || !b) return json({ error: "no route" }, 400);
      const amountIn = Number(url.searchParams.get("amount")) / 10 ** a.decimals;
      const out = ((amountIn * a.price) / b.price) * (1 - POOL_FEE);
      return json({
        inAmount: url.searchParams.get("amount"),
        outAmount: String(Math.floor(out * 10 ** b.decimals)),
        priceImpactPct: "0",
        slippageBps: Number(url.searchParams.get("slippageBps")),
        routePlan: [{ percent: 100, swapInfo: { label: "Fake AMM", ammKey: "fake" } }],
        contextSlot: 1,
      });
    }
  }
  const evmChain = (Object.keys(EVM_HOSTS) as EvmChain[]).find((c) => EVM_HOSTS[c] === url.host);
  if (evmChain) return rpc(evmChain, JSON.parse(String(body)));
  if (url.host === "aggregator-api.kyberswap.com") {
    const chain = url.pathname.split("/")[1] as EvmChain;
    const a = evmTokens[chain][url.searchParams.get("tokenIn")!.toLowerCase()];
    const b = evmTokens[chain][url.searchParams.get("tokenOut")!.toLowerCase()];
    if (!a || !b) return json({ code: 4008, message: "route not found" }, 400);
    const amountIn = Number(url.searchParams.get("amountIn")) / 10 ** a.decimals;
    const out = ((amountIn * a.price) / b.price) * (1 - POOL_FEE);
    const gasNative = (EVM_GAS * EVM_GAS_PRICE[chain]) / 1e18;
    return json({
      code: 0,
      message: "successfully",
      data: {
        routeSummary: {
          amountOut: BigInt(Math.floor(out * 10 ** b.decimals)).toString(),
          gas: String(EVM_GAS),
          gasPrice: String(EVM_GAS_PRICE[chain]),
          gasUsd: String(gasNative * evmTokens[chain][NATIVE]!.price),
          l1FeeUsd: chain === "base" ? "0.001" : "0",
          route: [[{ exchange: "fake-dex" }]],
        },
      },
    });
  }
  if (url.host === "li.quest") {
    // Puente: convierte a precio de mercado, cobra 0,05 $ y 0,0001 del nativo de origen de gas; tarda 45 s.
    const chainOf: Record<string, EvmChain | "solana"> = { SOL: "solana", "8453": "base", "56": "bsc" };
    const find = (chain: EvmChain | "solana", addr: string) =>
      chain === "solana"
        ? tokens[addr === "11111111111111111111111111111111" ? SOL_MINT : addr]
        : evmTokens[chain][addr === "0x0000000000000000000000000000000000000000" ? NATIVE : addr.toLowerCase()];
    const from = chainOf[url.searchParams.get("fromChain")!]!;
    const to = chainOf[url.searchParams.get("toChain")!]!;
    const a = find(from, url.searchParams.get("fromToken")!);
    const b = find(to, url.searchParams.get("toToken")!);
    if (!a || !b) return json({ message: "No available quotes for the requested transfer" }, 404);
    const fromUsd = (Number(url.searchParams.get("fromAmount")) / 10 ** a.decimals) * a.price;
    const toUsd = fromUsd - 0.05;
    const native = from === "solana" ? { decimals: 9, symbol: "SOL" } : { decimals: 18, symbol: from === "base" ? "ETH" : "BNB" };
    return json({
      tool: "fakebridge",
      estimate: {
        toAmount: BigInt(Math.floor((toUsd / b.price) * 10 ** b.decimals)).toString(),
        executionDuration: 45,
        gasCosts: [{ amount: String(10 ** (native.decimals - 4)), amountUSD: "0.02", token: native }],
        feeCosts: [{ name: "Fake Fee", amountUSD: "0.05", included: true }],
        fromAmountUSD: String(fromUsd),
        toAmountUSD: String(toUsd),
      },
    });
  }
  if (url.host === "api.gopluslabs.io") {
    const chain: EvmChain = url.pathname.endsWith("/8453") ? "base" : "bsc";
    const addr = url.searchParams.get("contract_addresses")!.toLowerCase();
    const t = evmTokens[chain][addr];
    return json({ code: 1, message: "OK", result: t ? { [addr]: { buy_tax: t.buyTax ?? "", sell_tax: t.sellTax ?? "", is_honeypot: t.honeypot ? "1" : "0" } } : {} });
  }
  if (url.host === "api.dexscreener.com" && url.pathname.startsWith("/tokens/v1/")) {
    const [, , , chain, list] = url.pathname.split("/") as [string, string, string, EvmChain, string];
    const pairs = list.split(",").flatMap((addr) => {
      const t = evmTokens[chain]?.[addr.toLowerCase()];
      return t ? [{ pairAddress: "0xpair", dexId: "fake-dex", url: "", baseToken: { address: addr, symbol: t.symbol, name: t.symbol }, quoteToken: { address: NATIVE, symbol: "WETH" }, priceUsd: String(t.price), liquidity: { usd: 100_000 } }] : [];
    });
    return json(pairs);
  }
  if (url.host === "api.hyperliquid.xyz") {
    // Perpetuos: SOL (20x) al precio del SOL del mercado falso y BNB (10x).
    return json([
      { universe: [{ name: "SOL", maxLeverage: 20 }, { name: "BNB", maxLeverage: 10 }] },
      [
        { markPx: String(tokens[SOL_MINT]!.price), funding: "0.0000125" },
        { markPx: String(evmTokens.bsc[NATIVE]!.price), funding: "0" },
      ],
    ]);
  }
  if (url.host === "api.binance.com") {
    const symbol = url.searchParams.get("symbol") ?? "";
    const base = symbol.replace(/(USDT|USDC)$/, "");
    const price = base === "SOL" ? tokens[SOL_MINT]!.price : base === "ETH" ? evmTokens.base[NATIVE]!.price : base === "BNB" ? evmTokens.bsc[NATIVE]!.price : undefined;
    if (price === undefined) return json({ code: -1121, msg: "Invalid symbol." }, 400);
    if (url.pathname === "/api/v3/exchangeInfo") {
      return json({
        symbols: [
          {
            symbol,
            status: "TRADING",
            baseAsset: base,
            quoteAsset: symbol.slice(base.length),
            filters: [
              { filterType: "LOT_SIZE", stepSize: "0.001" },
              { filterType: "NOTIONAL", minNotional: "5" },
            ],
          },
        ],
      });
    }
    if (url.pathname === "/api/v3/depth") {
      // Libro profundo con un tick de diferencia entre compra y venta.
      return json({ bids: [[String(price - 0.01), "10000"]], asks: [[String(price + 0.01), "10000"]] });
    }
    if (url.pathname === "/api/v3/ticker/price") return json({ symbol, price: String(price) });
  }
  // RugCheck y demás fuentes de datos de entrada: sin datos.
  return json({ error: "not found" }, 404);
}

/** Nodo RPC: precio del gas y decimales y símbolo de los tokens (eth_call a decimals() y symbol()). */
function rpc(chain: EvmChain, calls: Array<{ id: number; method: string; params: any[] }>) {
  const word = (n: bigint) => n.toString(16).padStart(64, "0");
  return json(
    calls.map((c) => {
      if (c.method === "eth_gasPrice") return { jsonrpc: "2.0", id: c.id, result: `0x${EVM_GAS_PRICE[chain].toString(16)}` };
      const t = evmTokens[chain][String(c.params[0].to).toLowerCase()];
      if (!t) return { jsonrpc: "2.0", id: c.id, result: "0x" };
      if (c.params[0].data === "0x313ce567") return { jsonrpc: "2.0", id: c.id, result: `0x${word(BigInt(t.decimals))}` };
      const hex = Buffer.from(t.symbol, "utf8").toString("hex");
      return { jsonrpc: "2.0", id: c.id, result: `0x${word(32n)}${word(BigInt(t.symbol.length))}${hex.padEnd(64, "0")}` };
    }),
  );
}

/** Instala el mercado falso (y vacía la caché HTTP, para que se vean los precios nuevos). */
export function installFakeMarket() {
  setFetchImpl((async (input: string | URL | Request, init?: RequestInit) => handle(new URL(String(input)), init?.body)) as typeof fetch);
}

export function setPrice(mint: string, price: number) {
  tokens[mint]!.price = price;
  installFakeMarket();
}
