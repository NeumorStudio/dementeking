// Contrafactuales proporcionales: en una misión rápida, qué habría dado mantener la posición 1, 3 y 5 minutos más (en
// una misión de 10 min, "30 minutos más" no dice nada de la decisión); en una larga, 15 y 30 como siempre.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.js";
import { HOLD_HORIZONS, missionCounterfactuals } from "../src/sim/counterfactuals.js";
import { createMission, startMissionClock } from "../src/sim/mission.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, MEME, setExtraRoutes, setPrice } from "./fake-market.js";

installFakeMarket();

const minute = 60;
/** Minuto (en segundos Unix) en que se cerró la posición: las velas suben a partir de ahí. */
let closeSec = 0;
setExtraRoutes((url) => {
  if (url.host !== "api.geckoterminal.com") return undefined;
  if (url.pathname.endsWith(`/tokens/${MEME}/pools`)) return new Response(JSON.stringify({ data: [{ attributes: { address: "poolmeme", reserve_in_usd: "50000" } }] }));
  if (url.pathname.includes("/pools/poolmeme/ohlcv/minute")) {
    // 0,01 hasta el cierre; después, +20 % al minuto 1, +50 % al 3 y ×2 al 5 (y así se queda).
    const price = (t: number) => (t < closeSec + minute ? 0.01 : t < closeSec + 3 * minute ? 0.012 : t < closeSec + 5 * minute ? 0.015 : 0.02);
    const end = Number(url.searchParams.get("before_timestamp"));
    const list = [];
    for (let t = closeSec - 20 * minute; t <= end; t += minute) list.push([t, price(t), price(t), price(t), price(t)]);
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } } }));
  }
  return undefined;
});

const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y las creencias" };

/** Compra y vende MEME en la misión y deja la posición abierta hace 12 min y cerrada hace `closedAgoMin`. */
async function roundTrip(missionId: number, closedAgoMin: number) {
  setPrice(MEME, 0.01);
  const ctx = { sessionId: 1, missionId };
  assert.ok(!(await runTool("simulate_swap", { chain: "solana", input: "USDC", output: MEME, amount: 10, thesis }, ctx)).isError);
  assert.ok(!(await runTool("simulate_swap", { chain: "solana", input: MEME, output: "USDC", sell_all: true, thesis }, ctx)).isError);
  const nowSec = Math.floor(Date.now() / 1000);
  closeSec = Math.floor((nowSec - closedAgoMin * minute) / minute) * minute;
  db.prepare("UPDATE positions SET opened_at = ?, closed_at = ? WHERE mission_id = ?").run(
    new Date((closeSec - 2 * minute) * 1000).toISOString(),
    new Date(closeSec * 1000 + 500).toISOString(),
    missionId,
  );
}

test("misión rápida: contrafactuales a +1, +3 y +5 min", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(m.id);
  await roundTrip(m.id, 8);
  const [cf] = await missionCounterfactuals(m.id);
  assert.ok(cf && !cf.unavailable, JSON.stringify(cf));
  assert.deepEqual(HOLD_HORIZONS.fast, [1, 3, 5]);
  assert.equal(cf.ifHeld1Pct, 20);
  assert.equal(cf.ifHeld3Pct, 50);
  assert.equal(cf.ifHeld5Pct, 100);
  assert.equal(cf.ifHeld15Pct, undefined);
  assert.equal(cf.ifHeld30Pct, undefined);
  assert.match(cf.reading!, /mantenerla 5 min más habría dado 100 %: salió demasiado pronto/);
});

test("misión larga: siguen siendo +15 y +30 min", async () => {
  const m = await createMission(50, 55, 120, undefined, { solana: 100 });
  startMissionClock(m.id);
  await roundTrip(m.id, 40);
  const [cf] = await missionCounterfactuals(m.id);
  assert.ok(cf && !cf.unavailable, JSON.stringify(cf));
  assert.equal(cf.ifHeld15Pct, 100);
  assert.equal(cf.ifHeld30Pct, 100);
  assert.equal(cf.ifHeld1Pct, undefined);
  assert.match(cf.reading!, /mantenerla 30 min más habría dado 100 %/);
});
