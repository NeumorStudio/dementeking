// enter_with_exits arranca el reloj de la misión SOLO cuando su compra se llena (ToolDef.entry): la compra es la única
// operación que se admite antes del reloj. En la M18 (costes reales) la compra del primer candidato revirtió con el reloj
// ya en marcha y el error no lo decía; el segundo revirtió dos veces y a la tercera se forzó subiendo el slippage al 25 %:
// el token cayó un 79 % y la misión perdió el 94 %. Ahora:
// - si la compra revierte, no queda nada (ni reloj, ni sesión, ni gemelo, ni plan asignado, ni plazo movido) y el error
//   dice «el reloj no ha arrancado» y por qué;
// - ese token queda descartado en la misión: wait_for_signal no lo vuelve a dar y enter_with_exits no lo reintenta;
// - el slippage no puede pasar del del plan (o del de por defecto): no se fuerza una entrada;
// - con la compra hecha, el reloj arranca a la hora de la compra, con el gemelo dimensionado con la cartera de antes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { SOL_MINT, USDC_MINT } from "../src/market/jupiter.js";
import { excludedTokens } from "../src/sim/entry.js";
import { createMission, getMission, startMissionClock } from "../src/sim/mission.js";
import { balance } from "../src/sim/portfolio.js";
import { startSession } from "../src/sim/session.js";
import { runTool } from "../src/tools/index.js";
import { POOL_FEE, setExtraRoutes, tokens } from "./fake-market.js";

const RV = "ReVert1111111111111111111111111111111111pump";
const OK = "0kFill1111111111111111111111111111111111pump";
const P5 = "PLan51111111111111111111111111111111111pump";
tokens[RV] = { symbol: "RV", decimals: 6, price: 0.001, launchpad: "pump.fun" };
tokens[OK] = { symbol: "OK", decimals: 6, price: 0.001, launchpad: "pump.fun" };
tokens[P5] = { symbol: "P5", decimals: 6, price: 0.001, launchpad: "pump.fun" };

config.latencyMs = 20;

// Cotizaciones de compra (USDC → token) de cada token con un multiplicador por petición (1 = el precio del mercado falso):
// así la cotización de después de la latencia sale peor que la de antes. buyQuotes cuenta las que llegan al mercado.
const buyFactors: Record<string, number[]> = {};
const buyQuotes: Record<string, number> = {};
let pools: unknown[] = [];
setExtraRoutes(route);
/** Las próximas cotizaciones de compra de un token. */
const nextBuys = (token: string, ...f: number[]) => {
  buyFactors[token] = f;
  buyQuotes[token] = 0;
};
nextBuys(RV);
nextBuys(OK);

function pool(token: string, ageSeconds: number) {
  return {
    id: `solana_pool_${token.slice(0, 6)}`,
    attributes: {
      address: `pool_${token.slice(0, 6)}`,
      name: `${token.slice(0, 6)} / SOL`,
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

const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y las creencias negativas" };
const text = (r: { content: unknown }) => String(r.content);
const planInput = (over: Record<string, unknown>) => ({
  event: "graduado",
  reentry: "no",
  reentry_allowed: false,
  risks_checked: "revisé las creencias negativas y riskCheck: nada lo descarta",
  why: "x",
  evidence: "x",
  sources: ["x"],
  predicted_p: 0.36,
  ...over,
});
const sessionsOf = (id: number) => (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE mission_id = ?").get(id) as { n: number }).n;

test("costes reales: la compra revierte y el reloj no arranca (sin sesión, gemelo, plan ni plazo); el token queda descartado y la siguiente entrada lo arranca con la compra", async () => {
  const plan = await runTool("write_plan", planInput({ duration_minutes: 10, target_pct: 25 }), { sessionId: 1, missionId: null });
  const planId = Number(text(plan).match(/Plan #(\d+)/)![1]);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 }, { costMode: "real" });
  let clockCalls = 0;
  const ctx = {
    sessionId: 1,
    missionId: m.id,
    startClock: async () => {
      clockCalls++;
      startMissionClock(m.id);
      return startSession(m.id);
    },
  };
  const before = getMission(m.id)!;
  const sessions0 = sessionsOf(m.id);
  const sol0 = balance(m.id, "solana", SOL_MINT);

  // Cada cotización de compra de RV sale un 15 % peor que la anterior: la de después de la latencia, un 15 % peor que la
  // que decidió la compra (la del preflight si sigue en caché, o una nueva), más que el 3 % de slippage: revierte como en
  // la cadena.
  nextBuys(RV, 1, 0.85, 0.85 ** 2);
  const r = await runTool("enter_with_exits", { token: RV, thesis: { plan_ref: planId } }, ctx);
  assert.equal(r.isError, true, text(r));
  assert.ok(buyQuotes[RV]! >= 2, "la del preflight y la de después de la latencia");
  assert.match(text(r), /La compra de RV ha revertido y el reloj no ha arrancado: el precio se ha movido en tu contra un 15\.0 % durante los 0\.02 s de latencia/);
  assert.match(text(r), /más que tu slippage del 3 %/);
  assert.match(text(r), /RV queda descartado en esta misión: wait_for_signal no te lo volverá a dar/);
  assert.match(text(r), /No lo reintentes ni subas el slippage/);
  assert.doesNotMatch(text(r), /\(el reloj no ha arrancado\)$/, "no lo repite");

  // Nada que deshacer: la misión, igual (reloj, plazo, clase, plan, P); ni sesión nueva, ni gemelo, ni posición.
  assert.deepEqual(getMission(m.id), before);
  assert.equal(clockCalls, 0, "no se abrió la sesión de trabajo");
  assert.equal(sessionsOf(m.id), sessions0);
  assert.equal(db.prepare("SELECT 1 FROM shadow_runs WHERE mission_id = ?").get(m.id), undefined, "sin gemelo");
  assert.equal(db.prepare("SELECT 1 FROM orders WHERE mission_id = ?").get(m.id), undefined, "sin toma de beneficio");
  assert.equal(db.prepare("SELECT 1 FROM agent_entries WHERE mission_id = ?").get(m.id), undefined);
  assert.equal(balance(m.id, "solana", RV), 0);
  assert.equal(balance(m.id, "solana", USDC_MINT), 48.5, "el efectivo, entero");
  assert.ok(Math.abs(sol0 - balance(m.id, "solana", SOL_MINT) - 0.00075) < 1e-12, "solo la red de la transacción que revierte");
  assert.ok(db.prepare("SELECT 1 FROM journal WHERE mission_id = ? AND kind = 'rejected' AND summary LIKE '%el reloj no ha arrancado%'").get(m.id));
  assert.deepEqual(excludedTokens(m.id), [RV]);

  // No se reintenta: ni con el mismo slippage ni subiéndolo (y el reloj sigue parado, sin gastar cotizaciones).
  nextBuys(RV);
  const again = await runTool("enter_with_exits", { token: RV, thesis: { plan_ref: planId } }, ctx);
  assert.equal(again.isError, true);
  assert.match(text(again), /Ese token ya está descartado en esta misión \(la compra revirtió: el precio se ha movido en tu contra un 15\.0 %/);
  assert.match(text(again), /\(el reloj no ha arrancado\)/);
  assert.equal(buyQuotes[RV], 0);
  const forced = await runTool("enter_with_exits", { token: RV, slippage_bps: 2500, thesis: { plan_ref: planId } }, ctx);
  assert.equal(forced.isError, true);
  assert.match(text(forced), /slippage_bps 2500 pasa del tope de 300 \(el de por defecto\): una entrada no se fuerza subiendo el slippage/);
  assert.equal(getMission(m.id)!.started_at, null);

  // wait_for_signal no lo vuelve a dar, aunque sea el pool más reciente: da el siguiente.
  pools = [pool(RV, 5), pool(OK, 30)];
  setExtraRoutes(route);
  const wait = text(await runTool("wait_for_signal", { max_minutes: 0.25 }, ctx));
  assert.match(wait, /signal: OK pasa los filtros/);
  assert.doesNotMatch(wait, new RegExp(RV));
  assert.equal(getMission(m.id)!.started_at, null, "esperar no arranca el reloj");

  // El siguiente candidato se llena: el reloj arranca a la hora de la compra (después de su latencia), no antes.
  nextBuys(OK);
  const t0 = Date.now();
  const ok = await runTool("enter_with_exits", { token: OK, thesis: { plan_ref: planId } }, ctx);
  assert.ok(!ok.isError, text(ok));
  const out = JSON.parse(text(ok));
  const after = getMission(m.id)!;
  assert.ok(after.started_at);
  const started = Date.parse(after.started_at);
  assert.ok(started - t0 >= config.latencyMs, "arranca tras la latencia de la compra");
  assert.equal(Date.parse(after.deadline) - started, 10 * 60_000, "plazo entero desde la compra");
  assert.equal(out.clock.startedAt, after.started_at);
  const swapRow = db.prepare("SELECT id, ts, session_id FROM journal WHERE mission_id = ? AND kind = 'swap'").get(m.id) as { id: number; ts: string; session_id: number };
  assert.ok(Date.parse(swapRow.ts) <= started, "la compra es anterior al reloj");
  assert.ok(Date.parse(after.entry_at!) >= started);
  const clockRow = db.prepare("SELECT id, summary FROM journal WHERE mission_id = ? AND kind = 'mission' AND summary LIKE 'El agente empieza a trabajar%'").get(m.id) as { id: number; summary: string };
  assert.ok(clockRow.id > swapRow.id);
  assert.match(clockRow.summary, /arranca con la compra de OK \(enter_with_exits\) \(plan #\d+\)/);
  // La sesión de trabajo se abre con la compra hecha, y la compra queda en ella.
  assert.equal(clockCalls, 1);
  assert.equal(sessionsOf(m.id), sessions0 + 1);
  const session = (db.prepare("SELECT MAX(id) AS id FROM sessions WHERE mission_id = ?").get(m.id) as { id: number }).id;
  assert.equal(swapRow.session_id, session);
  // La toma de beneficio, puesta con el reloj en marcha.
  const order = db.prepare("SELECT id, created_at FROM orders WHERE mission_id = ? AND status = 'open'").get(m.id) as { id: number; created_at: string };
  assert.equal(order.id, out.takeProfit.orderId);
  assert.ok(Date.parse(order.created_at) >= started);
  // El gemelo arranca con el reloj y con el efectivo de antes de la compra (después ya no queda).
  const run = db.prepare("SELECT started_at, size_usd, tp_usd FROM shadow_runs WHERE mission_id = ?").get(m.id) as { started_at: string; size_usd: number; tp_usd: number };
  assert.equal(run.started_at, after.started_at);
  assert.equal(run.size_usd, 48.5);
  assert.ok(balance(m.id, "solana", USDC_MINT) < 1e-9, "el agente, con todo el efectivo");
  // El plan, asignado solo ahora.
  assert.equal(after.plan_id, planId);
  assert.equal(after.predicted_p, 0.36);
});

/** La ruta del mercado de este archivo: GeckoTerminal (pools) y las compras de los tokens con multiplicador (buyFactors). */
function route(url: URL): Response | undefined {
  if (url.host === "api.geckoterminal.com") return new Response(JSON.stringify({ data: Number(url.searchParams.get("page")) === 1 ? pools : [] }));
  if (url.host !== "lite-api.jup.ag" || url.pathname !== "/swap/v1/quote") return undefined;
  const inMint = url.searchParams.get("inputMint")!;
  const outMint = url.searchParams.get("outputMint")!;
  if (inMint !== USDC_MINT || !(outMint in buyFactors)) return undefined;
  buyQuotes[outMint] = (buyQuotes[outMint] ?? 0) + 1;
  const f = buyFactors[outMint]!.length ? buyFactors[outMint]!.shift()! : 1;
  const out = (Number(url.searchParams.get("amount")) / 1e6 / tokens[outMint]!.price) * (1 - POOL_FEE) * f;
  const plan = [{ percent: 100, swapInfo: { label: "Fake AMM", ammKey: "fake" } }];
  return new Response(JSON.stringify({ inAmount: url.searchParams.get("amount"), outAmount: String(Math.floor(out * 1e6)), priceImpactPct: "0", slippageBps: 300, routePlan: plan, contextSlot: 1 }));
}

test("slippage: el del plan es el de por defecto y el tope; sin plan, 300", async () => {
  const w = await runTool("write_plan", planInput({ duration_minutes: 5, target_pct: 50, slippage_bps: 500 }), { sessionId: 1, missionId: null });
  assert.ok(!w.isError, text(w));
  const planId = Number(text(w).match(/Plan #(\d+)/)![1]);
  const m = await createMission(50, 75, 5, undefined, { solana: 100 });
  const ctx = { sessionId: 1, missionId: m.id };

  const high = await runTool("enter_with_exits", { token: P5, slippage_bps: 800, thesis: { plan_ref: planId } }, ctx);
  assert.equal(high.isError, true);
  assert.match(text(high), new RegExp(`slippage_bps 800 pasa del tope de 500 \\(el del plan #${planId}\\)`));
  assert.match(text(high), /\(el reloj no ha arrancado\)/);
  assert.equal(getMission(m.id)!.started_at, null);

  // Sin slippage_bps, el del plan (también en la toma de beneficio); con uno por debajo, se respeta.
  const ok = await runTool("enter_with_exits", { token: P5, thesis: { plan_ref: planId } }, ctx);
  assert.ok(!ok.isError, text(ok));
  const order = db.prepare("SELECT action FROM orders WHERE mission_id = ?").get(m.id) as { action: string };
  assert.equal(JSON.parse(order.action).slippageBps, 500);
  assert.ok(getMission(m.id)!.started_at);

  // Una clase sin plan: el tope es el de por defecto (300), también con una tesis completa.
  const free = await createMission(50, 100, 15, undefined, { solana: 100 });
  const r = await runTool("enter_with_exits", { token: P5, slippage_bps: 400, thesis }, { sessionId: 1, missionId: free.id });
  assert.equal(r.isError, true);
  assert.match(text(r), /slippage_bps 400 pasa del tope de 300 \(el de por defecto\)/);
  const low = await runTool("enter_with_exits", { token: P5, slippage_bps: 200, thesis }, { sessionId: 1, missionId: free.id });
  assert.ok(!low.isError, text(low));
});

test("runTool: una herramienta con entry arranca el reloj solo si la entrada sale bien, a la hora que devuelve", async () => {
  let fail = true;
  const atMs = Date.now() - 1234;
  const tools = [
    {
      name: "entrar",
      kind: "trade",
      startsClock: true,
      description: "",
      schema: z.object({}),
      entry: async () => {
        if (fail) throw new Error("la compra no se llena");
        return { clock: { atMs }, filled: 7 };
      },
      run: async (_i: unknown, c: { sessionId: number }, _p: unknown, e: { filled: number }) => `sesión ${c.sessionId}, entrada ${e.filled}`,
    },
  ];
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  let calls = 0;
  const ctx = { sessionId: 1, missionId: m.id, startClock: async () => (calls++, startMissionClock(m.id), 99) };

  const bad = await runTool("entrar", {}, ctx, tools);
  assert.equal(bad.isError, true);
  assert.match(text(bad), /la compra no se llena \(el reloj no ha arrancado\)/);
  assert.equal(getMission(m.id)!.started_at, null);
  assert.equal(calls, 0);

  fail = false;
  assert.deepEqual(await runTool("entrar", {}, ctx, tools), { content: "sesión 99, entrada 7", isError: false });
  const started = getMission(m.id)!;
  assert.equal(started.started_at, new Date(atMs).toISOString(), "a la hora de la entrada");
  assert.equal(Date.parse(started.deadline) - atMs, 10 * 60_000);
  assert.equal(calls, 1);

  // Con el reloj en marcha, un fallo de la entrada no habla del reloj.
  fail = true;
  const later = await runTool("entrar", {}, ctx, tools);
  assert.equal(text(later), "Error: la compra no se llena");
});
