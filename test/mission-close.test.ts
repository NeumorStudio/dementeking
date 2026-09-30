import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.js";
import { USDC_MINT } from "../src/market/jupiter.js";
import { checkMission, createMission, startMissionClock, getMission } from "../src/sim/mission.js";
import { valuation } from "../src/sim/portfolio.js";
import { installFakeMarket } from "./fake-market.js";

installFakeMarket();

test("un token sin ruta de venta vale 0 y no impide cerrar una misión que ya tiene el objetivo en efectivo", async () => {
  const m = await createMission(100, 105, 60, undefined, { solana: 100 });
  startMissionClock(m.id);
  const RUG = "RuG1111111111111111111111111111111111111pump";
  db.prepare("UPDATE holdings SET amount = 110 WHERE mission_id = ? AND venue = 'solana' AND asset = ?").run(m.id, USDC_MINT);
  db.prepare("INSERT INTO holdings (mission_id, venue, asset, symbol, decimals, amount) VALUES (?, 'solana', ?, 'RUG', 6, 1000000)").run(m.id, RUG);

  const v = await valuation(m.id);
  const rug = v.holdings.find((h) => h.asset === RUG)!;
  assert.equal(rug.usd, 0);
  assert.match(rug.valuedBy, /sin ruta de venta/);
  assert.equal(v.reliable, true);

  const log = await checkMission(m.id);
  assert.match(log.join("\n"), /CONSEGUIDA/);
  assert.equal(getMission(m.id)!.status, "succeeded");
});
