// La compra de enter_with_exits va antes del reloj (ToolDef.entry), y con costes reales duerme 2 s de latencia entre
// cotizar y ejecutar. En ese rato la misión puede dejar de estar activa: la sustituye create_mission, la para el usuario o
// la cancela la vuelta de fondo por prep_timeout (sin reloj, a los 60 min). Nada de eso puede acabar en una compra
// aplicada a una misión cancelada, ni en el reloj, el gemelo o la sesión de OTRA misión (la nueva). Y lo que protege la
// entrada (no reintentar un token descartado ni subir el slippage) vale también para simulate_swap y las órdenes
// condicionales que compran en una misión rápida. Las misiones canceladas con candidatos cuya compra revirtió no cuentan
// como «sin candidato»: el planner no debe aflojar filtros por ellas.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { config } from "../src/config.js";
import { aggregateBatches, loadFastMissions } from "../src/dashboard/batches.js";
import { db, logJournal } from "../src/db.js";
import { SOL_MINT, USDC_MINT } from "../src/market/jupiter.js";
import { excludedTokens } from "../src/sim/entry.js";
import { checkMission, createMission, getActiveMission, getLastMission, getMission, recordSignal, startMissionClock } from "../src/sim/mission.js";
import { checkOrders } from "../src/sim/orders.js";
import { markPlanForMission, planBlock } from "../src/sim/plans.js";
import { balance } from "../src/sim/portfolio.js";
import { startSession } from "../src/sim/session.js";
import { statusReport } from "../src/sim/status.js";
import { runTool } from "../src/tools/index.js";
import { POOL_FEE, setExtraRoutes, tokens } from "./fake-market.js";

const T = (tag: string) => `${tag}${"1".repeat(40 - tag.length)}pump`;
const SWAPPED = T("Swap");
const TIMEOUT = T("Tmout");
const CC = T("CeCe");
const DD = T("DeDe");
const EE = T("EeEe");
const RR = T("ReRv");
for (const [t, s] of [[SWAPPED, "SW"], [TIMEOUT, "TM"], [CC, "CC"], [DD, "DD"], [EE, "EE"], [RR, "RR"]] as const) {
  tokens[t] = { symbol: s, decimals: 6, price: 0.001, launchpad: "pump.fun" };
}

config.latencyMs = 20;

// Cotizaciones de compra (USDC → token) con un multiplicador por petición (1 = el precio del mercado falso) y un gancho que
// se llama en cada una que llega al mercado (n = cuántas van de ese token).
const buyFactors: Record<string, number[]> = {};
const buyHits: Record<string, number> = {};
const onBuyHit: Record<string, (n: number) => void> = {};
const nextBuys = (token: string, ...f: number[]) => {
  buyFactors[token] = f;
  buyHits[token] = 0;
};
for (const t of [SWAPPED, TIMEOUT, CC, DD, EE, RR]) nextBuys(t);
function route(url: URL): Response | undefined {
  if (url.host !== "lite-api.jup.ag" || url.pathname !== "/swap/v1/quote") return undefined;
  const inMint = url.searchParams.get("inputMint")!;
  const outMint = url.searchParams.get("outputMint")!;
  if (inMint !== USDC_MINT || !(outMint in buyFactors)) return undefined;
  buyHits[outMint] = (buyHits[outMint] ?? 0) + 1;
  onBuyHit[outMint]?.(buyHits[outMint]!);
  const f = buyFactors[outMint]!.length ? buyFactors[outMint]!.shift()! : 1;
  const out = (Number(url.searchParams.get("amount")) / 1e6 / tokens[outMint]!.price) * (1 - POOL_FEE) * f;
  const plan = [{ percent: 100, swapInfo: { label: "Fake AMM", ammKey: "fake" } }];
  return new Response(JSON.stringify({ inAmount: url.searchParams.get("amount"), outAmount: String(Math.floor(out * 1e6)), priceImpactPct: "0", slippageBps: 300, routePlan: plan, contextSlot: 1 }));
}
setExtraRoutes(route);

const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y las creencias negativas" };
const text = (r: { content: unknown }) => String(r.content);
const sessionsOf = (id: number) => (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE mission_id = ?").get(id) as { n: number }).n;
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

// Lo que hace el servidor MCP al arrancar el reloj (openWorkSession en src/mcp.ts, que no se puede importar sin arrancarlo):
// con la misión que le pasa runTool, nunca «la activa». Anota con qué misión se le llamó.
function mcpCtx(missionId: number) {
  const calls: number[] = [];
  return {
    calls,
    ctx: {
      sessionId: startSession(missionId),
      missionId,
      startClock: async (forMission: number) => {
        calls.push(forMission);
        await checkOrders().catch(() => []);
        await checkMission().catch(() => []);
        const id = forMission ?? (getActiveMission() ?? getLastMission())?.id ?? null;
        startMissionClock(id);
        return startSession(id);
      },
    },
  };
}

test("la misión se sustituye durante la latencia de la compra: no se compra nada y la misión nueva queda intacta (sin reloj, gemelo ni sesión)", async () => {
  const m1 = await createMission(50, 62.5, 10, undefined, { solana: 100 }, { costMode: "real" });
  const { ctx, calls } = mcpCtx(m1.id);
  const sol0 = balance(m1.id, "solana", SOL_MINT);
  let m2: Promise<{ id: number }> | undefined;
  // Con la primera cotización (la del preflight), el usuario crea otra misión mientras la compra sigue en marcha.
  onBuyHit[SWAPPED] = (n) => {
    if (n === 1) m2 = new Promise((r) => setTimeout(r, 100)).then(() => createMission(50, 62.5, 10, undefined, { solana: 100 }, { costMode: "real" }));
  };
  config.latencyMs = 500;
  const r = await runTool("enter_with_exits", { token: SWAPPED, thesis }, ctx);
  config.latencyMs = 20;
  const two = await m2!;

  assert.equal(r.isError, true, text(r));
  assert.match(text(r), new RegExp(`La misión #${m1.id} ya no está activa \\(cancelled: replaced\\): el swap no se ha enviado, así que no se ha comprado ni vendido nada`));
  assert.match(text(r), /\(el reloj no ha arrancado\)/);
  // La misión vieja: sin la compra (ni la red), sin reloj y sin descartar el token (no fue el precio).
  assert.equal(balance(m1.id, "solana", SWAPPED), 0);
  assert.equal(balance(m1.id, "solana", USDC_MINT), 48.5);
  assert.equal(balance(m1.id, "solana", SOL_MINT), sol0);
  assert.equal(getMission(m1.id)!.started_at, null);
  assert.equal(getMission(m1.id)!.entry_at, null);
  assert.deepEqual(excludedTokens(m1.id), []);
  assert.equal(db.prepare("SELECT 1 FROM journal WHERE mission_id = ? AND kind = 'swap'").get(m1.id), undefined);
  // La nueva, intacta: nadie ha operado en ella.
  assert.deepEqual(calls, [], "no se abrió ninguna sesión de trabajo");
  const after2 = getMission(two.id)!;
  assert.equal(after2.status, "active");
  assert.equal(after2.started_at, null);
  assert.equal(db.prepare("SELECT 1 FROM shadow_runs WHERE mission_id = ?").get(two.id), undefined, "sin gemelo");
  assert.equal(sessionsOf(two.id), 0);
  db.prepare("UPDATE missions SET status = 'cancelled' WHERE id = ?").run(two.id);
});

test("la misión caduca por prep_timeout durante la latencia de la compra: no se compra nada", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 }, { costMode: "real" });
  const { ctx, calls } = mcpCtx(m.id);
  let bg: Promise<string[]> | undefined;
  // Mientras se compra, se cruzan los 60 min sin reloj y pasa la vuelta de fondo (checkMission).
  onBuyHit[TIMEOUT] = (n) => {
    if (n !== 1) return;
    bg = new Promise((r) => setTimeout(r, 100)).then(() => {
      const created = Date.now() - 61 * 60_000;
      db.prepare("UPDATE missions SET created_at = ?, deadline = ? WHERE id = ?").run(new Date(created).toISOString(), new Date(created + 10 * 60_000).toISOString(), m.id);
      return checkMission();
    });
  };
  config.latencyMs = 500;
  const r = await runTool("enter_with_exits", { token: TIMEOUT, thesis }, ctx);
  config.latencyMs = 20;
  assert.ok((await bg!).some((l) => /prep_timeout/.test(l)));

  assert.equal(r.isError, true, text(r));
  assert.match(text(r), new RegExp(`La misión #${m.id} ya no está activa \\(cancelled: prep_timeout\\)`));
  const after = getMission(m.id)!;
  assert.equal(after.status, "cancelled");
  assert.equal(after.end_reason, "prep_timeout");
  assert.equal(after.entry_at, null);
  assert.equal(balance(m.id, "solana", TIMEOUT), 0, "la compra no se aplica a una misión cancelada");
  assert.equal(balance(m.id, "solana", USDC_MINT), 48.5);
  assert.deepEqual(calls, []);
});

test("prep_timeout no cancela una misión con una compra recién llenada (el reloj arranca al volver); pasado el margen, sí", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const created = Date.now() - 61 * 60_000;
  db.prepare("UPDATE missions SET created_at = ?, deadline = ? WHERE id = ?").run(new Date(created).toISOString(), new Date(created + 10 * 60_000).toISOString(), m.id);
  // La compra de enter_with_exits ya está en el diario, y el reloj aún no ha arrancado (se está registrando la posición).
  logJournal({ missionId: m.id, sessionId: null, kind: "swap", summary: "Swap 48.5 USDC → 48354 XX" });
  assert.deepEqual(await checkMission(m.id), []);
  assert.equal(getMission(m.id)!.status, "active");
  // Si el reloj no llega a arrancar (el proceso murió), pasado el margen se cancela igualmente.
  db.prepare("UPDATE journal SET ts = ? WHERE mission_id = ? AND kind = 'swap'").run(new Date(Date.now() - 6 * 60_000).toISOString(), m.id);
  const lines = await checkMission(m.id);
  assert.match(lines.join("\n"), /prep_timeout/);
  assert.equal(getMission(m.id)!.end_reason, "prep_timeout");
});

test("runTool: si la misión deja de estar activa con la entrada ya hecha, no arranca nada ni abre sesión (y menos en la misión nueva)", async () => {
  let m1 = 0;
  let m2 = 0;
  let swapRow = 0;
  const tools = [
    {
      name: "entrar",
      kind: "trade",
      startsClock: true,
      description: "",
      schema: z.object({}),
      entry: async (_i: unknown, c: { sessionId: number }) => {
        logJournal({ missionId: m1, sessionId: c.sessionId, kind: "swap", summary: "la compra" });
        swapRow = (db.prepare("SELECT MAX(id) AS id FROM journal").get() as { id: number }).id;
        // Mientras se registraba la compra, el usuario crea otra misión: la de esta llamada queda sustituida.
        m2 = (await createMission(50, 62.5, 10, undefined, { solana: 100 })).id;
        return { clock: { atMs: Date.now() } };
      },
      run: async () => "no debería llegar aquí",
    },
  ];
  m1 = (await createMission(50, 62.5, 10, undefined, { solana: 100 })).id;
  const { ctx, calls } = mcpCtx(m1);
  const r = await runTool("entrar", {}, ctx, tools);
  assert.equal(r.isError, true);
  assert.match(text(r), /La compra se ha hecho, pero la misión ya no está activa: no se ha puesto la toma de beneficio/);
  assert.deepEqual(calls, [], "sin sesión de trabajo");
  assert.equal(getMission(m1)!.started_at, null);
  assert.equal(getMission(m2)!.started_at, null, "el reloj de la misión nueva no arranca");
  assert.equal(db.prepare("SELECT 1 FROM shadow_runs WHERE mission_id = ?").get(m2), undefined);
  assert.equal(sessionsOf(m2), 0);
  assert.equal((db.prepare("SELECT session_id FROM journal WHERE id = ?").get(swapRow) as { session_id: number }).session_id, ctx.sessionId, "la compra se queda donde estaba");
  db.prepare("UPDATE missions SET status = 'cancelled' WHERE id = ?").run(m2);
});

test("runTool: startClock recibe la misión de la llamada, y la compra solo pasa a una sesión de esa misión", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  let row = 0;
  const tools = [
    {
      name: "entrar",
      kind: "trade",
      startsClock: true,
      description: "",
      schema: z.object({}),
      entry: async (_i: unknown, c: { sessionId: number }) => {
        logJournal({ missionId: m.id, sessionId: c.sessionId, kind: "swap", summary: "la compra" });
        row = (db.prepare("SELECT MAX(id) AS id FROM journal").get() as { id: number }).id;
        return { clock: { atMs: Date.now() } };
      },
      run: async (_i: unknown, c: { sessionId: number }) => `sesión ${c.sessionId}`,
    },
  ];
  const args: number[] = [];
  // Una sesión que no es de esta misión (p. ej. la de otra): la compra no se mueve a ella.
  const foreign = startSession(null);
  const ctx = { sessionId: startSession(m.id), missionId: m.id, startClock: async (id: number) => (args.push(id), startMissionClock(id), foreign) };
  const r = await runTool("entrar", {}, ctx, tools);
  assert.ok(!r.isError, text(r));
  assert.deepEqual(args, [m.id]);
  assert.ok(getMission(m.id)!.started_at);
  assert.equal((db.prepare("SELECT session_id FROM journal WHERE id = ?").get(row) as { session_id: number }).session_id, ctx.sessionId);
  db.prepare("UPDATE missions SET status = 'cancelled' WHERE id = ?").run(m.id);
});

test("misión rápida: simulate_swap y las órdenes que compran no compran un token descartado ni con más slippage que el de la entrada; vender no tiene tope", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 }, { costMode: "real" });
  const ctx = { sessionId: startSession(m.id), missionId: m.id };
  const ok = await runTool("enter_with_exits", { token: CC, thesis }, ctx);
  assert.ok(!ok.isError, text(ok));
  // Reentrada: fuera la toma de beneficio, se vende (con el slippage que sea: vender no tiene tope) y la compra del
  // siguiente revierte (el precio cae un 12 % en la latencia): DD queda descartado.
  const order = db.prepare("SELECT id FROM orders WHERE mission_id = ? AND status = 'open'").get(m.id) as { id: number };
  assert.ok(!(await runTool("cancel_order", { id: order.id }, ctx)).isError);
  const sold = await runTool("simulate_swap", { chain: "solana", input: CC, output: USDC_MINT, sell_all: true, slippage_bps: 2500, thesis }, ctx);
  assert.ok(!sold.isError, text(sold));
  nextBuys(DD, 1, 0.88, 0.88 * 0.88);
  const rev = await runTool("enter_with_exits", { token: DD, tp_at_target: true, thesis }, ctx);
  assert.equal(rev.isError, true);
  assert.deepEqual(excludedTokens(m.id), [DD]);

  // Lo de la M18 con otra herramienta: forzarlo subiendo el slippage. Ni con simulate_swap ni con una orden condicional.
  const usdc = balance(m.id, "solana", USDC_MINT);
  nextBuys(DD, 1, 0.88);
  const forced = await runTool("simulate_swap", { chain: "solana", input: USDC_MINT, output: DD, amount: usdc, slippage_bps: 2500, thesis }, ctx);
  assert.equal(forced.isError, true, text(forced));
  assert.match(text(forced), /DD está descartado en esta misión \(la compra revirtió: .*\): no se compra, ni con enter_with_exits ni con simulate_swap/);
  const same = await runTool("simulate_swap", { chain: "solana", input: "USDC", output: DD, amount: usdc, slippage_bps: 100, thesis }, ctx);
  assert.match(text(same), /DD está descartado/);
  const timed = await runTool(
    "place_swap_trigger_order",
    { chain: "solana", condition: "time", in_minutes: 0.1, input: "USDC", output: DD, amount: usdc, slippage_bps: 300, thesis },
    ctx,
  );
  assert.match(text(timed), /DD está descartado en esta misión .*ni con una orden condicional/);
  assert.equal(balance(m.id, "solana", DD), 0);
  assert.equal(buyHits[DD], 0, "rechazadas sin cotizar");

  // Otro token: con más slippage que el de la entrada (300, sin plan), no; dentro del tope, sí.
  const high = await runTool("simulate_swap", { chain: "solana", input: USDC_MINT, output: EE, amount: 5, slippage_bps: 2500, thesis }, ctx);
  assert.match(text(high), /slippage_bps 2500 pasa del tope de 300 para comprar un token en una misión rápida \(el de por defecto, el mismo que en enter_with_exits\)/);
  const highOrder = await runTool("place_swap_trigger_order", { chain: "solana", condition: "time", in_minutes: 0.1, input: USDC_MINT, output: EE, amount: 5, slippage_bps: 800, thesis }, ctx);
  assert.match(text(highOrder), /slippage_bps 800 pasa del tope de 300/);
  const fine = await runTool("simulate_swap", { chain: "solana", input: USDC_MINT, output: EE, amount: 5, slippage_bps: 300, thesis }, ctx);
  assert.ok(!fine.isError, text(fine));
  // Comprar el nativo (gas) o vender el token: sin tope.
  assert.ok(!(await runTool("simulate_swap", { chain: "solana", input: USDC_MINT, output: SOL_MINT, amount: 1, slippage_bps: 2500, thesis }, ctx)).isError);
  const out = await runTool("simulate_swap", { chain: "solana", input: EE, output: USDC_MINT, sell_all: true, slippage_bps: 2500, thesis }, ctx);
  assert.ok(!out.isError, text(out));
  db.prepare("UPDATE missions SET status = 'cancelled' WHERE id = ?").run(m.id);

  // Una misión que no es rápida (30 min: la opera el trader) no tiene ese tope.
  const slow = await createMission(50, 62.5, 30, undefined, { solana: 100 });
  startMissionClock(slow.id);
  const slowBuy = await runTool("simulate_swap", { chain: "solana", input: USDC_MINT, output: EE, amount: 5, slippage_bps: 2500, thesis }, { sessionId: startSession(slow.id), missionId: slow.id });
  assert.ok(!slowBuy.isError, text(slowBuy));
  db.prepare("UPDATE missions SET status = 'cancelled' WHERE id = ?").run(slow.id);
});

test("plan: una misión cancelada a los 60 min con candidatos cuya compra revirtió no cuenta como «sin candidato»", async () => {
  const w = await runTool("write_plan", planInput({ duration_minutes: 12, target_pct: 25 }), { sessionId: 1, missionId: null });
  assert.ok(!w.isError, text(w));
  const planId = Number(text(w).match(/Plan #(\d+)/)![1]);
  const timeOut = async (id: number) => {
    const created = Date.now() - 61 * 60_000;
    db.prepare("UPDATE missions SET created_at = ?, deadline = ? WHERE id = ?").run(new Date(created).toISOString(), new Date(created + 12 * 60_000).toISOString(), id);
    await checkMission(id);
    assert.equal(getMission(id)!.end_reason, "prep_timeout");
  };

  // B: sin ningún candidato (wait_for_signal marca la misión con el plan y no devuelve nada).
  const b = await createMission(50, 62.5, 12, undefined, { solana: 100 }, { costMode: "real" });
  markPlanForMission(b.id, planId);
  await timeOut(b.id);
  // A: llega un candidato y su compra revierte (el precio cae un 15 % en la latencia): queda descartado.
  const a = await createMission(50, 62.5, 12, undefined, { solana: 100 }, { costMode: "real" });
  markPlanForMission(a.id, planId);
  recordSignal(a.id, RR);
  nextBuys(RR, 1, 0.85, 0.85 * 0.85);
  const rv = await runTool("enter_with_exits", { token: RR, thesis: { plan_ref: planId } }, { sessionId: startSession(a.id), missionId: a.id });
  assert.equal(rv.isError, true);
  assert.deepEqual(excludedTokens(a.id), [RR]);
  await timeOut(a.id);
  // C: llega un candidato pero no se entra (p. ej. el preflight lo rechaza): tampoco es «sin candidato».
  const c = await createMission(50, 62.5, 12, undefined, { solana: 100 }, { costMode: "real" });
  markPlanForMission(c.id, planId);
  recordSignal(c.id, EE);
  await timeOut(c.id);

  const block = planBlock(planId);
  assert.deepEqual(
    [block.noCandidate, block.candidateNoEntry, block.reverted, block.lastWithoutCandidate, block.lastCandidateNoEntry],
    [1, 2, 1, null, c.id],
  );
  const plan = text(await runTool("get_plan", { plan_id: planId }, { sessionId: 1, missionId: null }));
  assert.match(plan, /withoutCandidate:/);
  assert.match(plan, /1 misión\(es\) preparadas con este plan se cancelaron a los 60 min sin que llegara ningún candidato/);
  assert.match(plan, /candidatesNotEntered:/);
  assert.match(plan, /2 misión\(es\) preparadas con este plan se cancelaron a los 60 min sin arrancar el reloj, pero SÍ les llegaron candidatos \(en 1, la compra de enter_with_exits revirtió/);
  assert.match(plan, /no es motivo para aflojarlos/);

  // El estado, el informe y los datos del revisor de A dicen que su compra revirtió, y con qué token.
  const status = JSON.parse(text(await runTool("mission_status", {}, { sessionId: 1, missionId: a.id })));
  assert.equal(status.mission.endReason, "prep_timeout");
  assert.equal(status.mission.revertedEntries[0].token, RR);
  assert.match(status.mission.revertedEntries[0].reason, /la compra revirtió: el precio se ha movido en tu contra un 15\.0 %/);
  assert.match(await statusReport(a.id), /cancelada: el reloj no arrancó en 60 min \(llegaron candidatos, pero su compra revirtió\)/);
  const review = text(await runTool("mission_review_data", { mission_id: a.id }, { sessionId: 1, missionId: a.id }));
  assert.match(review, /entryExclusions:/);
  assert.match(review, new RegExp(RR));
  assert.doesNotMatch(text(await runTool("mission_review_data", { mission_id: b.id }, { sessionId: 1, missionId: b.id })), /entryExclusions/);

  // En el panel, la misión A lleva sus compras revertidas.
  const batches = aggregateBatches(loadFastMissions());
  assert.equal(batches.missions.find((x) => x.id === a.id)!.revertedEntries, 1);
  assert.equal(batches.missions.find((x) => x.id === b.id)!.revertedEntries, 0);
});
