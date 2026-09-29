// Prueba de humo contra las APIs reales, en una base de datos temporal (no toca la simulación).
//   npx tsx scripts/smoke.ts
// Crea una misión, cotiza y ejecuta swaps, deja y cancela una orden condicional, opera en Binance,
// transfiere, valora y liquida. Sirve para comprobar que las fuentes de datos siguen respondiendo.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "dementeking-smoke-"));

const { createMission } = await import("../src/sim/mission.js");
const sim = await import("../src/sim/portfolio.js");
const orders = await import("../src/sim/orders.js");
const { listPositions } = await import("../src/sim/positions.js");

// JUP: token líquido de Solana, con ruta estable en Jupiter.
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const step = async <T>(label: string, fn: () => Promise<T>) => {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`✔ ${label} (${Date.now() - t} ms)`);
    return r;
  } catch (err) {
    console.log(`✖ ${label}: ${(err as Error).message}`);
    process.exitCode = 1;
    return undefined;
  }
};
const base = { sessionId: null, reasoning: "smoke test" };

const mission = await step("crear misión", () => createMission(1000, 2000, 30));
if (!mission) process.exit(1);
const m = mission.id;

await step("cotizar USDC → JUP", async () => console.log("   ", JSON.stringify(await sim.quoteSwap("solana", "USDC", JUP, 50))));
await step("comprar JUP", () => sim.swap({ ...base, missionId: m, chain: "solana", input: "USDC", output: JUP, amount: 50, slippageBps: 100 }));
const order = await step("orden condicional (stop loss)", () =>
  orders.placeOrder({ ...base, missionId: m, venue: "solana", triggerAsset: JUP, condition: "below", triggerPrice: 0.0001, action: { input: JUP, output: "USDC", amount: 0, sellAll: true, slippageBps: 300 } }),
);
if (order) await step("cancelar la orden", async () => orders.cancelOrder(m, order.id, null));
await step("vender todo el JUP", () => sim.swap({ ...base, missionId: m, chain: "solana", input: JUP, output: "USDC", sellAll: true, slippageBps: 100 }));
// Base y BNB Chain: BRETT y CAKE, tokens líquidos con ruta estable.
const BRETT = "0x532f27101965dd16442E59d40670FaF5eBB142E4";
const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const { getChain } = await import("../src/sim/venues/index.js");
await step("escanear Base", async () => console.log("   ", ((await getChain("base").research.scan(5)) as { sourcesStatus: string[] }).sourcesStatus.join(" · ")));
await step("ficha de BRETT", async () => console.log("   ", JSON.stringify((await getChain("base").research.report(BRETT)) as object).slice(0, 300)));
await step("cotizar USDC → BRETT (Base)", async () => console.log("   ", JSON.stringify(await sim.quoteSwap("base", "USDC", BRETT, 20))));
await step("comprar BRETT (Base)", async () => console.log("   ", JSON.stringify(await sim.swap({ ...base, missionId: m, chain: "base", input: "USDC", output: BRETT, amount: 20, slippageBps: 100 }))));
await step("vender todo el BRETT (Base)", async () => console.log("   ", JSON.stringify(await sim.swap({ ...base, missionId: m, chain: "base", input: BRETT, output: "USDC", sellAll: true, slippageBps: 100 }))));
await step("comprar CAKE (BNB Chain)", () => sim.swap({ ...base, missionId: m, chain: "bsc", input: "USDT", output: CAKE, amount: 20, slippageBps: 100 }));
const transfers = await import("../src/sim/transfers.js");
await step("transferir 20 USDC a Binance", async () => console.log("   ", JSON.stringify(await transfers.cexTransfer({ ...base, missionId: m, asset: "USDC", from: "solana", to: "binance", amount: 20 }))));
await step("abonar la transferencia (sin esperar)", async () => console.log("   ", (await transfers.settleTransfers({ missionId: m, force: true })).join(" · ")));
await step("cotizar puente USDC Base → BNB Chain", async () => console.log("   ", JSON.stringify(await transfers.quoteBridge({ fromChain: "base", toChain: "bsc", tokenIn: "USDC", tokenOut: "USDT", amount: 10 }))));
await step("puente 10 USDC Base → USDT BNB Chain (Li.Fi)", async () => console.log("   ", JSON.stringify(await transfers.bridge({ ...base, missionId: m, fromChain: "base", toChain: "bsc", tokenIn: "USDC", tokenOut: "USDT", amount: 10, slippageBps: 50 }))));
await step("puente 10 USDC Solana → ETH Base (Li.Fi)", async () => console.log("   ", JSON.stringify(await transfers.bridge({ ...base, missionId: m, fromChain: "solana", toChain: "base", tokenIn: "USDC", tokenOut: "ETH", amount: 10, slippageBps: 50 }))));
await step("abonar los puentes (sin esperar)", async () => console.log("   ", (await transfers.settleTransfers({ missionId: m, force: true })).join(" · ")));
await step("comprar SOL en Binance", () => sim.binanceMarketOrder({ ...base, missionId: m, symbol: "SOLUSDC", side: "BUY", amount: 15 }));
const v = await step("valorar la cartera", () => sim.valuation(m));
if (v) console.log(`    ${v.totalUsd.toFixed(2)} USD (${v.pnlPct.toFixed(2)} %) · fiable: ${v.reliable}`);
const problems = await step("liquidar", () => sim.liquidateAll(m, null, "Cierre automático: smoke test"));
if (problems?.length) console.log("    problemas:", problems);
console.log(
  "Posiciones:",
  listPositions(m).map((p) => `${p.venue}:${p.symbol} ${p.status} ${p.pnlUsd ?? ""}`),
);
