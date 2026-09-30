// «Ahora mismo» del panel: la fase de la tanda (esperando plan, señal, reloj, revisión o pausa) sale de la misión, su
// plan, el diario y qué agente tiene la sesión abierta.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.js";
import { derivePhase, nowState, runningAgent, type PhaseInput, type PhaseMission } from "../src/dashboard/now.js";
import type { AgentSession } from "../src/dashboard/timeline.js";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const mission = (over: Partial<PhaseMission> = {}): PhaseMission => ({
  id: 27,
  status: "active",
  end_reason: null,
  class: "graduado-10m-+25%",
  cost_mode: "real",
  plan_id: null,
  mode: "sim",
  requested_at: at(9),
  created_at: at(9),
  started_at: null,
  ended_at: null,
  reviewed_at: null,
  deadline: new Date(NOW - 9 * 60_000 + 10 * 60_000).toISOString(),
  initial_usd: 50,
  target_usd: 62.5,
  final_usd: null,
  signal_at: null,
  signal_token: null,
  entry_at: null,
  entry_latency_s: null,
  ...over,
});

const session = (agent: AgentSession["agent"], startedMinAgo: number, lastMinAgo: number, ended = false): AgentSession => ({
  agent,
  main: true,
  startedAt: at(startedMinAgo),
  lastAt: at(lastMinAgo),
  ended,
  prompt: null,
});

const input = (over: Partial<PhaseInput> = {}): PhaseInput => ({
  nowMs: NOW,
  mission: mission(),
  classPlan: { id: 1, created_at: at(600) },
  lastSignal: null,
  lastRejection: null,
  sessions: [],
  entry: null,
  totalUsd: null,
  ...over,
});

test("fase: sin misión, y el cerebro trabajando antes de crearla", () => {
  assert.equal(derivePhase(input({ mission: null })).id, "sin-mision");
  const p = derivePhase(input({ mission: null, sessions: [session("planner", 2, 0.1)] }));
  assert.equal(p.id, "esperando-plan");
  assert.equal(p.agent?.name, "planner");
});

test("fase: esperando plan si la clase no tiene ninguno o si el cerebro está escribiéndolo", () => {
  const noPlan = derivePhase(input({ classPlan: null }));
  assert.equal(noPlan.id, "esperando-plan");
  assert.equal(noPlan.since, at(9), "desde que se pidió la misión");
  assert.equal(noPlan.costMode, "real");

  // Con plan vigente, pero el cerebro escribiendo uno nuevo: sigue siendo esperar el plan, desde que empezó.
  const writing = derivePhase(input({ sessions: [session("planner", 3, 0.2)] }));
  assert.equal(writing.id, "esperando-plan");
  assert.equal(writing.since, at(3));
  assert.equal(writing.classPlanId, 1);
});

test("fase: el cerebro escribiendo el plan de una misión recién creada es «plan», aunque haya plan vigente y lleve minutos callado", () => {
  // Misión #27: pedida hace 1 min con el plan #1 vigente (su bloque ya jugado); el cerebro, lanzado a los 7 s, trabaja.
  const m27 = mission({ plan_id: 1, requested_at: at(1), created_at: at(1) });
  const p = derivePhase(input({ mission: m27, sessions: [session("planner", 0.9, 0.05)] }));
  assert.equal(p.id, "esperando-plan");
  assert.equal(p.planStep, "escribiendo");
  assert.equal(p.agent?.name, "planner", "el panel dice «trabaja el cerebro»");
  assert.equal(p.since, at(0.9), "el cronómetro cuenta desde que empezó el cerebro");
  assert.equal(p.planId, null, "no es el plan #1 el que se está esperando");
  assert.equal(p.classPlanId, 1);

  // Una vuelta en esfuerzo máximo pasa minutos sin escribir: más de los 8 min de una sesión normal, sigue siendo el cerebro.
  const quiet = derivePhase(input({ mission: mission({ plan_id: 1, requested_at: at(15) }), sessions: [session("planner", 14.8, 12)] }));
  assert.equal(quiet.id, "esperando-plan");
  assert.equal(quiet.agent?.name, "planner");
  assert.equal(runningAgent([session("planner", 14.8, 12)], NOW), null, "para runningAgent ya estaría callado");

  // Con el revisor de la misión anterior todavía escribiendo (más reciente), el que prepara esta es el cerebro.
  const both = derivePhase(input({ mission: m27, sessions: [session("reviewer", 3, 0.01), session("planner", 0.9, 0.3)] }));
  assert.equal(both.id, "esperando-plan");
  assert.equal(both.agent?.name, "planner");

  // En cuanto el ejecutor empieza con esta misión, la fase vuelve a ser la de siempre: esperando la señal.
  const exec = derivePhase(input({ mission: mission({ plan_id: 2, requested_at: at(15) }), sessions: [session("executor", 2, 0.2), session("planner", 14.8, 12)] }));
  assert.equal(exec.id, "esperando-senal");
  assert.equal(exec.agent?.name, "executor");

  // Un cerebro terminado (cost-state) o callado más de 20 min no cuenta como trabajando.
  assert.equal(derivePhase(input({ mission: mission({ plan_id: 2, requested_at: at(15) }), sessions: [session("planner", 14.8, 13, true)] })).id, "esperando-senal");
  assert.equal(derivePhase(input({ mission: mission({ plan_id: 1, requested_at: at(40) }), sessions: [session("planner", 39, 25)] })).id, "esperando-senal");
});

test("fase: recién creada y sin ningún agente todavía, se prepara (no se espera aún la señal); a los 2 min sin nadie, la de siempre", () => {
  // Los segundos entre crear la misión y que escriba el primer agente (get_plan, arrancar claude).
  const fresh = mission({ plan_id: 1, requested_at: at(0.15), created_at: at(0.15) });
  const p = derivePhase(input({ mission: fresh }));
  assert.equal(p.id, "esperando-plan");
  assert.equal(p.planStep, "arrancando");
  assert.equal(p.label, "Preparando la misión");
  assert.equal(p.since, at(0.15));
  assert.equal(p.agent, null);
  assert.equal(p.planId, null);
  assert.equal(p.classPlanId, 1);

  // El ejecutor de la misión anterior (empezó antes de pedir esta) no cuenta como el de esta.
  assert.equal(derivePhase(input({ mission: fresh, sessions: [session("executor", 20, 0.1, true)] })).planStep, "arrancando");
  // El cerebro ya terminó y el ejecutor aún no ha escrito: el plan está hecho, se espera la señal.
  assert.equal(derivePhase(input({ mission: fresh, sessions: [session("planner", 0.14, 0.02, true)] })).id, "esperando-senal");
  // Pasados 2 min sin ningún agente: esperando señal, sin agente (como antes).
  const stale = derivePhase(input({ mission: mission({ plan_id: 1, requested_at: at(3) }) }));
  assert.equal(stale.id, "esperando-senal");
  assert.equal(stale.agent, null);
});

test("fase: esperando señal, con la última vuelta del diario, el candidato y el plazo de 60 min", () => {
  const p = derivePhase(
    input({
      mission: mission({ plan_id: 1, signal_at: at(0.2), signal_token: "Agky2fiKttQ6SiKuQTxZZuAUDgxfiMD1TMtGHqGxpump" }),
      lastSignal: { ts: at(1), summary: "wait_for_signal (plan #1): Sin señal en 278 s (23 vueltas). Tokens frescos vistos: 2; descartes: launchpad met-dbc ×2." },
      symbols: { Agky2fiKttQ6SiKuQTxZZuAUDgxfiMD1TMtGHqGxpump: "Fomo Cat" },
      sessions: [session("executor", 8, 0.5)],
    }),
  );
  assert.equal(p.id, "esperando-senal");
  assert.equal(p.since, at(8), "desde que el ejecutor empezó a esperar");
  assert.equal(p.planId, 1);
  assert.equal(p.agent?.name, "executor");
  assert.equal(p.signal?.lastWait?.waitedS, 278);
  assert.equal(p.signal?.lastWait?.seen, 2);
  assert.deepEqual(p.signal?.candidate, { token: "Agky2fiKttQ6SiKuQTxZZuAUDgxfiMD1TMtGHqGxpump", symbol: "Fomo Cat", at: at(0.2) });
  assert.equal(p.signal?.prepEndsAt, new Date(NOW - 9 * 60_000 + 60 * 60_000).toISOString());

  // Lo del diario de antes de pedir la misión (otra misión) no cuenta, y el plan de la fase es el vigente si aún no tiene.
  const old = derivePhase(input({ lastSignal: { ts: at(30), summary: "Sin señal en 270 s" }, sessions: [session("executor", 5, 0.5)] }));
  assert.equal(old.id, "esperando-senal");
  assert.equal(old.signal?.lastWait, null);
  assert.equal(old.planId, 1);
});

test("fase: una sesión terminada o callada demasiado tiempo no cuenta como trabajando", () => {
  assert.equal(runningAgent([session("executor", 20, 1, true)], NOW), null);
  assert.equal(runningAgent([session("executor", 20, 9)], NOW), null, "8 min sin escribir en el hilo principal");
  assert.equal(runningAgent([{ ...session("executor", 20, 7), main: false }], NOW), null, "6 min en un subagente");
  assert.equal(runningAgent([session("reviewer", 2, 0.1), session("executor", 20, 5)], NOW)?.agent, "reviewer", "la más reciente");
  const p = derivePhase(input({ mission: mission({ plan_id: 1 }), sessions: [session("executor", 20, 1, true)] }));
  assert.equal(p.id, "esperando-senal");
  assert.equal(p.agent, null);
  assert.equal(p.since, at(9), "sin ejecutor, desde que se pidió");
});

test("fase: reloj en marcha, con la entrada y el plazo", () => {
  const entry = { token: "T", symbol: "Fomo Cat", enteredAt: at(4), entryPriceUsd: 0.000381, tpPriceUsd: 0.00048, usdIn: 48.5, priceUsd: 0.000465, valueUsd: 59.11, valuedAt: at(0.2) };
  const started = mission({ plan_id: 1, started_at: at(4.6), created_at: at(4.6), deadline: new Date(NOW + 5.4 * 60_000).toISOString(), entry_latency_s: 6.4 });
  const p = derivePhase(input({ mission: started, entry, totalUsd: 60.6, sessions: [session("executor", 14, 0.1)] }));
  assert.equal(p.id, "reloj");
  assert.equal(p.since, at(4.6));
  assert.equal(p.clock?.deadline, started.deadline);
  assert.equal(p.clock?.closing, false);
  assert.equal(p.clock?.totalUsd, 60.6);
  assert.equal(p.clock?.latencyS, 6.4);
  assert.deepEqual(p.clock?.entry, entry);
  assert.equal(derivePhase(input({ mission: { ...started, status: "closing" } })).clock?.closing, true);
});

test("fase: revisando hasta que el revisor la da por revisada; luego, pausa", () => {
  const ended = mission({ plan_id: 1, status: "succeeded", end_reason: "target", started_at: at(15), ended_at: at(2), final_usd: 62.57 });
  const r = derivePhase(input({ mission: ended, sessions: [session("reviewer", 1.5, 0.1)] }));
  assert.equal(r.id, "revisando");
  assert.equal(r.since, at(2));
  assert.equal(r.agent?.name, "reviewer");
  assert.equal(r.result?.resultPct, 25.1);

  const p = derivePhase(input({ mission: { ...ended, reviewed_at: at(1) } }));
  assert.equal(p.id, "pausa");
  assert.equal(p.since, at(1), "desde lo último: la revisión");
  assert.equal(p.result?.endReason, "target");

  // Cancelada sin reloj: sin resultado en %.
  const cancelled = derivePhase(input({ mission: mission({ status: "cancelled", end_reason: "prep_timeout", ended_at: at(1), final_usd: 50, reviewed_at: at(0.5) }) }));
  assert.equal(cancelled.id, "pausa");
  assert.equal(cancelled.result?.resultPct, null);
});

test("nowState: de la base de datos, la última vuelta sin señal y la entrada con su toma de beneficio", () => {
  const ins = db.prepare(
    `INSERT INTO missions (created_at, requested_at, initial_usd, target_usd, deadline, status, mode, class, cost_mode, plan_id, started_at)
     VALUES (?, ?, 50, 62.5, ?, 'active', 'sim', 'graduado-10m-+25%', 'sim', ?, ?)`,
  );
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  // 1. Esperando señal: dos vueltas en el diario, se enseña la última.
  const waiting = Number(ins.run(iso(now - 300_000), iso(now - 300_000), iso(now + 300_000), null, null).lastInsertRowid);
  const journal = db.prepare("INSERT INTO journal (ts, mission_id, kind, summary, details) VALUES (?, ?, ?, ?, ?)");
  journal.run(iso(now - 200_000), waiting, "signal", "wait_for_signal (plan #1): Sin señal en 270 s (22 vueltas). Tokens frescos vistos: 1.", null);
  journal.run(iso(now - 20_000), waiting, "signal", "wait_for_signal (plan #1): Sin señal en 275 s (23 vueltas). Tokens frescos vistos: 4.", null);
  db.prepare("INSERT INTO plans (created_at, class, body, predicted_p, baseline_p, active) VALUES (?, 'graduado-10m-+25%', '{}', 0.37, 0.35, 1)").run(iso(now - 3_600_000));
  const m1 = db.prepare("SELECT * FROM missions WHERE id = ?").get(waiting) as unknown as PhaseMission;
  const p1 = nowState({ mission: m1, sessions: [], valuation: null, valuedAt: null });
  assert.equal(p1.id, "esperando-senal");
  assert.equal(p1.signal?.lastWait?.waitedS, 275);
  assert.equal(p1.signal?.lastWait?.seen, 4);

  // 2. Reloj: la compra del diario (precio = pagado / recibido), la toma de beneficio de su orden y el valor de ahora.
  const mint = "Agky2fiKttQ6SiKuQTxZZuAUDgxfiMD1TMtGHqGxpump";
  const clock = Number(ins.run(iso(now - 120_000), iso(now - 400_000), iso(now + 480_000), 1, iso(now - 120_000)).lastInsertRowid);
  db.prepare("INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, status, qty_open, cost_open_usd) VALUES (?, 'solana', ?, 'Fomo Cat', ?, 'open', 127239.5, 48.5)").run(clock, mint, iso(now - 118_000));
  journal.run(iso(now - 118_000), clock, "swap", "Swap 48.5 USDC → 127240 Fomo Cat", JSON.stringify({ outputMint: mint, sold: "48.5 USDC", received: "127239.5 Fomo Cat" }));
  db.prepare("INSERT INTO orders (created_at, mission_id, venue, trigger_asset, trigger_label, condition, trigger_price, action) VALUES (?, ?, 'solana', ?, 'Fomo Cat/USD', 'above', 0.00048, '{}')").run(
    iso(now - 117_000),
    clock,
    mint,
  );
  const m2 = db.prepare("SELECT * FROM missions WHERE id = ?").get(clock) as unknown as PhaseMission;
  const valuation = { totalUsd: 60.6, holdings: [{ venue: "solana", asset: mint, amount: 127239.5, usd: 59.11 }] };
  const p2 = nowState({ mission: m2, sessions: [], valuation, valuedAt: iso(now - 5000) });
  assert.equal(p2.id, "reloj");
  const e = p2.clock!.entry!;
  assert.equal(e.symbol, "Fomo Cat");
  assert.ok(Math.abs(e.entryPriceUsd! - 48.5 / 127239.5) < 1e-12);
  assert.equal(e.tpPriceUsd, 0.00048);
  assert.ok(Math.abs(e.priceUsd! - 59.11 / 127239.5) < 1e-12);
  assert.equal(p2.clock!.totalUsd, 60.6);

  // 3. Con la entrada medida de v0.37.2 (agent_entries), manda su precio y el de su toma de beneficio.
  db.prepare(
    "INSERT INTO agent_entries (mission_id, token, symbol, entered_at, horizon_end, usd_in, tokens, entry_price_usd, tp_price_usd) VALUES (?, ?, 'Fomo Cat', ?, ?, 48.5, 127239.5, 0.0003812, 0.0004803)",
  ).run(clock, mint, iso(now - 118_000), iso(now + 480_000));
  const p3 = nowState({ mission: m2, sessions: [], valuation, valuedAt: iso(now - 5000) });
  assert.equal(p3.clock!.entry!.entryPriceUsd, 0.0003812);
  assert.equal(p3.clock!.entry!.tpPriceUsd, 0.0004803);
});

test("fase: una cancelada sin posiciones (prep_timeout) va directa a pausa: nadie la revisa y no tuvo reloj", () => {
  // Sin reviewed_at (cancelForPrepTimeout no la marca y pendingReviews no la incluye): no se puede quedar en «revisando».
  const prep = mission({ status: "cancelled", end_reason: "prep_timeout", ended_at: at(1) });
  const p = derivePhase(input({ mission: prep, hasPositions: false, revertedEntries: 2 }));
  assert.equal(p.id, "pausa");
  assert.equal(p.since, at(1));
  assert.equal(p.result?.reviewable, false);
  assert.equal(p.result?.resultPct, null);
  assert.equal(p.result?.revertedEntries, 2);
  assert.deepEqual(p.skipped, ["reloj", "revisando"], "ni reloj ni revisión: el panel no los marca como hechos");

  // Detenida a mano con el reloj en marcha y posiciones: sí se revisa, y tiene resultado.
  const stopped = mission({ status: "cancelled", end_reason: "user", started_at: at(8), ended_at: at(1), final_usd: 5 });
  const s = derivePhase(input({ mission: stopped, hasPositions: true }));
  assert.equal(s.id, "revisando");
  assert.equal(s.result?.reviewable, true);
  assert.equal(s.result?.resultPct, -90);
  assert.deepEqual(s.skipped, []);

  // Jugada hasta el final: revisando aunque no se sepa si tuvo posiciones.
  assert.equal(derivePhase(input({ mission: mission({ status: "expired", end_reason: "deadline", started_at: at(12), ended_at: at(1), final_usd: 40 }) })).id, "revisando");
});

test("nowState: una prep_timeout sin posiciones en la base de datos, con sus compras revertidas; con posición, se revisa", () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const ins = db.prepare(
    `INSERT INTO missions (created_at, requested_at, initial_usd, target_usd, deadline, status, mode, class, cost_mode, end_reason, ended_at, started_at, final_usd)
     VALUES (?, ?, 50, 62.5, ?, 'cancelled', 'sim', 'graduado-10m-+25%', 'sim', ?, ?, ?, ?)`,
  );
  const prep = Number(ins.run(iso(now - 3_700_000), iso(now - 3_700_000), iso(now - 3_100_000), "prep_timeout", iso(now - 100_000), null, null).lastInsertRowid);
  db.prepare("INSERT INTO entry_exclusions (mission_id, token, ts, reason) VALUES (?, ?, ?, 'revertida')").run(prep, "A", iso(now - 2_000_000));
  db.prepare("INSERT INTO entry_exclusions (mission_id, token, ts, reason) VALUES (?, ?, ?, 'revertida')").run(prep, "B", iso(now - 1_000_000));
  const m1 = db.prepare("SELECT * FROM missions WHERE id = ?").get(prep) as unknown as PhaseMission;
  const p1 = nowState({ mission: m1, sessions: [], valuation: null, valuedAt: null });
  assert.equal(p1.id, "pausa");
  assert.equal(p1.result?.revertedEntries, 2);
  assert.deepEqual(p1.skipped, ["reloj", "revisando"]);

  // Detenida a mano con el reloj en marcha: tiene posición, así que le toca retrospectiva.
  const user = Number(ins.run(iso(now - 900_000), iso(now - 900_000), iso(now - 300_000), "user", iso(now - 60_000), iso(now - 800_000), 5).lastInsertRowid);
  db.prepare("INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, status, qty_open, cost_open_usd) VALUES (?, 'solana', 'Mint9', 'JOKERINU', ?, 'closed', 0, 48.5)").run(user, iso(now - 790_000));
  const m2 = db.prepare("SELECT * FROM missions WHERE id = ?").get(user) as unknown as PhaseMission;
  const p2 = nowState({ mission: m2, sessions: [], valuation: null, valuedAt: null });
  assert.equal(p2.id, "revisando");
  assert.equal(p2.result?.resultPct, -90);

  // Su retrospectiva sin reviewed_at (heredada) también cuenta como revisada.
  db.prepare("INSERT INTO mission_reviews (mission_id, created_at, origin, what_was_tried, what_happened, next_time) VALUES (?, ?, 'legacy', 'x', 'y', 'z')").run(user, iso(now - 30_000));
  const p3 = nowState({ mission: m2, sessions: [], valuation: null, valuedAt: null });
  assert.equal(p3.id, "pausa");
  assert.equal(p3.result?.reviewedAt, iso(now - 30_000));
});
