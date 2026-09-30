// Datos de riesgo del creador y del token (sin veredictos ni frenos fijos), historial con el creador,
// segunda lectura en token_report y launchpad de BNB Chain deducido de la dirección.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now } from "../src/db.js";
import { bscLaunchpad } from "../src/sim/launchpads.js";
import * as memory from "../src/sim/memory.js";
import { createMission, startMissionClock } from "../src/sim/mission.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, MEME, MEME_DEV } from "./fake-market.js";

installFakeMarket();

const mission = await createMission(1000, 1200, 60, undefined, { solana: 100 });
startMissionClock(mission.id);
const ctx = { sessionId: 1, missionId: mission.id };
const thesis = { why: "prueba", evidence: "prueba", sources: ["test"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y creencias negativas" };

test("launchpad de BNB Chain por la dirección", () => {
  assert.equal(bscLaunchpad("0xb1cee4255275ea7954647f8acda8a399da377777"), "flap.sh");
  assert.equal(bscLaunchpad("0x1234567890123456789012345678901234564444"), "four.meme");
  assert.equal(bscLaunchpad("0x55d398326f99059ff775485246999027b3197955"), undefined);
});

test("una creencia sobre flap.sh tiene evidencia con las operaciones antiguas (que guardaban el DEX)", () => {
  for (const [addr, pnl] of [["0xaaaa000000000000000000000000000000007777", -100], ["0xbbbb000000000000000000000000000000007777", -95]] as const) {
    db.prepare(
      `INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, closed_at, status, qty_open, cost_open_usd, realized_cost_usd, realized_proceeds_usd, entry_features, research)
       VALUES (?, 'bsc', ?, 'FLAP', ?, ?, 'closed', 0, 0, 10, ?, ?, '{}')`,
    ).run(mission.id, addr, now(), now(), 10 * (1 + pnl / 100), JSON.stringify({ venue: "bsc", launchpad: "pancakeswap" }));
  }
  const b = memory.writeBelief({
    statement: "Los tokens de Flap.sh acaban en -100 %",
    appliesTo: "BNB Chain",
    expectation: "negative",
    condition: { all: [{ f: "launchpad", op: "=", v: "flap.sh" }] },
    missionId: null,
  });
  assert.equal(b.evidence.matchingTrades?.trades, 2);
});

test("token_report da los datos del creador sin veredicto y, en la segunda lectura, dice qué ha cambiado", async () => {
  const first = String((await runTool("token_report", { chain: "solana", token: MEME }, ctx)).content);
  const rc = JSON.parse(first).riskCheck;
  assert.equal(rc.creatorTokens, 40);
  assert.equal(rc.creatorGraduated, 0);
  assert.equal(rc.flags, undefined);
  assert.doesNotMatch(first, /creador en serie|warning/);
  assert.match(first, /primera lectura/);
  const second = String((await runTool("token_report", { chain: "solana", token: MEME }, ctx)).content);
  assert.match(second, /minutesAgo/);
});

test("un creador que ya costó mucho no frena la compra: queda como dato, y una creencia aprendida sobre él sí frena", async () => {
  db.prepare(
    `INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, closed_at, status, qty_open, cost_open_usd, realized_cost_usd, realized_proceeds_usd, entry_features, research)
     VALUES (?, 'solana', 'OldRug', 'OLDRUG', ?, ?, 'closed', 0, 0, 20, 0.5, ?, '{}')`,
  ).run(mission.id, now(), now(), JSON.stringify({ venue: "solana", creator: MEME_DEV }));
  const buy = { chain: "solana", input: "USDC", output: MEME, amount: 10, slippage_bps: 100 };
  const report = JSON.parse(String((await runTool("token_report", { chain: "solana", token: MEME }, ctx)).content));
  assert.equal(report.riskCheck.creatorTradesWithYou, 1);
  assert.ok(report.riskCheck.creatorWorstPnlWithYouPct <= -90);
  const ok = await runTool("simulate_swap", { ...buy, thesis }, ctx);
  assert.ok(!ok.isError, String(ok.content));
  // La posición guarda el creador y su historial, para que una creencia pueda aprenderlo.
  const p = db.prepare("SELECT entry_features FROM positions WHERE mission_id = ? AND asset = ? ORDER BY id DESC LIMIT 1").get(mission.id, MEME) as { entry_features: string };
  const f = JSON.parse(p.entry_features);
  assert.deepEqual([f.creator, f.creatorTokens, f.creatorGraduated, f.creatorGraduationPct, f.creatorTradesWithYou], [MEME_DEV, 40, 0, 0, 1]);
  assert.ok(f.creatorWorstPnlWithYouPct <= -90);
});

test("token_report compara el volumen de 1 h de Jupiter con el de todos los pares de DexScreener, sin veredicto", async () => {
  const { volumeJupiterVsDex } = await import("../src/market/research.js");
  assert.deepEqual(volumeJupiterVsDex({ stats1h: { buyVolumeUsd: 100_000, sellVolumeUsd: 62_000 } }, { volume1hAllPairsUsd: 10_000 }), {
    jupiter1hUsd: 162_000,
    dexscreener1hUsd: 10_000,
    volume1hJupiterVsDexRatio: 16.2,
  });
  assert.equal(volumeJupiterVsDex({ stats1h: { buyVolumeUsd: 5 } }, { volume1hAllPairsUsd: 0 }), undefined, "sin volumen en una fuente no hay cociente");
});
