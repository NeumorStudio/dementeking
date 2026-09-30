// Recorrido completo de una misión contra un mercado falso: swaps, órdenes condicionales (también
// en el formato guardado antes de la abstracción de venues), transferencias, valoración y cierre.
import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.js";
import { db, now } from "../src/db.js";
import { SOL_MINT, USDC_MINT } from "../src/market/jupiter.js";
import { createMission, startMissionClock } from "../src/sim/mission.js";
import { checkOrders, placeOrder } from "../src/sim/orders.js";
import { binanceMarketOrder, getHoldings, liquidateAll, quoteSwap, swap, valuation } from "../src/sim/portfolio.js";
import { cexTransfer, settleTransfers } from "../src/sim/transfers.js";
import { listPositions } from "../src/sim/positions.js";
import { TOKEN_ACCOUNT_RENT_SOL } from "../src/sim/venues/solana.js";
import { installFakeMarket, MEME, POOL_FEE, setPrice } from "./fake-market.js";

installFakeMarket();

const bal = (missionId: number, venue: string, asset: string) =>
  getHoldings(missionId).find((h) => h.venue === venue && h.asset === asset)?.amount ?? 0;
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

const mission = await createMission(1000, 5000, 60, undefined, { solana: 100 });
startMissionClock(mission.id);
const m = mission.id;

test("la misión empieza con USDC y un poco de SOL en Solana", () => {
  // Gas: 3 % de lo asignado, con un máximo de 7,5 $ en Solana (0,05 SOL a 150 $).
  close(bal(m, "solana", SOL_MINT), 0.05);
  close(bal(m, "solana", USDC_MINT), 1000 - 7.5);
});

test("comprar un token: saldos, costes de red y posición abierta", async () => {
  const solBefore = bal(m, "solana", SOL_MINT);
  const r = await swap({ missionId: m, sessionId: null, chain: "solana", input: "USDC", output: MEME, amount: 100, slippageBps: 50, reasoning: "test" });
  assert.equal(r.chain, "solana");
  close(bal(m, "solana", MEME), (100 / 0.01) * (1 - POOL_FEE));
  close(bal(m, "solana", SOL_MINT), solBefore - config.solanaTxFeeSol - TOKEN_ACCOUNT_RENT_SOL);
  const p = listPositions(m).find((x) => x.asset === MEME)!;
  assert.equal(p.status, "open");
  assert.equal(p.openCostUsd, 100);
  assert.equal(p.entry.venue, "solana");
});

test("valoración a precio de liquidación", async () => {
  const v = await valuation(m);
  const meme = v.holdings.find((h) => h.asset === MEME)!;
  close(meme.usd, (100 / 0.01) * (1 - POOL_FEE) * 0.01 * (1 - POOL_FEE), 1e-3);
  assert.equal(meme.valuedBy, "liquidación Jupiter");
  assert.equal(v.holdings.find((h) => h.asset === SOL_MINT)!.valuedBy, "libro Binance SOLUSDT");
  assert.equal(v.reliable, true);
});

test("una orden condicional guardada con el formato anterior se ejecuta", async () => {
  // Así guardaba las órdenes place_solana_trigger_order (sin sellAll ni cadena en la acción).
  const amount = bal(m, "solana", MEME);
  db.prepare(
    `INSERT INTO orders (created_at, mission_id, venue, trigger_asset, trigger_label, condition, trigger_price, action, reasoning)
     VALUES (?, ?, 'solana', ?, 'MEME/USD', 'above', 0.012, ?, 'toma de beneficios')`,
  ).run(now(), m, MEME, JSON.stringify({ input: MEME, output: "USDC", amount, slippageBps: 100 }));

  assert.deepEqual(await checkOrders(), []);
  setPrice(MEME, 0.013);
  const usdcBefore = bal(m, "solana", USDC_MINT);
  const log = await checkOrders();
  assert.match(log.join("\n"), /ejecutada/);
  assert.equal(bal(m, "solana", MEME), 0);
  // Como una orden límite real: se llena al precio fijado (0.012), no al del pico (0.013).
  assert.ok(Math.abs(bal(m, "solana", USDC_MINT) - usdcBefore - amount * 0.012) < 1e-6, String(bal(m, "solana", USDC_MINT) - usdcBefore));
  const p = listPositions(m).find((x) => x.asset === MEME)!;
  assert.equal(p.status, "closed");
  assert.ok(p.pnlUsd! > 0);
  assert.match(p.exitReason, /orden condicional/);
});

test("orden por tiempo: se ejecuta a la hora indicada, pase lo que pase con el precio", async () => {
  await swap({ missionId: m, sessionId: null, chain: "solana", input: "USDC", output: MEME, amount: 5, slippageBps: 100, reasoning: "test" });
  const o = await placeOrder({
    missionId: m,
    sessionId: null,
    venue: "solana",
    condition: "time",
    inMinutes: 0.01,
    action: { input: MEME, output: "USDC", amount: 0, sellAll: true, slippageBps: 500 },
    reasoning: "si no ha saltado el TP, vendo",
  });
  assert.match(o.summary, /a las \d\d:\d\d:\d\d/);
  await assert.rejects(placeOrder({ missionId: m, sessionId: null, venue: "solana", condition: "time", action: { input: MEME, output: "USDC", amount: 1, slippageBps: 100 }, reasoning: "x" }), /in_minutes/);
  await new Promise((r) => setTimeout(r, 800));
  assert.match((await checkOrders()).join("\n"), new RegExp(`Orden #${o.id} ejecutada por tiempo`));
  assert.equal(bal(m, "solana", MEME), 0);
});

test("transferir SOL a Binance mueve su coste y se mide al venderlo allí", async () => {
  await swap({ missionId: m, sessionId: null, chain: "solana", input: "USDC", output: "SOL", amount: 60, slippageBps: 50, reasoning: "test" });
  const solPos = listPositions(m).find((x) => x.venue === "solana" && x.asset === SOL_MINT && x.status === "open")!;
  close(solPos.openCostUsd, 60, 0.01);

  const t = await cexTransfer({ missionId: m, sessionId: null, asset: "SOL", from: "solana", to: "binance", amount: solPos.qtyOpen, reasoning: "test" });
  const moved = listPositions(m).find((x) => x.id === solPos.id)!;
  assert.equal(moved.status, "moved");
  // Mientras llega, está en tránsito: no está en Binance, pero cuenta en el valor de la cartera.
  assert.equal(bal(m, "binance", "SOL"), 0);
  const v = await valuation(m);
  assert.equal(v.inTransit?.[0]?.transferId, t.transferId);
  assert.ok(v.inTransit![0]!.usd > 50);
  assert.deepEqual(await settleTransfers({ missionId: m }), [], "todavía no ha llegado");
  // Una transferencia ya abonada (en 'settling') cuenta en la cartera, no también en tránsito.
  const before = (await valuation(m)).totalUsd;
  db.prepare("UPDATE transfers SET status = 'settling' WHERE id = ?").run(t.transferId);
  const row = db.prepare("SELECT asset_in, symbol_in, decimals_in, amount_in FROM transfers WHERE id = ?").get(t.transferId) as any;
  db.prepare("INSERT INTO holdings (mission_id, venue, asset, symbol, decimals, amount) VALUES (?, 'binance', ?, ?, ?, ?)").run(m, row.asset_in, row.symbol_in, row.decimals_in, row.amount_in);
  const during = await valuation(m);
  assert.equal(during.inTransit, undefined);
  close(during.totalUsd, before, 0.5);
  db.prepare("DELETE FROM holdings WHERE mission_id = ? AND venue = 'binance' AND asset = ?").run(m, row.asset_in);
  db.prepare("UPDATE transfers SET status = 'pending' WHERE id = ?").run(t.transferId);
  assert.equal((await settleTransfers({ missionId: m, force: true })).length, 1);
  assert.equal((await settleTransfers({ missionId: m, force: true })).length, 0, "se abona una sola vez");
  const onBinance = listPositions(m).find((x) => x.venue === "binance" && x.asset === "SOL")!;
  assert.equal(onBinance.status, "open");
  close(onBinance.openCostUsd, solPos.openCostUsd, 0.01);

  await binanceMarketOrder({ missionId: m, sessionId: null, symbol: "SOLUSDT", side: "SELL", amount: bal(m, "binance", "SOL"), reasoning: "test" });
  const sold = listPositions(m).find((x) => x.id === onBinance.id)!;
  assert.equal(sold.status, "closed");
  assert.ok(sold.pnlUsd! < 0, "comisiones y spread: pequeña pérdida");
});

test("transferencias no admitidas", async () => {
  const t = { missionId: m, sessionId: null, amount: 1, reasoning: "test" };
  await assert.rejects(cexTransfer({ ...t, asset: "USDC", from: "solana", to: "solana" }), /mismo/);
  await assert.rejects(cexTransfer({ ...t, asset: "USDC", from: "solana", to: "base" }), /simulate_bridge/);
  await assert.rejects(cexTransfer({ ...t, asset: "SOL", from: "binance", to: "base" }), /no mueve SOL por la red de Base/);
  await assert.rejects(cexTransfer({ ...t, asset: "USDC", from: "binance", to: "solana", amount: 1 }), /mínima/);
});

test("sell_all y cadena desconocida", async () => {
  await swap({ missionId: m, sessionId: null, chain: "solana", input: "USDC", output: MEME, amount: 10, slippageBps: 50, reasoning: "test" });
  await swap({ missionId: m, sessionId: null, chain: "solana", input: MEME, output: "USDC", sellAll: true, slippageBps: 50, reasoning: "test" });
  assert.equal(bal(m, "solana", MEME), 0);
  await assert.rejects(
    swap({ missionId: m, sessionId: null, chain: "tron" as never, input: "USDC", output: "TRX", amount: 1, slippageBps: 50, reasoning: "test" }),
    /No existe la cadena/,
  );
});

test("slippage: protege la cotización recién vista; si el precio se mueve más, revierte y se paga la red", async () => {
  const base = { missionId: m, sessionId: null, chain: "solana" as const, input: "USDC", output: MEME, amount: 10, reasoning: "test" };
  await quoteSwap("solana", "USDC", MEME, 10, 100, m);
  setPrice(MEME, 0.0137); // +5,4 %: por 10 USDC salen un 5 % menos tokens que en la cotización
  const usdc = bal(m, "solana", USDC_MINT);
  const sol = bal(m, "solana", SOL_MINT);
  await assert.rejects(swap({ ...base, slippageBps: 100 }), /revierte.*slippage/);
  assert.equal(bal(m, "solana", USDC_MINT), usdc);
  close(bal(m, "solana", SOL_MINT), sol - config.solanaTxFeeSol, 1e-12);
  // Con un slippage que cubre el movimiento, se ejecuta.
  await quoteSwap("solana", "USDC", MEME, 10, 1000, m);
  setPrice(MEME, 0.014);
  await swap({ ...base, slippageBps: 1000 });
  // Sin cotización previa no hay contra qué medir: se ejecuta al precio del momento.
  setPrice(MEME, 0.02);
  await swap({ ...base, input: MEME, output: "USDC", amount: undefined, sellAll: true, slippageBps: 10 });
  assert.equal(bal(m, "solana", MEME), 0);
});

test("liquidar deja la cartera en stablecoins (el SOL reservado paga la última transacción)", async () => {
  await swap({ missionId: m, sessionId: null, chain: "solana", input: "USDC", output: MEME, amount: 50, slippageBps: 50, reasoning: "test" });
  const problems = await liquidateAll(m, null, "Cierre automático: test");
  assert.deepEqual(problems, []);
  const left = getHoldings(m).filter((h) => !["USDC", "USDT"].includes(h.symbol));
  // Solo queda el polvo de SOL en Binance que no llega al step del par (0,001).
  assert.deepEqual(left.map((h) => `${h.venue}:${h.symbol}`), ["binance:SOL"]);
  assert.ok(left[0]!.amount < 0.001);
  assert.equal(bal(m, "solana", SOL_MINT), 0);
  assert.equal(listPositions(m).filter((p) => p.status === "open").length, 0);
});
