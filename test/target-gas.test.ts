// Al tocar el objetivo en valoración se vende todo, pero el nativo (gas) solo si la misión se cierra de verdad:
// si lo realizado se queda corto y la misión sigue, tiene que quedar gas para volver a operar.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOL_MINT } from "../src/market/jupiter.js";
import { createMission, startMissionClock } from "../src/sim/mission.js";
import { balance, liquidateAll } from "../src/sim/portfolio.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, MEME, setPrice } from "./fake-market.js";

installFakeMarket();

test("el cierre por objetivo vende primero todo menos el gas, y el gas solo cuando la misión se cierra", async () => {
  setPrice(MEME, 1);
  const m = await createMission(100, 110, 60, undefined, { solana: 100 });
  startMissionClock(m.id);
  const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck" };
  const r = await runTool("simulate_swap", { chain: "solana", input: "USDC", output: MEME, amount: 90, slippage_bps: 300, thesis }, { sessionId: 1, missionId: m.id });
  assert.ok(!r.isError, String(r.content));
  const sol = balance(m.id, "solana", SOL_MINT);
  assert.ok(sol > 0.001);
  assert.deepEqual(await liquidateAll(m.id, null, "prueba", { keepNative: true }), []);
  assert.equal(balance(m.id, "solana", MEME), 0);
  assert.ok(balance(m.id, "solana", SOL_MINT) > sol * 0.5, "si la misión sigue, conserva el SOL del gas (menos la red de la venta)");
  await liquidateAll(m.id, null, "prueba", { nativeOnly: true });
  assert.ok(balance(m.id, "solana", SOL_MINT) < sol / 10, "al cerrarse, el SOL sí se vende");
});
