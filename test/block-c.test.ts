// Bloque C: el revisor a mitad de misión recibe todo en una respuesta (checkpoint) y las esperas no
// pasan de 4,5 minutos (la caché de prompts de los subagentes dura 5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now } from "../src/db.js";
import * as memory from "../src/sim/memory.js";
import { createMission, startMissionClock } from "../src/sim/mission.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket } from "./fake-market.js";

installFakeMarket();

const mission = await createMission(1000, 1200, 60, undefined, { solana: 100 });
const ctx = { sessionId: 1, missionId: mission.id };

test("checkpoint: lo nuevo, las creencias que tocan las posiciones nuevas y los howtos por título", () => {
  const applied = memory.writeBelief({ statement: "Los pools muy jóvenes con compradores netos suben en los primeros minutos", appliesTo: "Solana", missionId: null });
  const matching = memory.writeBelief({
    statement: "Liquidez por debajo de 20k suele acabar en rug de liquidez",
    appliesTo: "Solana",
    expectation: "negative",
    condition: { all: [{ f: "liquidityUsd", op: "<", v: 20000 }] },
    missionId: null,
  });
  const unrelated = memory.writeBelief({
    statement: "Los tokens con mcap por encima de mil millones apenas se mueven en una hora",
    appliesTo: "Solana",
    expectation: "negative",
    condition: { all: [{ f: "mcapUsd", op: ">", v: 1e9 }] },
    missionId: null,
  });
  db.prepare(
    `INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, status, qty_open, cost_open_usd, realized_cost_usd, realized_proceeds_usd, entry_features, research, beliefs_applied)
     VALUES (?, 'solana', 'NEWPOS', 'NEW', ?, 'open', 10, 10, 0, 0, ?, '{}', ?)`,
  ).run(mission.id, now(), JSON.stringify({ venue: "solana", liquidityUsd: 15000, mcapUsd: 90000 }), JSON.stringify([applied.id]));

  const cp = memory.checkpointData(mission.id);
  const ids = cp.memory.beliefsTouched.map((b) => b.id).sort();
  assert.deepEqual(ids, [applied.id, matching.id].sort());
  assert.ok(!ids.includes(unrelated.id));
  assert.match(cp.memory.otherBeliefs, /creencias más/);
  assert.ok(Array.isArray(cp.memory.howtos));
  assert.ok(cp.positions.some((p) => p.symbol === "NEW"));
  assert.equal(cp.since, mission.created_at);

  // Tras review_checkpoint, la siguiente revisión parte de ahí.
  memory.reviewCheckpoint(mission.id, "revisado");
  assert.ok(memory.checkpointData(mission.id).since > mission.created_at);
});

test("las esperas no pasan de 4,5 minutos", async () => {
  assert.equal((await runTool("wait", { minutes: 10 }, ctx)).isError, true);
  assert.equal((await runTool("wait_for_activity", { max_minutes: 5 }, ctx)).isError, true);
});

test("strategy_fit cuenta los costes del futuro: 50 → 55 a 20x pide ~+0,72 %, no +0,5 %", async () => {
  const { perpMoveNeeded } = await import("../src/sim/fit.js");
  const x = perpMoveNeeded(50, 55, 20);
  assert.ok(x > 0.0071 && x < 0.0073, String(x));
});

test("una orden que vende el token vigila el precio de venta real (cotización), no el de la API", async () => {
  const { tokens, setPrice } = await import("./fake-market.js");
  const { placeOrder } = await import("../src/sim/orders.js");
  const { getHoldings } = await import("../src/sim/portfolio.js");
  const { USDC_MINT } = await import("../src/market/jupiter.js");
  startMissionClock(mission.id);
  const mint = Object.keys(tokens).find((m) => tokens[m]!.symbol !== "USDC" && tokens[m]!.symbol !== "SOL")!;
  setPrice(mint, 2);
  const thesis = { why: "prueba", evidence: "prueba", sources: ["test"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y creencias negativas" };
  const buy = await runTool("simulate_swap", { chain: "solana", input: "USDC", output: mint, amount: 20, slippage_bps: 100, thesis }, ctx);
  assert.ok(!buy.isError, String(buy.content));
  assert.ok((getHoldings(mission.id).find((h) => h.asset === mint)?.amount ?? 0) > 0);
  // La API dice 2; vender da 2 × (1 − 0,3 %) = 1,994. Un stop en 1,996 ya se cumple con el precio de venta.
  const action = { input: mint, output: USDC_MINT, amount: 0, sellAll: true, slippageBps: 100 };
  await assert.rejects(
    placeOrder({ missionId: mission.id, sessionId: null, venue: "solana", triggerAsset: mint, condition: "below", triggerPrice: 1.996, action, reasoning: "stop" }),
    /ya se cumple \(precio actual de .*: 1\.99/,
  );
  // Una orden que compra el token vigilado sigue usando el precio de la API.
  const r = await placeOrder({ missionId: mission.id, sessionId: null, venue: "solana", triggerAsset: mint, condition: "below", triggerPrice: 1.5, action: { input: USDC_MINT, output: mint, amount: 5, slippageBps: 100 }, reasoning: "compra" });
  assert.equal("currentPrice" in r ? r.currentPrice : null, 2);
});

test("panel: el briefing previo al reloj y lo aprendido al cerrar la misión anterior salen en la misión actual", async () => {
  const { timeline } = await import("../src/dashboard/timeline.js");
  const { logActivity } = await import("../src/db.js");
  const { stopMission } = await import("../src/sim/mission.js");
  await stopMission(false, mission.id);
  logActivity({ missionId: mission.id, sessionId: null, kind: "review", title: "Retrospectiva de la misión" });
  const next = await createMission(1000, 1100, 30, undefined, { solana: 100 });
  const early = new Date(Date.now() - 60_000).toISOString();
  db.prepare("INSERT INTO activity (ts, mission_id, session_id, kind, title) VALUES (?, ?, NULL, 'review', 'El revisor actualiza el briefing del agente')").run(early, next.id);
  const ev = timeline(new Date().toISOString(), next.id);
  assert.ok(ev.some((e) => e.title === "El revisor actualiza el briefing del agente"), "el briefing escrito antes de arrancar el reloj");
  assert.ok(ev.some((e) => e.title === `Misión #${mission.id}: Retrospectiva de la misión`), "la retrospectiva de la anterior");
});

test("una orden que vende todo un token del que ya no queda nada se cancela sola", async () => {
  const { tokens, setPrice } = await import("./fake-market.js");
  const { placeOrder, checkOrders } = await import("../src/sim/orders.js");
  const { USDC_MINT } = await import("../src/market/jupiter.js");
  const m2 = await createMission(1000, 1100, 30, undefined, { solana: 100 });
  startMissionClock(m2.id);
  const c2 = { sessionId: 1, missionId: m2.id };
  const mint = Object.keys(tokens).find((m) => tokens[m]!.symbol !== "USDC" && tokens[m]!.symbol !== "SOL")!;
  setPrice(mint, 2);
  const thesis = { why: "prueba", evidence: "prueba", sources: ["test"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y creencias negativas" };
  assert.ok(!(await runTool("simulate_swap", { chain: "solana", input: "USDC", output: mint, amount: 20, slippage_bps: 100, thesis }, c2)).isError);
  const tp = await placeOrder({ missionId: m2.id, sessionId: null, venue: "solana", triggerAsset: mint, condition: "above", triggerPrice: 3, action: { input: mint, output: USDC_MINT, amount: 0, sellAll: true, slippageBps: 100 }, reasoning: "tp" });
  assert.ok(!(await runTool("simulate_swap", { chain: "solana", input: mint, output: "USDC", sell_all: true, slippage_bps: 100, thesis }, c2)).isError);
  await checkOrders();
  assert.equal((db.prepare("SELECT status FROM orders WHERE id = ?").get(tp.id) as { status: string }).status, "cancelled");
});

test("el revisor corrige solo los campos de una retrospectiva que indique", async () => {
  const memory = await import("../src/sim/memory.js");
  const { stopMission } = await import("../src/sim/mission.js");
  const m3 = await createMission(1000, 1100, 30, undefined, { solana: 100 });
  await stopMission(false, m3.id);
  memory.writeMissionReview({ missionId: m3.id, whatWasTried: "probar", whatHappened: "5 de 9 en total", nextTime: "seguir" });
  const r = await runTool("revise_mission_review", { mission_id: m3.id, what_happened: "7 de 15 en total", reason: "la cuenta estaba mal" }, { sessionId: 1, missionId: m3.id });
  assert.ok(!r.isError, String(r.content));
  const row = db.prepare("SELECT what_was_tried, what_happened, next_time FROM mission_reviews WHERE mission_id = ?").get(m3.id) as Record<string, string>;
  assert.deepEqual({ ...row }, { what_was_tried: "probar", what_happened: "7 de 15 en total", next_time: "seguir" });
  assert.equal((await runTool("revise_mission_review", { mission_id: m3.id, reason: "nada" }, { sessionId: 1, missionId: m3.id })).isError, true);
});

test("una toma de beneficio es una orden límite: si al vender el precio no llega, no se llena ni cobra nada", async () => {
  const { tokens, setPrice } = await import("./fake-market.js");
  const { swap, getHoldings, LimitNotReached } = await import("../src/sim/portfolio.js");
  const m4 = await createMission(1000, 1100, 30, undefined, { solana: 100 });
  const mint = Object.keys(tokens).find((m) => tokens[m]!.symbol !== "USDC" && tokens[m]!.symbol !== "SOL")!;
  setPrice(mint, 2);
  await swap({ missionId: m4.id, sessionId: null, chain: "solana", input: "USDC", output: mint, amount: 20, slippageBps: 100, reasoning: "test" });
  const before = JSON.stringify(getHoldings(m4.id));
  const qty = getHoldings(m4.id).find((h) => h.asset === mint)!.amount;
  // Vender da 2 × (1 − 0,3 %) por unidad: un límite de 2,1 por unidad no se alcanza.
  await assert.rejects(
    swap({ missionId: m4.id, sessionId: null, chain: "solana", input: mint, output: "USDC", sellAll: true, slippageBps: 100, reasoning: "tp", minOut: qty * 2.1 }),
    (e: unknown) => e instanceof LimitNotReached,
  );
  assert.equal(JSON.stringify(getHoldings(m4.id)), before, "sin cambios en la cartera");
  await swap({ missionId: m4.id, sessionId: null, chain: "solana", input: mint, output: "USDC", sellAll: true, slippageBps: 100, reasoning: "tp", minOut: qty * 1.9 });
  assert.equal(getHoldings(m4.id).find((h) => h.asset === mint)?.amount ?? 0, 0);
});

test("write_briefing con append añade al briefing actual sin borrarlo", async () => {
  const memory = await import("../src/sim/memory.js");
  const m5 = await createMission(1000, 1100, 30, undefined, { solana: 100 });
  const c5 = { sessionId: 1, missionId: m5.id };
  await runTool("write_briefing", { mission_id: m5.id, text: "Base: la #5." }, c5);
  await runTool("write_briefing", { mission_id: m5.id, text: "Cuidado con el pico.", append: true }, c5);
  const t = memory.getBriefing(m5.id)!.text;
  assert.match(t, /^Base: la #5\.\n\nActualización \(\d\d:\d\d UTC\): Cuidado con el pico\.$/);
});

test("si un error se repite y el revisor ya le enlazó un howto, el agente lo ve en ese momento", async () => {
  const memory = await import("../src/sim/memory.js");
  const h = memory.writeHowto({ scope: "solana", topic: "slippage", title: "Slippage de entrada en tokens que se mueven rápido", steps: "Usa 8-15 %, nunca 3 %.", missionId: null });
  const msg = (sym: string) => `El swap revierte: el precio se ha movido más que tu slippage. Cotizaste 1000 ${sym} y ahora saldrían 900 (10 % menos; tu límite era 3 %).`;
  memory.recordToolError({ missionId: null, sessionId: null, tool: "simulate_swap", input: {}, message: msg("rock") });
  const id = (db.prepare("SELECT MAX(id) AS id FROM tool_errors").get() as { id: number }).id;
  db.prepare("UPDATE tool_errors SET howto_id = ? WHERE id = ?").run(h, id);
  const found = memory.howtoForError(msg("POND"));
  assert.equal(found?.id, h, "mismo tipo de error aunque cambie el token");
});
