// Bloque B: intervalo de Wilson y etapas de las creencias, resumen equilibrado y checklist previo a comprar.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now } from "../src/db.js";
import * as memory from "../src/sim/memory.js";
import { createMission, startMissionClock } from "../src/sim/mission.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, MEME } from "./fake-market.js";

installFakeMarket();

test("intervalo de Wilson: con pocos casos es ancho", () => {
  assert.deepEqual(memory.wilson(3, 3), { low: 44, high: 100 });
  assert.deepEqual(memory.wilson(17, 18), { low: 74, high: 99 });
  assert.deepEqual(memory.wilson(0, 0), { low: 0, high: 100 });
  assert.equal(memory.beliefStage(9), "hypothesis");
  assert.equal(memory.beliefStage(10), "provisional");
  assert.equal(memory.beliefStage(30), "rule");
});

const mission = await createMission(1000, 1200, 60, undefined, { solana: 100 });
startMissionClock(mission.id);
let n = 0;
const closed = (entry: Record<string, unknown>, pnl: number) =>
  db
    .prepare(
      `INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, closed_at, status, qty_open, cost_open_usd, realized_cost_usd, realized_proceeds_usd, entry_features, research)
       VALUES (?, 'solana', ?, 'T', ?, ?, 'closed', 0, 0, 10, ?, ?, '{}')`,
    )
    .run(mission.id, `stg${++n}`, now(), now(), 10 * (1 + pnl / 100), JSON.stringify({ venue: "solana", ...entry }));

test("el resumen reparte las creencias: tantas negativas como positivas", () => {
  for (let i = 0; i < 6; i++) {
    memory.writeBelief({ statement: ["alfa bravo","charlie delta","eco foxtrot","golf hotel","india juliet","kilo lima"][i]!, appliesTo: "t", expectation: "positive", condition: { all: [{ f: "ageMinutes", op: ">", v: 1000 + i }] }, missionId: null });
  }
  for (let i = 0; i < 2; i++) {
    memory.writeBelief({ statement: ["mike november","oscar papa"][i]!, appliesTo: "t", expectation: "negative", condition: { all: [{ f: "liquidityUsd", op: "<", v: 100 + i }] }, missionId: null });
  }
  const s = memory.recallSummary(mission.id);
  const neg = s.beliefs.filter((b) => b.expectation === "tiende a perder").length;
  assert.equal(neg, 2, "las dos negativas entran aunque haya seis positivas");
  assert.ok(s.beliefs.length <= 8);
});

test("para comprar hace falta risks_checked (qué se ha comprobado en contra)", async () => {
  closed({}, 0);
  const ctx = { sessionId: 1, missionId: mission.id };
  const base = { why: "x", evidence: "x", sources: ["x"], exit_plan: "x", beliefs_applied: [], memory_note: "x" };
  const r = await runTool("simulate_swap", { chain: "solana", input: "USDC", output: MEME, amount: 5, slippage_bps: 100, thesis: base }, ctx);
  assert.equal(r.isError, true);
  assert.match(String(r.content), /risks_checked/);
  // Vender no lo necesita.
  const sell = await runTool("simulate_swap", { chain: "solana", input: "SOL", output: "USDC", amount: 0.001, slippage_bps: 100, thesis: base }, ctx);
  assert.ok(!sell.isError, String(sell.content));
});
