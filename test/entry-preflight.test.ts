// enter_with_exits comprueba todo lo que puede fallar sin operar ANTES de arrancar el reloj (ToolDef.preflight): la
// misión, la tesis o el plan citado, el efectivo, el token, una cotización de ida y vuelta y el freno de la memoria. Si
// algo falla, el reloj sigue parado, no hay gemelo ni plan asignado, y el executor espera al siguiente candidato gratis.
// Y wait_for_signal no ofrece un candidato que la memoria va a rechazar al entrar.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now } from "../src/db.js";
import { SOL_MINT, USDC_MINT } from "../src/market/jupiter.js";
import * as memory from "../src/sim/memory.js";
import { createMission, getMission, startMissionClock } from "../src/sim/mission.js";
import { balance } from "../src/sim/portfolio.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, MEME, setExtraRoutes, setPrice, tokens } from "./fake-market.js";

installFakeMarket();

const DRAIN = "DRaiN1111111111111111111111111111111pump";
const FRESH = "FResh11111111111111111111111111111111pump";
tokens[DRAIN] = { symbol: "DRAIN", decimals: 6, price: 0.01, launchpad: "pump.fun" };
tokens[FRESH] = { symbol: "FRESH", decimals: 6, price: 0.001, launchpad: "pump.fun" };

function pool(token: string, ageSeconds: number) {
  return {
    id: `solana_pool_${token.slice(0, 5)}`,
    attributes: {
      address: `pool_${token.slice(0, 5)}`,
      name: `${token.slice(0, 5)} / SOL`,
      pool_created_at: new Date(Date.now() - ageSeconds * 1000).toISOString(),
      reserve_in_usd: "20000",
      transactions: { m5: { buys: 80, sells: 20, buyers: 60 } },
    },
    relationships: {
      base_token: { data: { id: `solana_${token}` } },
      quote_token: { data: { id: `solana_${SOL_MINT}` } },
      dex: { data: { id: "pumpswap" } },
    },
  };
}

setExtraRoutes((url) => {
  // Pool vaciado: comprar DRAIN da sus tokens, pero venderlos al momento devuelve el 3 % (como el TOAD de la prueba en vivo).
  if (url.host === "lite-api.jup.ag" && url.pathname === "/swap/v1/quote" && url.searchParams.get("inputMint") === DRAIN) {
    const usd = (Number(url.searchParams.get("amount")) / 1e6) * tokens[DRAIN]!.price * 0.03;
    const route = [{ percent: 100, swapInfo: { label: "Fake AMM", ammKey: "fake" } }];
    return new Response(JSON.stringify({ inAmount: url.searchParams.get("amount"), outAmount: String(Math.floor(usd * 1e6)), priceImpactPct: "0.97", slippageBps: 300, routePlan: route, contextSlot: 1 }));
  }
  if (url.host === "api.geckoterminal.com") return new Response(JSON.stringify({ data: Number(url.searchParams.get("page")) === 1 ? [pool(FRESH, 20)] : [] }));
  return undefined;
});

const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y las creencias negativas" };
const text = (r: { content: unknown }) => String(r.content);

/** Lo que tiene que seguir igual tras una entrada rechazada: sin reloj, sin gemelo, sin plan, sin posiciones, sin sesión nueva. */
function untouched(id: number, startClockCalls: number) {
  const m = getMission(id)!;
  assert.equal(m.status, "active");
  assert.equal(m.started_at, null, "el reloj sigue parado");
  assert.equal(m.plan_id, null, "sin plan asignado");
  assert.equal(db.prepare("SELECT 1 FROM shadow_runs WHERE mission_id = ?").get(id), undefined, "sin gemelo");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM positions WHERE mission_id = ?").get(id) as { n: number }).n, 0);
  assert.equal(startClockCalls, 0, "no se abrió sesión de trabajo");
}

test("enter_with_exits: si una comprobación falla, el reloj no arranca (ni el gemelo, ni el plan); con todo en orden, sí", async () => {
  setPrice(MEME, 0.01);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  let calls = 0;
  const ctx = { sessionId: 1, missionId: m.id, startClock: async () => (calls++, startMissionClock(m.id), 42) };

  // Un plan de la clase con usd_amount = el capital (50 $): la clase no dice el capital, y aquí solo hay 48,5 $ de efectivo.
  const plan = await runTool(
    "write_plan",
    {
      duration_minutes: 10,
      target_pct: 25,
      event: "graduado",
      usd_amount: 50,
      reentry: "no",
      reentry_allowed: false,
      risks_checked: "revisé las creencias negativas y riskCheck: nada lo descarta",
      why: "x",
      evidence: "x",
      sources: ["x"],
      predicted_p: 0.36,
    },
    { sessionId: 1, missionId: null },
  );
  const planId = Number(text(plan).match(/Plan #(\d+)/)![1]);

  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["más de lo que hay", { token: MEME, usd_amount: 500, thesis }, /Solo tienes 48\.5 USDC/],
    ["un token que Jupiter no conoce", { token: "NoRoute11111111111111111111111111111pump", thesis }, /./],
    ["un plan que no existe", { token: MEME, thesis: { plan_ref: 999 } }, /No existe el plan #999/],
    ["una tesis sin risks_checked", { token: MEME, thesis: { ...thesis, risks_checked: undefined } }, /rellena thesis\.risks_checked/],
    ["un pool vaciado", { token: DRAIN, thesis: { plan_ref: planId } }, /ida y vuelta del 97\.\d %, por encima del 10 % \(pool vaciado/],
  ];
  for (const [what, input, error] of cases) {
    const r = await runTool("enter_with_exits", input, ctx);
    assert.equal(r.isError, true, `${what}: ${text(r)}`);
    assert.match(text(r), error, what);
    assert.match(text(r), /\(el reloj no ha arrancado\)/, what);
    untouched(m.id, calls);
  }
  assert.ok(
    (db.prepare("SELECT COUNT(*) AS n FROM journal WHERE mission_id = ? AND kind = 'rejected'").get(m.id) as { n: number }).n >= cases.length,
    "cada rechazo queda en el diario",
  );

  // Todo en orden: el importe del plan se recorta al efectivo (como el gemelo), arranca el reloj y queda el plan asignado.
  const ok = await runTool("enter_with_exits", { token: MEME, thesis: { plan_ref: planId } }, ctx);
  assert.ok(!ok.isError, text(ok));
  assert.equal(calls, 1);
  const after = getMission(m.id)!;
  assert.ok(after.started_at);
  assert.equal(after.plan_id, planId);
  assert.ok(balance(m.id, "solana", MEME) > 0, "compró");
  assert.ok(balance(m.id, "solana", USDC_MINT) < 1e-9, "con todo el efectivo: 48,5 $, no los 50 del plan");
  const out = JSON.parse(text(ok));
  assert.ok(out.roundTripAtEntry.costPct < 1, "la ida y vuelta cotizada antes de entrar va en la respuesta");
  const run = db.prepare("SELECT size_usd FROM shadow_runs WHERE mission_id = ?").get(m.id) as { size_usd: number };
  assert.equal(run.size_usd, 48.5, "el gemelo, con el mismo importe recortado");
});

test("freno de la memoria: wait_for_signal no ofrece el candidato y enter_with_exits lo rechaza sin arrancar el reloj", async () => {
  // Una creencia negativa fuerte que cumple cualquier token de Solana del mercado falso (como en memory-hygiene.test.ts).
  const setup = await createMission(1000, 1200, 60, undefined, { solana: 100 });
  let n = 0;
  for (const pnl of [-60, -80, -100, -40]) {
    db.prepare(
      `INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, closed_at, status, qty_open, cost_open_usd,
         realized_cost_usd, realized_proceeds_usd, entry_features, research)
       VALUES (?, 'solana', ?, 'T', ?, ?, 'closed', 0, 0, 10, ?, ?, '{}')`,
    ).run(setup.id, `mem${++n}`, now(), now(), 10 * (1 + pnl / 100), JSON.stringify({ venue: "solana" }));
  }
  const b = memory.writeBelief({
    statement: "Todo lo de Solana en esta prueba acaba mal",
    appliesTo: "test",
    expectation: "negative",
    condition: { all: [{ f: "venue", op: "=", v: "solana" }] },
    missionId: setup.id,
  });
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const ctx = { sessionId: 1, missionId: m.id };

  const wait = text(await runTool("wait_for_signal", { max_minutes: 0.25 }, ctx));
  assert.match(wait, new RegExp(`descartes: tu memoria lo desaconseja \\(creencia #${b.id}\\) ×1`));
  assert.doesNotMatch(wait, /signal:/);

  const r = await runTool("enter_with_exits", { token: MEME, thesis }, ctx);
  assert.equal(r.isError, true);
  assert.match(text(r), new RegExp(`Tu memoria desaconseja esta compra de MEME:\\n- #${b.id}`));
  assert.match(text(r), /\(el reloj no ha arrancado\)/);
  assert.equal(getMission(m.id)!.started_at, null);
});
