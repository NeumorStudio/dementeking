// Misiones con costes realistas (create_mission con costs: "real"): en los swaps de Solana, fee con prioridad de 0,00075
// SOL, la renta de la cuenta de un token nuevo sin devolver al venderlo y 2 s de latencia entre cotizar y ejecutar (aquí,
// unos milisegundos). Con los costes de siempre, todo sigue igual. Las dos series no se mezclan en las estadísticas.
import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.js";
import { db, now } from "../src/db.js";
import { SOL_MINT, USDC_MINT } from "../src/market/jupiter.js";
import { classStats } from "../src/sim/class-stats.js";
import { describeCostMode } from "../src/sim/costs.js";
import * as memory from "../src/sim/memory.js";
import { NATIVE_DRIFT_MARGIN, TP_TARGET_MARGIN } from "../src/sim/mission-kind.js";
import { createMission, getMission, missionHistory, missionStatus, startMissionClock } from "../src/sim/mission.js";
import { checkOrders, placeOrder } from "../src/sim/orders.js";
import { balance, LimitNotReached, liquidateAll, swap } from "../src/sim/portfolio.js";
import { checkShadows, startShadowRun, type ShadowTiming } from "../src/sim/shadow.js";
import { statusReport } from "../src/sim/status.js";
import { settleSolanaSwap, TOKEN_ACCOUNT_RENT_SOL } from "../src/sim/venues/solana.js";
import type { SwapQuote, TokenRef } from "../src/sim/venues/types.js";
import { POOL_FEE, setExtraRoutes, setPrice, tokens } from "./fake-market.js";

const RC = "ReaLCosts111111111111111111111111111111pump";
const TW = "ReaLTwin11111111111111111111111111111111pump";
const TW2 = "ReaLTwin22222222222222222222222222222222pump";
tokens[RC] = { symbol: "RC", decimals: 6, price: 0.01, launchpad: "pump.fun" };
tokens[TW] = { symbol: "TW", decimals: 6, price: 0.001, launchpad: "pump.fun" };
tokens[TW2] = { symbol: "TW2", decimals: 6, price: 0.001, launchpad: "pump.fun" };
const CONTROLLED = [RC, TW, TW2];

const FEE = 0.00075;
config.latencyMs = 20;

// Cotizaciones de Jupiter de RC, TW y TW2 con un multiplicador por petición (1 = el precio del mercado falso): así el precio se
// mueve entre la cotización con la que se decide y la de después de la latencia. quotes cuenta las peticiones.
let factors: number[] = [];
let quotes = 0;
let pools: unknown[] = [];
function route(url: URL): Response | undefined {
  if (url.host === "api.geckoterminal.com") return new Response(JSON.stringify({ data: Number(url.searchParams.get("page")) === 1 ? pools : [] }));
  if (url.host !== "lite-api.jup.ag" || url.pathname !== "/swap/v1/quote") return undefined;
  const inMint = url.searchParams.get("inputMint")!;
  const outMint = url.searchParams.get("outputMint")!;
  if (!CONTROLLED.includes(inMint) && !CONTROLLED.includes(outMint)) return undefined;
  quotes++;
  const f = factors.length ? factors.shift()! : 1;
  const a = tokens[inMint]!;
  const b = tokens[outMint]!;
  const out = (((Number(url.searchParams.get("amount")) / 10 ** a.decimals) * a.price) / b.price) * (1 - POOL_FEE) * f;
  const plan = [{ percent: 100, swapInfo: { label: "Fake AMM", ammKey: "fake" } }];
  return new Response(JSON.stringify({ inAmount: url.searchParams.get("amount"), outAmount: String(Math.floor(out * 10 ** b.decimals)), priceImpactPct: "0", slippageBps: 300, routePlan: plan, contextSlot: 1 }));
}
/** Las próximas cotizaciones de RC/TW (y vacía la caché HTTP: cada una llega de verdad al mercado falso). */
function next(...f: number[]) {
  factors = f;
  quotes = 0;
  setExtraRoutes(route);
}
next();

const USDC: TokenRef = { address: USDC_MINT, symbol: "USDC", decimals: 6 };
const RCT: TokenRef = { address: RC, symbol: "RC", decimals: 6 };
const quote = (input: TokenRef, output: TokenRef, amountIn: number, amountOut: number): SwapQuote => ({
  chain: "solana",
  input,
  output,
  amountIn,
  grossOut: amountOut,
  amountOut,
  route: [],
  slippageBps: 50,
  warnings: [],
});
const solDelta = (s: ReturnType<typeof settleSolanaSwap>) => (s.ok ? s.deltas.find((d) => d.asset === SOL_MINT)!.amount : NaN);

test("reglas del monedero con costes realistas: fee con prioridad, renta al crear la cuenta y nada de vuelta al venderlo todo", () => {
  const profile = (accounts: string[]) => ({ networkFee: FEE, rentRefund: false, hasAccount: (a: string) => accounts.includes(a) });
  const bal: Record<string, number> = { [USDC_MINT]: 10, [SOL_MINT]: 0.01, [RC]: 500 };
  const w = (accounts: string[]) => ({ balance: (a: string) => bal[a] ?? 0, profile: profile(accounts) });
  // Comprar un token sin cuenta: la fee con prioridad y la renta (y vaciar el USDC no devuelve la suya).
  const buy = settleSolanaSwap(quote(USDC, RCT, 10, 900), w([USDC_MINT]));
  assert.ok(Math.abs(solDelta(buy) + FEE + TOKEN_ACCOUNT_RENT_SOL) < 1e-12);
  // Con la cuenta ya creada (aunque esté a cero), recibirlo otra vez no paga renta.
  assert.ok(Math.abs(solDelta(settleSolanaSwap(quote(USDC, RCT, 5, 450), w([USDC_MINT, RC]))) + FEE) < 1e-12);
  // Venderlo todo: solo la fee; la renta no vuelve.
  const sale = settleSolanaSwap(quote(RCT, USDC, 500, 5), w([USDC_MINT, RC]));
  assert.ok(Math.abs(solDelta(sale) + FEE) < 1e-12);
  assert.equal(sale.ok && sale.info.tokenAccountClosed, false);
  // Sin perfil, las de siempre: 0,0001 y la renta de vuelta al vaciar la cuenta.
  const simSale = settleSolanaSwap(quote(RCT, USDC, 500, 5), { balance: (a) => bal[a] ?? 0 });
  assert.ok(Math.abs(solDelta(simSale) - (TOKEN_ACCOUNT_RENT_SOL - config.solanaTxFeeSol)) < 1e-12, "la renta del token vuelve al vaciar su cuenta");
});

test("swaps con costes realistas: se ejecutan con la cotización de después de la latencia, dentro de su slippage", async () => {
  setPrice(RC, 0.01);
  const m = await createMission(100, 125, 30, undefined, { solana: 100 }, { costMode: "real" });
  assert.equal(getMission(m.id)!.cost_mode, "real");
  startMissionClock(m.id);
  const sol0 = balance(m.id, "solana", SOL_MINT);

  // El precio empeora un 1 % durante la latencia (dentro del 3 % de slippage): se llena a la cotización nueva.
  next(1, 0.99);
  const r = (await swap({ missionId: m.id, sessionId: null, chain: "solana", input: USDC_MINT, output: RC, amount: 20, slippageBps: 300, reasoning: "compra" })) as {
    latency?: { ms: number; quotedOut: number; filledOut: number };
  };
  assert.equal(quotes, 2, "cotiza, espera la latencia y vuelve a cotizar");
  const qty = balance(m.id, "solana", RC);
  assert.ok(Math.abs(qty - (20 / 0.01) * (1 - POOL_FEE) * 0.99) < 0.01, `tokens ${qty}`);
  assert.ok(r.latency && r.latency.filledOut < r.latency.quotedOut && r.latency.ms === 20);
  let sol = balance(m.id, "solana", SOL_MINT);
  assert.ok(Math.abs(sol0 - sol - (FEE + TOKEN_ACCOUNT_RENT_SOL)) < 1e-12, "fee con prioridad y renta de la cuenta nueva");

  // Empeora un 5 %: más que su slippage, revierte como en la cadena y paga la red.
  next(1, 0.95);
  await assert.rejects(
    swap({ missionId: m.id, sessionId: null, chain: "solana", input: USDC_MINT, output: RC, amount: 10, slippageBps: 300, reasoning: "compra" }),
    /revierte: el precio se ha movido más que tu slippage\. Al decidir \(antes de 0\.02 s de latencia\)/,
  );
  assert.equal(balance(m.id, "solana", RC), qty);
  assert.ok(Math.abs(sol - balance(m.id, "solana", SOL_MINT) - FEE) < 1e-12, "solo la red");
  sol = balance(m.id, "solana", SOL_MINT);

  // Venderlo todo: la renta de la cuenta no vuelve.
  next(1, 1);
  await swap({ missionId: m.id, sessionId: null, chain: "solana", input: RC, output: USDC_MINT, sellAll: true, slippageBps: 300, reasoning: "venta" });
  assert.equal(balance(m.id, "solana", RC), 0);
  assert.ok(Math.abs(sol - balance(m.id, "solana", SOL_MINT) - FEE) < 1e-12, "solo la fee");

  // Volver a comprarlo: la cuenta sigue abierta (a cero), así que no paga otra renta.
  sol = balance(m.id, "solana", SOL_MINT);
  next(1, 1);
  await swap({ missionId: m.id, sessionId: null, chain: "solana", input: USDC_MINT, output: RC, amount: 10, slippageBps: 300, reasoning: "compra" });
  assert.ok(Math.abs(sol - balance(m.id, "solana", SOL_MINT) - FEE) < 1e-12, "solo la fee");

  // Al cerrar: la venta que revierte por la latencia se reenvía (pagando otra red), y el SOL se convierte dejando justo su
  // fee con prioridad (con la de siempre, 0,0001, no daría para pagarla).
  next(1, 0.95, 1, 1);
  assert.deepEqual(await liquidateAll(m.id, null, "Cierre de prueba"), []);
  assert.equal(balance(m.id, "solana", RC), 0);
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM journal WHERE mission_id = ? AND kind = 'failed_tx'").get(m.id) as { n: number }).n >= 2, "la compra de antes y la venta reenviada");
  assert.ok(balance(m.id, "solana", SOL_MINT) < 1e-12);

  // Sin costes realistas, una sola cotización y los costes de siempre.
  const sim = await createMission(100, 125, 30, undefined, { solana: 100 });
  startMissionClock(sim.id);
  const simSol = balance(sim.id, "solana", SOL_MINT);
  next(1, 0.5);
  await swap({ missionId: sim.id, sessionId: null, chain: "solana", input: USDC_MINT, output: RC, amount: 20, slippageBps: 300, reasoning: "compra" });
  assert.equal(quotes, 1);
  assert.ok(Math.abs(simSol - balance(sim.id, "solana", SOL_MINT) - (config.solanaTxFeeSol + TOKEN_ACCOUNT_RENT_SOL)) < 1e-12);
});

test("toma de beneficio con costes realistas: salta con una cotización y solo se llena si la de después de la latencia llega", async () => {
  setPrice(RC, 0.01);
  const m = await createMission(100, 125, 30, undefined, { solana: 100 }, { costMode: "real" });
  startMissionClock(m.id);
  next(1, 1);
  await swap({ missionId: m.id, sessionId: null, chain: "solana", input: USDC_MINT, output: RC, amount: 20, slippageBps: 300, reasoning: "compra" });
  const qty = balance(m.id, "solana", RC);
  next();
  const order = await placeOrder({
    missionId: m.id,
    sessionId: null,
    venue: "solana",
    triggerAsset: RC,
    condition: "above",
    triggerPrice: 25 / qty,
    action: { input: RC, output: "USDC", amount: 0, sellAll: true, slippageBps: 300 },
    reasoning: "tp",
  });
  const status = () => (db.prepare("SELECT status FROM orders WHERE id = ?").get(order.id) as { status: string }).status;
  setPrice(RC, 0.0135);

  // La venta límite en sí: la cotización con la que salta llega (~26,7 $), la de después de la latencia no (−10 %).
  next(1, 0.9);
  const limit = { missionId: m.id, sessionId: null, chain: "solana" as const, input: RC, output: USDC_MINT, sellAll: true, slippageBps: 300, reasoning: "tp", minOut: 25, fillAtLimit: true };
  await assert.rejects(swap(limit), (err: unknown) => err instanceof LimitNotReached && err.got < 25);
  assert.equal(quotes, 2);
  assert.equal(balance(m.id, "solana", RC), qty, "no se ha enviado nada");

  // Salta (la venta da ~26,7 $), pero tras la latencia el precio ha caído un 10 %: no se llena y sigue abierta.
  next(1, 0.9);
  await checkOrders();
  assert.equal(status(), "open");
  assert.equal(balance(m.id, "solana", RC), qty);

  // Esta vez aguanta: se llena justo en su límite.
  const usdc = balance(m.id, "solana", USDC_MINT);
  next(1, 1);
  await checkOrders();
  assert.equal(status(), "filled");
  assert.ok(Math.abs(balance(m.id, "solana", USDC_MINT) - usdc - 25) < 1e-6);
  setPrice(RC, 0.01);
});

test("enter_with_exits con costes realistas: la compra paga la latencia y la toma de beneficio cuenta la fee con prioridad", async () => {
  setPrice(RC, 0.01);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 }, { costMode: "real" });
  const { runTool } = await import("../src/tools/index.js");
  const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y las creencias negativas" };
  next();
  const r = await runTool("enter_with_exits", { token: RC, thesis }, { sessionId: 1, missionId: m.id });
  assert.ok(!r.isError, String(r.content));
  const out = JSON.parse(String(r.content));
  assert.ok(out.buy.latency, "la compra esperó la latencia y volvió a cotizar");
  // El SOL tras comprar: 0,01 − fee − renta. Tras la venta, otra fee; al cerrar, otra. Precio de venta del SOL: 149,99.
  const gasAtClose = (0.01 - 3 * FEE - TOKEN_ACCOUNT_RENT_SOL) * 149.99 * (1 - NATIVE_DRIFT_MARGIN);
  const expected = 62.5 * (1 + TP_TARGET_MARGIN) - gasAtClose;
  const qty = balance(m.id, "solana", RC);
  assert.ok(Math.abs(out.takeProfit.triggerPrice * qty - expected) < 0.001, `${out.takeProfit.triggerPrice * qty} frente a ${expected}`);
  // Más arriba que con los costes de siempre (0,0001 y la renta de vuelta): la misma misión necesita más subida.
  const simExpected = 62.5 * (1 + TP_TARGET_MARGIN) - (0.01 - 3 * config.solanaTxFeeSol) * 149.99 * (1 - NATIVE_DRIFT_MARGIN);
  assert.ok(expected > simExpected + 0.5);
  assert.ok(out.takeProfit.leavesAtLeastUsd >= 62.5);

  // Visible en mission_status, status_report y los datos de la retrospectiva.
  const st = (await missionStatus(m.id)) as Record<string, unknown>;
  assert.equal(st.costs, describeCostMode("real"));
  assert.match(await statusReport(m.id), /Costes: real: fee con prioridad de 0,00075 SOL/);
  assert.equal((memory.missionReviewData(m.id).mission as { cost_mode: string }).cost_mode, "real");
  const sim = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  assert.equal(((await missionStatus(sim.id)) as Record<string, unknown>).costs, "sim");
});

test("gemelo con costes realistas: su toma de beneficio con esos costes, la compra tras la latencia y la red y la renta en su resultado", async () => {
  setPrice(TW, 0.001);
  const pool = (token: string, ageSeconds: number) => ({
    id: `solana_pool_${token.slice(0, 6)}`,
    attributes: { address: `pool_${token.slice(0, 6)}`, name: "TW / SOL", pool_created_at: new Date(Date.now() - ageSeconds * 1000).toISOString(), reserve_in_usd: "20000", transactions: { m5: { buys: 50, sells: 20, buyers: 40 } } },
    relationships: { base_token: { data: { id: `solana_${token}` } }, quote_token: { data: { id: `solana_${SOL_MINT}` } }, dex: { data: { id: "pumpswap" } } },
  });
  const run = (id: number) => db.prepare("SELECT * FROM shadow_runs WHERE mission_id = ?").get(id) as { tp_usd: number; size_usd: number };
  const twins = (id: number) => db.prepare("SELECT * FROM shadow_positions WHERE mission_id = ? ORDER BY id").all(id) as Array<{ status: string; costs_usd: number; exit_usd: number | null; usd_in: number; tokens_raw: string }>;

  const sim = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(sim.id);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 }, { costMode: "real" });
  startMissionClock(m.id);
  assert.deepEqual(startShadowRun(m.id), { started: false, reason: "ya tenía gemelo" });
  // Misma misión, costes distintos: la toma de beneficio del gemelo realista queda más arriba (la del agente también).
  const gasAtClose = (0.01 - 3 * FEE - TOKEN_ACCOUNT_RENT_SOL) * 150 * (1 - NATIVE_DRIFT_MARGIN);
  assert.ok(Math.abs(run(m.id).tp_usd - (62.5 * (1 + TP_TARGET_MARGIN) - gasAtClose)) < 1e-9, String(run(m.id).tp_usd));
  assert.ok(run(m.id).tp_usd > run(sim.id).tp_usd + 0.5);

  const OPEN: Partial<ShadowTiming> = { quoteEveryMs: 1e12, jupiterPerTick: 8, signal: { geckoPageTtlMs: [60_000, 60_000], recheckMs: 0 } };
  const TRACK: Partial<ShadowTiming> = { ...OPEN, quoteEveryMs: 0 };
  pools = [pool(TW, 20)];
  // La compra tras la latencia sale un 5 % peor que la cotizada: revierte y no entra en ese evento.
  // (Cotizaciones del escáner: compra y venta; después, la compra tras la latencia.)
  next(1, 1, 0.95);
  const log = await checkShadows({ timing: OPEN });
  assert.ok(log.some((l) => /revierte tras la latencia/.test(l)), log.join("\n"));
  assert.equal(twins(m.id).length, 0);

  // Otro evento (el mismo token, ya descartado, no vuelve): esta vez entra con los tokens de la compra de después.
  pools = [pool(TW, 25), pool(TW2, 10)];
  next(1, 1, 0.99);
  // Solo el gemelo realista: el de la misión simulada no debe tomar el evento aquí.
  db.prepare("UPDATE shadow_runs SET status = 'abandoned' WHERE mission_id = ?").run(sim.id);
  await checkShadows({ timing: OPEN });
  const [t] = twins(m.id);
  assert.ok(t, "abre el gemelo");
  assert.equal(quotes, 3, "compra y venta del escáner, y la compra tras la latencia");
  assert.ok(Math.abs(Number(t!.tokens_raw) / 1e6 - (48.5 / 0.001) * (1 - POOL_FEE) * 0.99) < 1, t!.tokens_raw);
  // Red de la compra, la venta y convertir el gas, y la renta de su cuenta, a precio de venta del SOL.
  assert.ok(Math.abs(t!.costs_usd - (3 * FEE + TOKEN_ACCOUNT_RENT_SOL) * 149.99) < 1e-6, String(t!.costs_usd));

  // Salta la toma de beneficio, pero tras la latencia ya no llega: sigue abierto. Después sí.
  const tp = run(m.id).tp_usd;
  setPrice(TW2, 0.001 * (tp / 48.5) * 1.1 / 0.99);
  factors = [1, 0.8];
  await checkShadows({ timing: TRACK });
  assert.equal(twins(m.id)[0]!.status, "open");
  factors = [1, 1];
  await checkShadows({ timing: TRACK });
  assert.equal(twins(m.id)[0]!.status, "hit");

  // Resultado: la toma de beneficio menos lo que pagó y menos sus costes.
  db.prepare("UPDATE missions SET status = 'expired', ended_at = ?, final_usd = 50 WHERE id = ?").run(now(), m.id);
  db.prepare("UPDATE shadow_runs SET detect_until = ? WHERE mission_id = ?").run(new Date(Date.now() - 1000).toISOString(), m.id);
  await checkShadows({ timing: TRACK });
  const done = getMission(m.id)!;
  assert.equal(done.shadow_hits, 1);
  assert.ok(Math.abs(done.shadow_return! - (tp - 48.5 - t!.costs_usd) / 50) < 1e-9, String(done.shadow_return));
  const summary = memory.missionReviewData(m.id).twin!;
  assert.match(String(summary.costs), /costes realistas/);
  assert.equal((summary.positions[0] as { resultPct?: number }).resultPct, Number((((tp - t!.costs_usd) / 48.5 - 1) * 100).toFixed(1)));
  setPrice(TW2, 0.001);
});

test("estadísticas por clase: las misiones con costes realistas son otra serie y no se mezclan con las de siempre", async () => {
  const finish = async (costMode: "sim" | "real", status: "succeeded" | "expired") => {
    const m = await createMission(50, 62.5, 10, undefined, { solana: 100 }, { costMode });
    startMissionClock(m.id);
    db.prepare("UPDATE missions SET status = ?, ended_at = ?, final_usd = ? WHERE id = ?").run(status, now(), status === "succeeded" ? 62.5 : 45, m.id);
    return m.id;
  };
  const a = await finish("sim", "succeeded");
  await finish("sim", "succeeded");
  const c = await finish("real", "expired");
  const groups = classStats({ cls: "graduado-10m-+25%" }).filter((g) => g.perMission.some((p) => [a, c].includes(p.missionId)));
  const sim = groups.find((g) => g.costs === "sim")!;
  const real = groups.find((g) => g.costs === "real")!;
  assert.ok(sim.perMission.every((p) => p.missionId !== c), "la realista no entra en la serie de siempre");
  assert.ok(real.perMission.some((p) => p.missionId === c) && real.perMission.every((p) => p.missionId !== a));
  assert.equal(real.hits, 0);
  assert.ok(classStats({ cls: "graduado-10m-+25%", costMode: "real" }).every((g) => g.costs === "real"));
  // La retrospectiva de cada una trae la serie de su modo; el historial y recentApproach dicen el modo de cada misión.
  assert.equal((memory.missionReviewData(c).missionClass as { costs: string }).costs, "real");
  assert.equal((memory.missionReviewData(a).missionClass as { costs: string }).costs, "sim");
  assert.equal(missionHistory().find((h) => h.missionId === c)!.costs, "real");
  const approach = memory.recentApproach()!;
  assert.equal(approach.perMission.find((x) => x.missionId === c)!.costs, "real");
  assert.ok(approach.summary.byCosts && "real" in approach.summary.byCosts && "sim" in approach.summary.byCosts);
});
