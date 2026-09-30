// Plan del cerebro y entrada rápida: write_plan y get_plan, el plan asignado al arrancar el reloj, la tesis abreviada
// (plan_ref) solo en misiones rápidas, el briefing ligero y enter_with_exits (reloj, compra y toma de beneficio en una
// sola llamada, sin crear ni perder dinero por el camino).
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now } from "../src/db.js";
import { SOL_MINT, USDC_MINT } from "../src/market/jupiter.js";
import { checkMission, createLiveMission, createMission, getMission, startMissionClock } from "../src/sim/mission.js";
import { checkOrders } from "../src/sim/orders.js";
import { PLAN_BLOCK_SIZE, activePlan, getPlan, markPlanForMission, planBlock, planForMission } from "../src/sim/plans.js";
import { balance, valuation } from "../src/sim/portfolio.js";
import { sessionBriefing } from "../src/sim/session.js";
import { TP_TARGET_MARGIN } from "../src/sim/entry.js";
import { CLOCK_NOT_STARTED, runTool } from "../src/tools/index.js";
import { installFakeMarket, MEME, POOL_FEE, setPrice, tokens } from "./fake-market.js";

installFakeMarket();

const planInput = (over: Record<string, unknown> = {}) => ({
  duration_minutes: 10,
  target_pct: 25,
  event: "token de pump.fun migrado a PumpSwap hace 2 min o menos",
  filters: { min_liquidity_usd: 5_000 },
  reentry: "una vez, si la posición vale la mitad o menos y queda medio reloj",
  reentry_allowed: true,
  risks_checked: "revisé las creencias negativas de pump.fun y los datos de riskCheck: ninguna descarta la regla",
  why: "la P base de los recién graduados es la más alta medida",
  evidence: "35 % de acierto en 925 tokens (IC95 32-38 %)",
  sources: ["estudio de recién graduados"],
  predicted_p: 0.38,
  baseline_p: 0.35,
  ...over,
});

const ctxOf = (missionId: number | null) => ({ sessionId: 1, missionId });
const text = (r: { content: unknown }) => String(r.content);
const planIdOf = (r: { content: unknown }) => Number(text(r).match(/Plan #(\d+)/)![1]);

test("write_plan y get_plan: un plan vigente por clase, fijo durante su bloque", async () => {
  const r = await runTool("write_plan", planInput(), ctxOf(null));
  assert.ok(!r.isError, text(r));
  const id = planIdOf(r);
  const plan = getPlan(id)!;
  assert.equal(plan.class, "graduado-10m-+25%");
  assert.equal(plan.predicted_p, 0.38);
  assert.equal(plan.body.source, "graduado", "fuente por defecto");
  assert.equal(plan.body.sizing, "todo el capital menos el gas");

  const read = text(await runTool("get_plan", { mission_class: "graduado-10m-+25%" }, ctxOf(null)));
  assert.match(read, new RegExp(`planId: ${id}`));
  assert.match(read, /0 de 20 misiones terminadas/);

  // A mitad de bloque no se cambia sin motivo...
  const again = await runTool("write_plan", planInput({ predicted_p: 0.5 }), ctxOf(null));
  assert.equal(again.isError, true);
  assert.match(text(again), /queda fijo durante su bloque/);
  assert.equal(activePlan("graduado-10m-+25%")!.id, id);
  // ...y con motivo sí: el anterior deja de estar vigente y el nuevo guarda cuál sustituye.
  const replaced = await runTool("write_plan", planInput({ replace_reason: "su fuente no ha dado ni un candidato en una hora" }), ctxOf(null));
  assert.ok(!replaced.isError, text(replaced));
  const id2 = planIdOf(replaced);
  assert.equal(getPlan(id)!.active, false);
  assert.deepEqual(getPlan(id2)!.body.replaces, { id, reason: "su fuente no ha dado ni un candidato en una hora" });
  assert.match(text(await runTool("get_plan", { plan_id: id }, ctxOf(null))), new RegExp(`Ya no está vigente: el de graduado-10m-\\+25% es el #${id2}`));

  // Con el bloque terminado, el plan se sustituye sin dar motivo.
  const insert = db.prepare("INSERT INTO missions (created_at, initial_usd, target_usd, deadline, status, started_at, plan_id) VALUES (?, 50, 62.5, ?, ?, ?, ?)");
  for (let i = 0; i < PLAN_BLOCK_SIZE; i++) insert.run(now(), now(), i < 7 ? "succeeded" : "expired", now(), id2);
  assert.match(text(await runTool("get_plan", { plan_id: id2 }, ctxOf(null))), /20 de 20 misiones terminadas \(7 conseguidas\)/);
  // El mercado de la clase es el de la fuente (graduado): otro se rechaza, no crea otra clase con otra línea base.
  const momentum = await runTool("write_plan", planInput({ market: "momentum" }), ctxOf(null));
  assert.equal(momentum.isError, true);
  assert.match(text(momentum), /El mercado de un plan es el de su fuente/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plans WHERE class LIKE 'momentum-%'").get()!.n, 0);
  const next2 = await runTool("write_plan", planInput(), ctxOf(null));
  assert.ok(!next2.isError, text(next2));
  // Y los planes son de misiones rápidas: un plazo de más de 15 min no tiene plan.
  assert.match(text(await runTool("write_plan", planInput({ duration_minutes: 60 }), ctxOf(null))), /Los planes son de misiones rápidas/);
});

test("write_plan valida lo que no puede faltar", async () => {
  assert.match(text(await runTool("write_plan", planInput({ source: "shortlist" }), ctxOf(null))), /necesita la lista corta/);
  assert.match(text(await runTool("write_plan", planInput({ duration_minutes: 5, target_pct: undefined }), ctxOf(null))), /juntos/);
  assert.match(text(await runTool("write_plan", planInput({ risks_checked: "nada" }), ctxOf(null))), /Entrada no válida/);
  assert.match(text(await runTool("write_plan", planInput({ beliefs_applied: [999] }), ctxOf(null))), /#999 no existen/);
});

test("sin plazo ni objetivo, la clase es la de la misión activa; al arrancar el reloj la misión se queda con el plan", async () => {
  const m = await createMission(20, 30, 5, undefined, { solana: 100 });
  const r = await runTool("write_plan", planInput({ duration_minutes: undefined, target_pct: undefined }), ctxOf(m.id));
  assert.ok(!r.isError, text(r));
  const plan = getPlan(planIdOf(r))!;
  assert.equal(plan.class, "graduado-5m-+50%");
  assert.equal(getMission(m.id)!.plan_id, null, "antes del reloj todavía no se asigna");
  startMissionClock(m.id);
  const started = getMission(m.id)!;
  assert.equal(started.plan_id, plan.id);
  assert.equal(started.predicted_p, 0.38);
  assert.equal(started.baseline_p, 0.35);
  assert.match(text(await runTool("mission_status", {}, ctxOf(m.id))), new RegExp(`"planId":${plan.id}`));
});

test("briefing ligero en una misión rápida: reloj, plan y cartera; sin memoria ni strategy_fit", async () => {
  const fast = await createMission(20, 30, 5, undefined, { solana: 100 });
  const brief = await sessionBriefing(1, fast.id);
  assert.match(brief, /Misión rápida:/);
  assert.match(brief, /Plan vigente \(cítalo con plan_ref: \d+\)/);
  assert.match(brief, /Cartera:/);
  assert.doesNotMatch(brief, /Encaje de estrategias|Tu memoria|primera misión|Tus notas|Últimas entradas del diario|El diario está vacío/);

  const slow = await createMission(1000, 1100, 120, undefined, { solana: 100 });
  const long = await sessionBriefing(1, slow.id);
  assert.doesNotMatch(long, /Misión rápida/);
  assert.match(long, /Tu memoria|primera misión/);
});

test("tesis abreviada: plan_ref vale en una misión rápida y queda la tesis del plan; en una larga, no", async () => {
  setPrice(MEME, 0.01);
  const plan = activePlan("graduado-10m-+25%")!;
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(m.id);
  const r = await runTool("simulate_swap", { chain: "solana", input: "USDC", output: MEME, amount: 10, slippage_bps: 300, thesis: { plan_ref: plan.id } }, ctxOf(m.id));
  assert.ok(!r.isError, text(r));
  const j = db.prepare("SELECT reasoning FROM journal WHERE mission_id = ? AND kind = 'swap' ORDER BY id DESC LIMIT 1").get(m.id) as { reasoning: string };
  assert.match(j.reasoning, new RegExp(`Por qué: Plan #${plan.id} \\(graduado-10m-\\+25%\\)`));
  assert.match(j.reasoning, /Riesgos comprobados: revisé las creencias negativas/);

  // Un plan que no existe, o de otra clase, no vale.
  assert.match(text(await runTool("simulate_swap", { chain: "solana", input: "USDC", output: MEME, amount: 1, thesis: { plan_ref: 9999 } }, ctxOf(m.id))), /No existe el plan #9999/);
  const other = (db.prepare("SELECT id FROM plans WHERE class = 'graduado-5m-+50%' AND active = 1").get() as { id: number }).id;
  assert.match(text(await runTool("simulate_swap", { chain: "solana", input: "USDC", output: MEME, amount: 1, thesis: { plan_ref: other } }, ctxOf(m.id))), /no son de la misma clase/);

  const slow = await createMission(1000, 1100, 60, undefined, { solana: 100 });
  startMissionClock(slow.id);
  const long = await runTool("simulate_swap", { chain: "solana", input: "USDC", output: MEME, amount: 10, thesis: { plan_ref: plan.id } }, ctxOf(slow.id));
  assert.equal(long.isError, true);
  assert.match(text(long), /plan_ref solo vale en misiones rápidas/);
});

test("enter_with_exits: arranca el reloj, compra con todo el efectivo y deja la toma de beneficio en el objetivo", async () => {
  setPrice(MEME, 0.01);
  const plan = activePlan("graduado-10m-+25%")!;
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const ctx = { sessionId: 1, missionId: m.id, startClock: async () => (startMissionClock(m.id), 42) };
  const usdc = balance(m.id, "solana", USDC_MINT);
  const sol = balance(m.id, "solana", SOL_MINT);

  // Antes del reloj, operar se rechaza; enter_with_exits es la excepción: arranca el reloj ella misma.
  const early = await runTool("simulate_swap", { chain: "solana", input: "USDC", output: MEME, amount: 5, thesis: { plan_ref: plan.id } }, ctx);
  assert.equal(early.content, `Error: ${CLOCK_NOT_STARTED}`);
  const r = await runTool("enter_with_exits", { token: MEME, thesis: { plan_ref: plan.id } }, ctx);
  assert.ok(!r.isError, text(r));
  const out = JSON.parse(text(r));
  const after = getMission(m.id)!;
  assert.ok(after.started_at, "el reloj corre");
  const left = new Date(after.deadline).getTime() - Date.now();
  assert.ok(left > 9.9 * 60_000 && left <= 10 * 60_000, `plazo desde ahora (${left} ms)`);
  assert.equal(out.clock.deadline, after.deadline);
  assert.equal(after.plan_id, plan.id);
  assert.equal(after.predicted_p, plan.predicted_p);
  assert.equal((db.prepare("SELECT session_id FROM journal WHERE mission_id = ? AND kind = 'swap'").get(m.id) as { session_id: number }).session_id, 42, "en la sesión nueva");

  // Dinero: todo el USDC sale y entra el token que da la cotización (comisión del pool incluida); el SOL solo paga la red.
  const qty = balance(m.id, "solana", MEME);
  assert.ok(balance(m.id, "solana", USDC_MINT) < 1e-9, "todo el efectivo");
  assert.ok(Math.abs(qty - (usdc / 0.01) * (1 - POOL_FEE)) < 1e-3, `tokens ${qty}`);
  assert.ok(Math.abs(out.tokensBought - qty) < 1e-9);
  assert.ok(balance(m.id, "solana", SOL_MINT) < sol && balance(m.id, "solana", SOL_MINT) > sol - 0.003, "red y renta en SOL");
  const v = await valuation(m.id);
  assert.ok(v.totalUsd < 50 && v.totalUsd > 49, `sin crear dinero: ${v.totalUsd}`);

  // La toma de beneficio: vende todo, a un precio que deja la misión en el objetivo neto.
  const order = db.prepare("SELECT * FROM orders WHERE mission_id = ? AND status = 'open'").get(m.id) as { id: number; condition: string; trigger_asset: string; trigger_price: number; action: string };
  assert.equal(order.id, out.takeProfit.orderId);
  assert.equal(order.condition, "above");
  assert.equal(order.trigger_asset, MEME);
  assert.deepEqual(JSON.parse(order.action), { input: MEME, output: "USDC", amount: 0, sellAll: true, slippageBps: 300 });
  const others = v.totalUsd - v.holdings.find((h) => h.asset === MEME)!.usd;
  assert.ok(Math.abs(order.trigger_price * qty + others - 62.5 * (1 + TP_TARGET_MARGIN)) < 0.02, "precio del objetivo neto");
  assert.ok(out.takeProfit.tpRatio > 1.25 && out.takeProfit.tpRatio < 1.3, `ratio ${out.takeProfit.tpRatio}`);

  // Sube lo suficiente: salta la toma de beneficio y la misión se cierra conseguida.
  setPrice(MEME, 0.01 * 1.35);
  await checkOrders();
  assert.equal((db.prepare("SELECT status FROM orders WHERE id = ?").get(order.id) as { status: string }).status, "filled");
  await checkMission(m.id);
  const done = getMission(m.id)!;
  assert.equal(done.status, "succeeded");
  assert.ok(done.final_usd! >= 62.5, `final ${done.final_usd}`);
});

test("enter_with_exits con tp_ratio, con importe fijo y sin plan (tesis completa)", async () => {
  setPrice(MEME, 0.02);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y las creencias negativas" };
  const r = await runTool("enter_with_exits", { token: MEME, usd_amount: 20, tp_ratio: 1.3, thesis }, ctxOf(m.id));
  assert.ok(!r.isError, text(r));
  const out = JSON.parse(text(r));
  assert.ok(getMission(m.id)!.started_at, "sin ctx.startClock arranca solo el reloj");
  assert.ok(Math.abs(balance(m.id, "solana", USDC_MINT) - (50 - 1.5 - 20)) < 0.2, "gasta solo el importe pedido");
  assert.ok(Math.abs(out.takeProfit.triggerPrice - out.entryPrice * 1.3) < 1e-9);
  assert.match(out.takeProfit.basis, /×1.3 del precio de compra \(parámetro\)/);

  // Más de lo que hay no se puede; la misión rápida sigue con lo comprado.
  const r2 = await runTool("enter_with_exits", { token: MEME, usd_amount: 500, thesis }, ctxOf(m.id));
  assert.match(text(r2), /usd_amount no puede pasar de ahí/);
  // Ni en una misión real ni con el efectivo como "token".
  assert.match(text(await runTool("enter_with_exits", { token: "USDC", thesis }, ctxOf(m.id))), /ni el efectivo ni el nativo/);
  tokens[MEME]!.price = 0.01;
  installFakeMarket();
});

test("una misión real nunca es rápida: clase libre, briefing completo y sin plan_ref, aunque dure 15 min", async () => {
  const live = createLiveMission({
    holdings: [{ venue: "solana", asset: USDC_MINT, symbol: "USDC", decimals: 6, amount: 50 }],
    totalUsd: 50,
    byChain: { solana: 50, base: 0, bsc: 0 },
    targetPct: 10,
    durationMinutes: 15,
    approval: "auto",
    limits: { maxTradeUsd: 25, maxLossPct: 30 },
  });
  assert.equal(live.class, "libre-15m-+10%");
  const status = JSON.parse(text(await runTool("mission_status", {}, ctxOf(live.id))));
  assert.equal(status.missionKind, "normal", "la opera el trader");
  const brief = await sessionBriefing(1, live.id);
  assert.doesNotMatch(brief, /Misión rápida/);
  assert.match(brief, /Tu memoria|primera misión/, "con su memoria (y el briefing del revisor, si lo hay)");
  // El planner no le escribe plan, y una operación no puede citar uno.
  assert.match(text(await runTool("write_plan", planInput({ duration_minutes: undefined, target_pct: undefined }), ctxOf(live.id))), /no es rápida/);
  startMissionClock(live.id);
  assert.equal(getMission(live.id)!.plan_id, null);
  assert.equal(db.prepare("SELECT 1 FROM shadow_runs WHERE mission_id = ?").get(live.id), undefined, "sin gemelo");
  db.prepare("UPDATE missions SET status = 'cancelled' WHERE id = ?").run(live.id);

  const sim = await createMission(50, 62.5, 15, undefined, { solana: 100 });
  assert.equal(JSON.parse(text(await runTool("mission_status", {}, ctxOf(sim.id)))).missionKind, "rápida");
});

test("plan sin candidatos: la misión que se cancela a los 60 min sin reloj cuenta en su bloque y deja en el diario por qué", async () => {
  // Un plan cuyo filtro no deja pasar nada.
  const r = await runTool("write_plan", planInput({ duration_minutes: 5, target_pct: 100, filters: { min_liquidity_usd: 1e12 } }), ctxOf(null));
  assert.ok(!r.isError, text(r));
  const planId = planIdOf(r);
  const m = await createMission(20, 40, 5, undefined, { solana: 100 });
  const w = text(await runTool("wait_for_signal", { max_minutes: 0.25 }, ctxOf(m.id)));
  assert.match(w, /Sin señal/);
  assert.equal(getMission(m.id)!.plan_id, planId, "antes del reloj, la misión queda marcada con el plan con el que se prepara");
  assert.equal(getMission(m.id)!.started_at, null);
  const signal = db.prepare("SELECT summary FROM journal WHERE mission_id = ? AND kind = 'signal'").get(m.id) as { summary: string } | undefined;
  assert.match(signal?.summary ?? "", new RegExp(`wait_for_signal \\(plan #${planId}\\): Sin señal`));

  // A los 60 min sin reloj se cancela (prep_timeout): no juega en el bloque, pero el plan lo cuenta y get_plan lo avisa.
  db.prepare("UPDATE missions SET created_at = ?, deadline = ? WHERE id = ?").run(new Date(Date.now() - 61 * 60_000).toISOString(), new Date(Date.now() - 56 * 60_000).toISOString(), m.id);
  await checkMission(m.id);
  assert.equal(getMission(m.id)!.end_reason, "prep_timeout");
  const block = planBlock(planId);
  assert.deepEqual([block.finished, block.noCandidate, block.lastWithoutCandidate], [0, 1, m.id]);
  const read = text(await runTool("get_plan", { plan_id: planId }, ctxOf(null)));
  assert.match(read, /withoutCandidate:/);
  assert.match(read, new RegExp(`la última \\(#${m.id}\\) incluida: si su fuente o sus filtros no dejan pasar nada, el planner lo sustituye con replace_reason`));
  // mission_status de la misión cancelada dice por qué terminó.
  assert.match(text(await runTool("mission_status", {}, ctxOf(m.id))), /"endReason":"prep_timeout"/);

  // El planner lo sustituye con motivo; la siguiente misión se prepara con el nuevo aunque la anterior estuviera marcada con el viejo.
  const r2 = await runTool("write_plan", planInput({ duration_minutes: 5, target_pct: 100, replace_reason: "su filtro de liquidez no deja pasar ningún candidato" }), ctxOf(null));
  const plan2 = planIdOf(r2);
  const m2 = await createMission(20, 40, 5, undefined, { solana: 100 });
  markPlanForMission(m2.id, planId);
  assert.equal(planForMission(m2.id)!.id, plan2, "antes del reloj, el vigente de su clase");
  startMissionClock(m2.id);
  assert.equal(getMission(m2.id)!.plan_id, plan2);
  assert.equal(getMission(m2.id)!.predicted_p, 0.38);
  // Con el reloj en marcha, el plan queda fijo aunque se sustituya a mitad.
  await runTool("write_plan", planInput({ duration_minutes: 5, target_pct: 100, replace_reason: "otra sustitución para comprobar que el plan de la misión no cambia" }), ctxOf(null));
  assert.equal(planForMission(m2.id)!.id, plan2);
});
