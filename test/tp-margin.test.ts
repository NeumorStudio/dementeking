// La toma de beneficio en el objetivo tiene que dejar la misión cumplida cuando salta. En la M3 de la v0.37.0 (50 $ →
// 62,50 $) saltó y se llenó en 60,91 USDC, pero el gas que quedaba en SOL valía 1,46 $: 62,37 < 62,50, y la misión se
// perdió por 0,13 $ con la toma de beneficio hecha. Ahora el resto de la cartera se cuenta como quedará al cerrar (la red
// de la venta y la de convertir el gas, y su precio un 0,5 % más bajo), y un tp_ratio que se queda corto por poco se sube.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOL_MINT, USDC_MINT } from "../src/market/jupiter.js";
import { checkMission, createMission, getMission, startMissionClock } from "../src/sim/mission.js";
import { liftTakeProfit, NATIVE_DRIFT_MARGIN, restAtCloseUsd, takeProfitProceeds, TP_LIFT_BAND, type RestAfterSale } from "../src/sim/mission-kind.js";
import { checkOrders, placeOrder } from "../src/sim/orders.js";
import { writePlan, type PlanBody } from "../src/sim/plans.js";
import { balance, swap, valuation } from "../src/sim/portfolio.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, MEME, POOL_FEE, setPrice } from "./fake-market.js";

installFakeMarket();

const text = (r: { content: unknown }) => String(r.content);

/** Lo que dio la venta de la toma de beneficio de la M3 y lo que valía el gas después. */
const M3_FILL = 60.91;
const M3_GAS_USD = 1.46;
/** El SOL que queda tras comprar con todo el USDC y vender todo el token (0,01 SOL menos dos fees de 0,0001). */
const GAS_AFTER_SALE = 0.0098;
/** El precio del SOL que deja ese gas en 1,46 $ (el de la M3 al saltar). */
const SOL_AT_FILL = M3_GAS_USD / GAS_AFTER_SALE;

test("cuentas de la M3: 60,91 + 1,46 no llega a 62,50; la toma de beneficio de ahora sí, aunque el SOL baje un 0,5 %", () => {
  assert.ok(M3_FILL + M3_GAS_USD < 62.5, "la M3 se quedó corta con la toma de beneficio hecha");
  const rest: RestAfterSale = { otherUsd: 0, nativeAfterSale: GAS_AFTER_SALE, closeFeeNative: 0.0001, nativeUsd: SOL_AT_FILL };
  // En el objetivo: la venta más el gas en bruto (a su precio de venta, sin descontar nada).
  const proceeds = takeProfitProceeds(62.5, rest);
  assert.ok(proceeds + GAS_AFTER_SALE * SOL_AT_FILL >= 62.5, `${proceeds}`);
  // Aunque el SOL baje un 0,5 % mientras espera, y también lo realizado al convertir el gas (red y comisión del pool).
  assert.ok(proceeds + GAS_AFTER_SALE * SOL_AT_FILL * (1 - NATIVE_DRIFT_MARGIN) >= 62.5);
  assert.ok(proceeds + (GAS_AFTER_SALE - 0.0001) * SOL_AT_FILL * (1 - POOL_FEE) >= 62.5);
  // Y sin pasarse: la toma de beneficio queda a menos de 0,15 $ de lo justo (cada punto de más resta aciertos).
  assert.ok(proceeds - (62.5 - GAS_AFTER_SALE * SOL_AT_FILL) < 0.15, `${proceeds}`);

  // El tp_ratio de la M3 (60,91 $ de 48,50 $: ×1,256) se queda corto por poco: se sube al objetivo.
  const lifted = liftTakeProfit({ ratioProceeds: M3_FILL, targetUsd: 62.5, rest });
  assert.equal(lifted.proceeds, proceeds);
  assert.ok(lifted.liftedFromUsd! < 62.5 && lifted.liftedFromUsd! > 62.5 * (1 - TP_LIFT_BAND));
  // Uno que ya llega se respeta, y uno muy por debajo (salir antes a propósito) también.
  assert.deepEqual(liftTakeProfit({ ratioProceeds: 62, targetUsd: 62.5, rest }), { proceeds: 62 });
  assert.deepEqual(liftTakeProfit({ ratioProceeds: 53, targetUsd: 62.5, rest }), { proceeds: 53 });
  assert.ok(Math.abs(restAtCloseUsd(rest) - (GAS_AFTER_SALE - 0.0001) * SOL_AT_FILL * (1 - NATIVE_DRIFT_MARGIN)) < 1e-12);
});

test("la M3 en el simulador: con su toma de beneficio (60,91 $) no se consigue; con la de ahora, sí", async () => {
  // Así fue la M3: todo el USDC en el token y la venta en 60,91 USDC. El SOL baja a lo que deja el gas en 1,46 $.
  setPrice(SOL_MINT, 150);
  setPrice(MEME, 0.01);
  const old = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(old.id);
  await swap({ missionId: old.id, sessionId: null, chain: "solana", input: USDC_MINT, output: MEME, amount: balance(old.id, "solana", USDC_MINT), slippageBps: 300, reasoning: "compra" });
  const qty = balance(old.id, "solana", MEME);
  await placeOrder({
    missionId: old.id,
    sessionId: null,
    venue: "solana",
    triggerAsset: MEME,
    condition: "above",
    triggerPrice: M3_FILL / qty,
    action: { input: MEME, output: "USDC", amount: 0, sellAll: true, slippageBps: 300 },
    reasoning: "la toma de beneficio de la M3",
  });
  setPrice(SOL_MINT, SOL_AT_FILL);
  setPrice(MEME, 0.0135);
  await checkOrders();
  assert.ok(Math.abs(balance(old.id, "solana", USDC_MINT) - M3_FILL) < 1e-6, "se llenó en 60,91");
  await checkMission(old.id);
  const v = await valuation(old.id);
  assert.equal(getMission(old.id)!.status, "active", "no se consigue");
  assert.ok(v.totalUsd < 62.5 && v.totalUsd > 62.3, `se queda en ${v.totalUsd} (la M3: 62,37)`);

  // Ahora: el mismo plan (tp_ratio ×1,256, que da esos 60,91 $), la misma subida y la misma bajada del SOL.
  setPrice(SOL_MINT, 150);
  setPrice(MEME, 0.01);
  const body: PlanBody = {
    event: "graduado",
    source: "graduado",
    filters: {},
    sizing: "todo el capital menos el gas",
    tp_ratio: M3_FILL / 48.5,
    reentry: "no",
    reentry_allowed: false,
    risks_checked: "revisé riskCheck y las creencias negativas",
    why: "x",
    evidence: "x",
    sources: ["x"],
  };
  const plan = writePlan({ cls: "graduado-10m-+25%", body, predictedP: 0.35, baselineP: 0.35, missionId: null, sessionId: null });
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const r = await runTool("enter_with_exits", { token: MEME, thesis: { plan_ref: plan.id } }, { sessionId: 1, missionId: m.id });
  assert.ok(!r.isError, text(r));
  const tp = JSON.parse(text(r)).takeProfit;
  assert.match(tp.basis, /el objetivo de la misión, neto de costes: con ×1\.25\d+ del precio de compra \(plan #\d+\), al saltar la cartera se quedaba en 62\.\d\d \$, por debajo del objetivo/);
  assert.ok(tp.leavesAtLeastUsd >= 62.5, `si salta deja ${tp.leavesAtLeastUsd}`);
  assert.equal(tp.belowTarget, undefined);

  setPrice(SOL_MINT, SOL_AT_FILL);
  setPrice(MEME, 0.0135);
  await checkOrders();
  await checkMission(m.id);
  const done = getMission(m.id)!;
  assert.equal(done.status, "succeeded", "la toma de beneficio deja la misión cumplida");
  assert.ok(done.final_usd! >= 62.5, `final ${done.final_usd}, también tras convertir el gas`);
  setPrice(SOL_MINT, 150);
});

test("toma de beneficio en el objetivo: con el SOL un 0,5 % más bajo al saltar, la misión se consigue igual", async () => {
  setPrice(SOL_MINT, 150);
  setPrice(MEME, 0.01);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y las creencias negativas" };
  const r = await runTool("enter_with_exits", { token: MEME, tp_at_target: true, thesis }, { sessionId: 1, missionId: m.id });
  assert.ok(!r.isError, text(r));
  const tp = JSON.parse(text(r)).takeProfit;
  assert.equal(tp.basis, "el objetivo de la misión, neto de costes");
  setPrice(SOL_MINT, 150 * (1 - NATIVE_DRIFT_MARGIN));
  setPrice(MEME, 0.0135);
  await checkOrders();
  await checkMission(m.id);
  const done = getMission(m.id)!;
  assert.equal(done.status, "succeeded");
  assert.ok(done.final_usd! >= 62.5, `final ${done.final_usd}`);
  setPrice(SOL_MINT, 150);
});
