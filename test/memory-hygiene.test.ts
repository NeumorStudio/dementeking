// Freno de memoria en las compras, higiene de la memoria (duplicados por evidencia, contradichas, límites)
// y el resumen ligero que ve el agente.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now } from "../src/db.js";
import * as memory from "../src/sim/memory.js";
import { createMission, startMissionClock } from "../src/sim/mission.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, MEME } from "./fake-market.js";

installFakeMarket();

const mission = await createMission(1000, 1200, 60, undefined, { solana: 100 });
startMissionClock(mission.id);
const ctx = { sessionId: 1, missionId: mission.id };
let n = 0;
function closed(entry: Record<string, unknown>, pnlPct: number) {
  db.prepare(
    `INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, closed_at, status, qty_open, cost_open_usd,
       realized_cost_usd, realized_proceeds_usd, entry_features, research)
     VALUES (?, 'solana', ?, 'T', ?, ?, 'closed', 0, 0, 10, ?, ?, '{}')`,
  ).run(mission.id, `hyg${++n}`, now(), now(), 10 * (1 + pnlPct / 100), JSON.stringify({ venue: "solana", ...entry }));
}
const thesis = { why: "prueba", evidence: "prueba", sources: ["test"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y creencias negativas" };

test("una creencia negativa fuerte frena la compra, salvo que se ignore a sabiendas con un motivo", async () => {
  for (const pnl of [-60, -80, -100, -40]) closed({ launchpad: "fábrica-de-rugs" }, pnl);
  // Condición que cumple cualquier token de Solana del mercado falso (no tiene launchpad: "desconocido" no cumple "!=").
  const b = memory.writeBelief({
    statement: "Todo lo de Solana en esta prueba acaba mal",
    appliesTo: "test",
    expectation: "negative",
    condition: { all: [{ f: "venue", op: "=", v: "solana" }] },
    missionId: mission.id,
  });
  assert.match(b.evidence.verdict, /se sostiene/);
  const buy = { chain: "solana", input: "USDC", output: MEME, amount: 10, slippage_bps: 100 };
  const blocked = await runTool("simulate_swap", { ...buy, thesis }, ctx);
  assert.equal(blocked.isError, true);
  assert.match(String(blocked.content), new RegExp(`#${b.id}.*overrides`, "s"));
  // Vender a estables no se frena.
  const ok = await runTool("simulate_swap", { ...buy, thesis: { ...thesis, overrides: [{ id: b.id, reason: "quiero comprobar si la creencia sigue siendo cierta" }] } }, ctx);
  assert.ok(!ok.isError, String(ok.content));
  const sell = await runTool("simulate_swap", { chain: "solana", input: MEME, output: "USDC", sell_all: true, slippage_bps: 100, thesis }, ctx);
  assert.ok(!sell.isError, String(sell.content));
  memory.reviseBelief({ id: b.id, retire: true, reason: "solo para la prueba" });
});

test("dos creencias que cubren las mismas operaciones son la misma: no se guarda la segunda y la higiene lo detecta", () => {
  for (const pnl of [-30, -20, 15]) closed({ ageMinutes: 5, liquidityUsd: 10_000 }, pnl);
  memory.writeBelief({ statement: "Pools de 5 min pierden", appliesTo: "t", expectation: "negative", condition: { all: [{ f: "ageMinutes", op: "<", v: 10 }] }, missionId: null });
  assert.throws(
    () => memory.writeBelief({ statement: "Liquidez pequeña pierde", appliesTo: "t", expectation: "negative", condition: { all: [{ f: "liquidityUsd", op: "<", v: 20_000 }] }, missionId: null }),
    /cubre casi las mismas operaciones/,
  );
  // Si ya existían las dos (de antes de esta regla), la higiene las señala para fusionarlas.
  db.prepare(
    "INSERT INTO beliefs (created_at, updated_at, statement, applies_to, expectation, condition, fingerprint) VALUES (?, ?, 'Liquidez pequeña pierde', 't', 'negative', ?, 'x')",
  ).run(now(), now(), JSON.stringify({ all: [{ f: "liquidityUsd", op: "<", v: 20_000 }] }));
  const h = memory.memoryHygiene();
  assert.equal(h.duplicateBeliefs.length, 1);
});

test("creencias contradichas por los datos y límite de howtos", () => {
  for (const pnl of [30, 25, 40, 22, 35]) closed({ holders: 5000 }, pnl);
  const c = memory.writeBelief({ statement: "Muchos holders pierde", appliesTo: "t", expectation: "negative", condition: { all: [{ f: "holders", op: ">", v: 1000 }] }, missionId: null });
  assert.ok(memory.memoryHygiene().contradictedBeliefs.some((x) => x.id === c.id));

  const topics = ["órdenes", "puentes", "gas", "slippage", "liquidez", "holders", "rug", "tiempo", "reparto", "binance", "base", "bsc", "solana", "pump", "quote", "venta", "compra", "salida", "entrada", "riesgo"];
  let written = db.prepare("SELECT COUNT(*) AS n FROM howtos WHERE status = 'active'").get() as { n: number };
  for (const [i, t] of topics.entries()) {
    if (written.n >= memory.HOWTO_LIMIT) break;
    memory.writeHowto({ scope: "any", topic: t, title: `${t} x${i}q`, steps: `alfa${i} beta${i} gamma${i} delta${i} ${t}`, missionId: null });
    written = db.prepare("SELECT COUNT(*) AS n FROM howtos WHERE status = 'active'").get() as { n: number };
  }
  assert.throws(() => memory.writeHowto({ scope: "any", topic: "extra", title: "Uno más", steps: "No cabe", missionId: null }), /18 howtos/);
});

test("parado en efectivo, lejos del objetivo y con tiempo por delante: mission_status avisa", async () => {
  const m = await createMission(100, 150, 60, undefined, { solana: 100 });
  startMissionClock(m.id);
  const status = () => runTool("mission_status", {}, { sessionId: 1, missionId: m.id }).then((r) => String(r.content));
  assert.doesNotMatch(await status(), /sin operar/);
  // Lleva 15 min sin hacer nada (más del 15 % de 60 min).
  const past = new Date(Date.now() - 15 * 60_000).toISOString();
  db.prepare("UPDATE missions SET started_at = ?, created_at = ? WHERE id = ?").run(past, past, m.id);
  assert.match(await status(), /Llevas 15 min sin operar.*efectivo/);
});

test("sin fondos: por debajo del 5 % del capital (o de 2 $) la misión termina sola como bancarrota", async () => {
  const { checkMission, getMission, missionHistory } = await import("../src/sim/mission.js");
  const m = await createMission(50, 100, 60, undefined, { solana: 100 });
  startMissionClock(m.id);
  // Se queda con 1,6 $ (menos del 5 % de 50 = 2,5 $): no es cero, pero ya no da para operar.
  db.prepare("UPDATE holdings SET amount = CASE WHEN symbol = 'USDC' THEN 1.6 ELSE 0 END WHERE mission_id = ?").run(m.id);
  const log = await checkMission(m.id);
  assert.match(log.join("\n"), /SIN FONDOS/);
  assert.equal(getMission(m.id)!.status, "bust");
  assert.equal(missionHistory().find((h) => h.missionId === m.id)!.outcome, "sin fondos (bancarrota)");
});

test("el resumen de memoria es ligero: howtos por título y su texto bajo demanda", async () => {
  const summary = memory.recallSummary(mission.id);
  assert.ok(summary.howtos.every((h) => typeof h === "string"));
  assert.ok(summary.beliefs.length <= 8);
  const r = await runTool("recall_memory", { howto_ids: [1] }, ctx);
  assert.match(String(r.content), /steps/);
  const cat = await runTool("memory_catalog", {}, { sessionId: 1, missionId: mission.id });
  assert.match(String(cat.content), /Catálogo compacto/);
});
