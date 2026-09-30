// v0.37.1: el cierre por objetivo con los mismos costes que la toma de beneficio en el objetivo, y lo que no debe matar
// una orden. Antes checkMission daba el objetivo por alcanzado con la valoración en bruto (el SOL sin la red de la venta
// ni la de convertirlo): con costes realistas se adelantaba ~0,29 $ a la toma de beneficio, la cancelaba, vendía a
// mercado tras la latencia y dejaba la misión sin posición o "conseguida" por debajo del objetivo.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { SOL_MINT, USDC_MINT } from "../src/market/jupiter.js";
import { checkMission, createMission, getMission, missionMeasurement, startMissionClock } from "../src/sim/mission.js";
import { checkOrders, placeOrder } from "../src/sim/orders.js";
import { balance, swap, valuation } from "../src/sim/portfolio.js";
import { checkShadows, SHADOW_TIMING } from "../src/sim/shadow.js";
import { statusReport } from "../src/sim/status.js";
import { runTool, SIM_TOOLS } from "../src/tools/index.js";
import { POOL_FEE, setExtraRoutes, setPrice, tokens } from "./fake-market.js";

const CC = "CierreCostes111111111111111111111111111pump";
const TW = "CierreGemeLo111111111111111111111111111pump";
tokens[CC] = { symbol: "CC", decimals: 6, price: 0.01, launchpad: "pump.fun" };
tokens[TW] = { symbol: "TW", decimals: 6, price: 0.001, launchpad: "pump.fun" };
config.latencyMs = 20;
const FEE = 0.00075;

// Las ventas de CC y TW con 300 bps (las de los swaps, las de la toma de beneficio y las del gemelo; la valoración cotiza
// con 100 y no pasa por aquí) toman cada una el siguiente paso: un multiplicador sobre el precio del mercado falso, o
// "500" (Jupiter falla). Sin pasos, el precio del mercado.
type Step = number | "500";
let steps: Step[] = [];
function route(url: URL): Response | undefined {
  if (url.host === "api.geckoterminal.com") return new Response(JSON.stringify({ data: [] }));
  if (url.host !== "lite-api.jup.ag" || url.pathname !== "/swap/v1/quote") return undefined;
  const inMint = url.searchParams.get("inputMint")!;
  if (![CC, TW].includes(inMint) || url.searchParams.get("slippageBps") !== "300") return undefined;
  const step = steps.length ? steps.shift()! : 1;
  if (step === "500") return new Response("upstream error", { status: 500 });
  const a = tokens[inMint]!;
  const out = (Number(url.searchParams.get("amount")) / 10 ** a.decimals) * a.price * (1 - POOL_FEE) * step;
  const plan = [{ percent: 100, swapInfo: { label: "Fake AMM", ammKey: "fake" } }];
  return new Response(JSON.stringify({ inAmount: url.searchParams.get("amount"), outAmount: String(Math.floor(out * 1e6)), priceImpactPct: "0", slippageBps: 300, routePlan: plan, contextSlot: 1 }));
}
/** Los próximos pasos de las ventas (y vacía la caché HTTP). */
function next(...s: Step[]) {
  steps = s;
  setExtraRoutes(route);
}
next();

const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y las creencias negativas" };
const orderStatus = (id: number) => (db.prepare("SELECT status FROM orders WHERE id = ?").get(id) as { status: string }).status;

/** Misión rápida 50 $ → 62,50 $ con todo el USDC en CC y la toma de beneficio en el objetivo. */
async function enterAtTarget(costMode: "sim" | "real") {
  setPrice(SOL_MINT, 150);
  setPrice(CC, 0.01);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 }, { costMode });
  next();
  const r = await runTool("enter_with_exits", { token: CC, tp_at_target: true, thesis }, { sessionId: 1, missionId: m.id });
  assert.ok(!r.isError, String(r.content));
  const tp = JSON.parse(String(r.content)).takeProfit as { orderId: number; triggerPrice: number };
  const qty = balance(m.id, "solana", CC);
  const solUsd = (await valuation(m.id)).holdings.find((h) => h.asset === SOL_MINT)!.usd;
  return {
    m,
    tp,
    qty,
    solUsd,
    /** Lo que da la toma de beneficio al llenarse. */
    tpUsd: tp.triggerPrice * qty,
    /** Pone el precio de CC en el que vender todo da `usd` USDC. */
    tokenAt: (usd: number) => setPrice(CC, usd / (qty * (1 - POOL_FEE))),
  };
}

test("costes realistas: checkMission ya no se adelanta a la toma de beneficio ni vende por debajo del objetivo", async () => {
  const { m, tp, qty, solUsd, tpUsd, tokenAt } = await enterAtTarget("real");

  // a) La valoración en bruto pasa del objetivo (62,70 $), pero lo que quedaría al cerrar no (la red de la venta y la de
  // convertir el SOL): la toma de beneficio está más arriba y manda ella. Antes: se cancelaba y se vendía a mercado.
  tokenAt(tpUsd - 0.09);
  next();
  assert.ok((await valuation(m.id)).totalUsd > 62.6, "en bruto, por encima del objetivo");
  assert.deepEqual(await checkMission(m.id), []);
  assert.equal(getMission(m.id)!.status, "active");
  assert.equal(balance(m.id, "solana", CC), qty);
  assert.equal(orderStatus(tp.orderId), "open");

  // b) Ahora sí llega al cerrar (+0,03 $ sobre el objetivo, aún por debajo de la toma de beneficio), pero tras la latencia
  // la venta sale un 3 % peor: no llega a su mínimo, así que no se vende ni se paga nada, y la toma de beneficio sigue.
  tokenAt(tpUsd - 0.03);
  const sol = balance(m.id, "solana", SOL_MINT);
  next(1, 0.97);
  const log = await checkMission(m.id);
  assert.match(log.join("\n"), /El precio no llega al límite[\s\S]*Las órdenes abiertas siguen puestas \(#\d+\)/);
  assert.equal(getMission(m.id)!.status, "active");
  assert.equal(balance(m.id, "solana", CC), qty, "no se ha vendido");
  assert.equal(balance(m.id, "solana", SOL_MINT), sol, "ni se ha pagado la red");
  assert.equal(orderStatus(tp.orderId), "open", "la toma de beneficio sigue puesta");

  // c) Con el precio quieto, se cierra y lo que queda llega al objetivo (también tras convertir el SOL).
  next(1, 1);
  await checkMission(m.id);
  const done = getMission(m.id)!;
  assert.equal(done.status, "succeeded");
  assert.ok(done.final_usd! >= 62.5, `final ${done.final_usd}`);
  assert.ok(solUsd > 1, "el SOL que quedaba contaba");
  setPrice(CC, 0.01);
});

test("una misión que no llega de verdad no queda como conseguida: SOL un 5 % más bajo al llenarse, o una venta peor al acabar el plazo", async () => {
  // Costes de siempre: la toma de beneficio se llena con el SOL un 5 % más bajo. En bruto la cartera pasa del objetivo
  // (antes: "conseguida" con 62,49 $ tras convertir el SOL); al cerrar no llega, así que no se da por conseguida.
  const a = await enterAtTarget("sim");
  setPrice(SOL_MINT, 150 * 0.95);
  a.tokenAt(a.tpUsd * 1.01);
  next();
  await checkOrders();
  assert.equal(orderStatus(a.tp.orderId), "filled");
  assert.ok((await valuation(a.m.id)).totalUsd > 62.5, "en bruto llega");
  await checkMission(a.m.id);
  assert.equal(getMission(a.m.id)!.status, "active");
  assert.equal(getMission(a.m.id)!.final_usd, null);

  // Con un 4 %, el margen de la toma de beneficio aún lo cubre: conseguida y por encima del objetivo.
  const b = await enterAtTarget("sim");
  setPrice(SOL_MINT, 150 * 0.96);
  b.tokenAt(b.tpUsd * 1.01);
  next();
  await checkOrders();
  await checkMission(b.m.id);
  assert.equal(getMission(b.m.id)!.status, "succeeded");
  assert.ok(getMission(b.m.id)!.final_usd! >= 62.5, String(getMission(b.m.id)!.final_usd));

  // Costes realistas y el plazo acabado con la valoración en el objetivo: la venta a mercado sale un 2 % peor tras la
  // latencia (dentro de su slippage) y lo que queda no llega. Antes: "conseguida" con ~61,3 $.
  const c = await enterAtTarget("real");
  c.tokenAt(c.tpUsd - 0.03);
  db.prepare("UPDATE missions SET deadline = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), c.m.id);
  next(1, 0.98);
  await checkMission(c.m.id);
  const done = getMission(c.m.id)!;
  assert.equal(done.status, "expired");
  assert.equal(done.end_reason, "deadline");
  assert.ok(done.final_usd! < 62.5, String(done.final_usd));
  setPrice(SOL_MINT, 150);
  setPrice(CC, 0.01);
});

test("costes realistas: si la cotización de después de la latencia falla, la toma de beneficio sigue abierta", async () => {
  setPrice(CC, 0.01);
  const m = await createMission(100, 125, 30, undefined, { solana: 100 }, { costMode: "real" });
  startMissionClock(m.id);
  next();
  await swap({ missionId: m.id, sessionId: null, chain: "solana", input: USDC_MINT, output: CC, amount: 20, slippageBps: 300, reasoning: "compra" });
  const qty = balance(m.id, "solana", CC);
  const order = await placeOrder({
    missionId: m.id,
    sessionId: null,
    venue: "solana",
    triggerAsset: CC,
    condition: "above",
    triggerPrice: 25 / qty,
    action: { input: CC, output: "USDC", amount: 0, sellAll: true, slippageBps: 300 },
    reasoning: "tp",
  });
  setPrice(CC, 0.0135);
  // Salta (la venta da ~26,7 $) y la cotización de tras la latencia devuelve HTTP 500: no se ha enviado nada. Antes: 'failed'.
  next(1, "500");
  const log = await checkOrders();
  assert.match(log.join("\n"), /sin cotización para comprobar el límite \(HTTP 500[\s\S]*sigue abierta/);
  assert.equal(orderStatus(order.id), "open");
  assert.equal(balance(m.id, "solana", CC), qty);
  // En la vuelta siguiente Jupiter responde: se llena en su límite.
  next(1, 1);
  await checkOrders();
  assert.equal(orderStatus(order.id), "filled");
  assert.equal(balance(m.id, "solana", CC), 0);
  setPrice(CC, 0.01);
});

test("costes realistas: una orden por tiempo que revierte por la latencia se reenvía, como el cierre", async () => {
  setPrice(CC, 0.01);
  const m = await createMission(100, 125, 30, undefined, { solana: 100 }, { costMode: "real" });
  startMissionClock(m.id);
  next();
  await swap({ missionId: m.id, sessionId: null, chain: "solana", input: USDC_MINT, output: CC, amount: 20, slippageBps: 300, reasoning: "compra" });
  const order = await placeOrder({
    missionId: m.id,
    sessionId: null,
    venue: "solana",
    condition: "time",
    inMinutes: 0.0001,
    action: { input: CC, output: "USDC", amount: 0, sellAll: true, slippageBps: 300 },
    reasoning: "salida por tiempo",
  });
  await new Promise((r) => setTimeout(r, 50));
  const sol = balance(m.id, "solana", SOL_MINT);
  // El primer envío sale un 5 % peor tras la latencia (más que sus 300 bps): revierte y paga la red; el segundo entra.
  // Antes: 'failed' al primero, con la posición abierta.
  next(1, 0.95);
  await checkOrders();
  assert.equal(orderStatus(order.id), "filled");
  assert.equal(balance(m.id, "solana", CC), 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM journal WHERE mission_id = ? AND kind = 'failed_tx'").get(m.id) as { n: number }).n, 1);
  assert.ok(Math.abs(sol - balance(m.id, "solana", SOL_MINT) - 2 * FEE) < 1e-12, "la red del que revirtió y la del que entró");
});

test("gemelo con costes realistas: sin la cotización de después de la latencia no llena su toma de beneficio, tampoco al acabar su plazo", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 }, { costMode: "real" });
  startMissionClock(m.id);
  // Sin eventos nuevos: solo se sigue el gemelo de abajo.
  db.prepare("UPDATE shadow_runs SET detect_until = ? WHERE mission_id = ?").run(new Date(Date.now() - 1000).toISOString(), m.id);
  const tp = (db.prepare("SELECT tp_usd FROM shadow_runs WHERE mission_id = ?").get(m.id) as { tp_usd: number }).tp_usd;
  // Un gemelo con 48,5 $ de TW que ha cumplido su plazo hace 1 s; vender ahora da un 2 % más que su toma de beneficio.
  const nowMs = Date.now();
  const expiresMs = nowMs - 1000;
  db.prepare(
    `INSERT INTO shadow_positions (mission_id, token, symbol, pool, opened_at, expires_at, usd_in, tokens_raw, decimals, entry_value_usd, last_value_usd, best_value_usd, last_quote_at, quotes, costs_usd)
     VALUES (?, ?, 'TW', 'pool', ?, ?, 48.5, ?, 6, 47, 47, 47, ?, 1, 0.5)`,
  ).run(m.id, TW, new Date(nowMs - 600_000).toISOString(), new Date(expiresMs).toISOString(), String(Math.floor((48.5 / 0.001) * 1e6)), new Date(nowMs - 6000).toISOString());
  setPrice(TW, (0.001 * (tp / 48.5) * 1.02) / (1 - POOL_FEE));
  const twin = () => db.prepare("SELECT status, exit_usd FROM shadow_positions WHERE mission_id = ?").get(m.id) as { status: string; exit_usd: number | null };

  // La de después de la latencia falla: sigue abierto (antes: 'hit' con la cotización de antes de la latencia).
  next(1, "500");
  await checkShadows({ timing: { quoteEveryMs: 0, jupiterPerTick: 8 } });
  assert.equal(twin().status, "open");
  // Pasado su margen sin confirmarla, se cierra por tiempo: como mucho con su toma de beneficio, y sin acierto.
  next();
  await checkShadows({ timing: { quoteEveryMs: 0, jupiterPerTick: 8 }, nowMs: expiresMs + SHADOW_TIMING.lateMs + 1000 });
  assert.equal(twin().status, "expired");
  assert.ok(Math.abs(twin().exit_usd! - tp) < 1e-9, `${twin().exit_usd} frente a ${tp}`);
  setPrice(TW, 0.001);
});

test("una misión cancelada sin arrancar el reloj mide su preparación hasta que se canceló, no hasta ahora", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  db.prepare("UPDATE missions SET created_at = ?, requested_at = ? WHERE id = ?").run(ago(61), ago(61), m.id);
  await checkMission(m.id);
  assert.equal(getMission(m.id)!.end_reason, "prep_timeout");
  // Un día después.
  db.prepare("UPDATE missions SET created_at = ?, requested_at = ?, ended_at = ? WHERE id = ?").run(ago(61 + 1440), ago(61 + 1440), ago(1440), m.id);
  const measured = missionMeasurement(getMission(m.id)!)!;
  assert.equal(measured.prepMinutes, 61);
  assert.match(String(measured.prepNote), /se canceló sin arrancar el reloj/);
  assert.match(await statusReport(m.id), /Tiempos: preparación 61 min, sin llegar a arrancar el reloj/);
  // Una que sigue preparándose, hasta ahora.
  const active = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  db.prepare("UPDATE missions SET requested_at = ? WHERE id = ?").run(ago(5), active.id);
  assert.match(String(missionMeasurement(getMission(active.id)!)!.prepNote), /hasta ahora/);
});

test("simulate_swap avisa de la latencia con costes realistas y el revisor sabe que cada fila de missionClasses es una serie de costes", () => {
  const description = SIM_TOOLS.find((t) => t.name === "simulate_swap")!.description;
  assert.match(description, /siempre se vuelve a cotizar tras la latencia[\s\S]*~300 bps/);
  const reviewer = readFileSync(new URL("../plugin/agents/reviewer.md", import.meta.url), "utf8");
  assert.match(reviewer, /su campo `costs`[\s\S]*no se suman ni se comparan entre sí/);
});
