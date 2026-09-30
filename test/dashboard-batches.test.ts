// «Las tandas» del panel: las misiones rápidas por serie (clase y costes) y plan, con su resultado acumulado, aciertos
// con intervalo de Wilson, hundidas y el gemelo (con velas si la base de datos las tiene, si no con cotizaciones).
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.js";
import { aggregateBatches, columnsOf, forgetColumns, loadBatches, loadFastMissions, type FastMissionRow } from "../src/dashboard/batches.js";
import { wilson } from "../src/sim/stats.js";

let nextId = 1;
const row = (over: Partial<FastMissionRow> = {}): FastMissionRow => ({
  id: nextId++,
  status: "succeeded",
  end_reason: "target",
  class: "graduado-10m-+25%",
  cost_mode: "sim",
  plan_id: 1,
  requested_at: "2026-09-30T10:00:00.000Z",
  started_at: "2026-09-30T10:06:00.000Z",
  ended_at: "2026-09-30T10:12:00.000Z",
  entry_latency_s: 6.5,
  initial_usd: 50,
  final_usd: 62.5,
  predicted_p: 0.37,
  symbol: "TOK",
  twin: null,
  ...over,
});

test("tandas: una serie por modo de costes, el acumulado misión a misión y las fronteras de plan", () => {
  nextId = 1;
  const rows = [
    row({ twin: { hits: 1, done: 2, measure: "cotizaciones", running: false } }), // +12,5
    row({ status: "bust", end_reason: "bust", final_usd: 2, twin: { hits: 0, done: 2, measure: "cotizaciones", running: false } }), // −48 (hundida)
    row({ cost_mode: "real", final_usd: 63 }), // serie real
    row({ status: "expired", end_reason: "deadline", final_usd: 40, plan_id: 2, predicted_p: 0.4, twin: { hits: 1, done: 1, measure: "velas", running: false } }), // −10, plan 2
    row({ status: "cancelled", end_reason: "prep_timeout", started_at: null, final_usd: 50 }), // no cuenta
    row({ status: "active", end_reason: null, started_at: null, ended_at: null, final_usd: null, plan_id: 2 }), // en marcha
    row({ plan_id: 2, predicted_p: 0.4, final_usd: 62.6 }), // +12,6
  ];
  const b = aggregateBatches([...rows].reverse()); // el orden de entrada no importa
  assert.deepEqual(b.series.map((s) => s.costMode), ["sim", "real"]);
  const sim = b.series[0]!;
  assert.equal(sim.missions, 4, "las canceladas y la activa no cuentan");
  assert.equal(sim.cancelled, 1);
  assert.equal(sim.inProgress, 1);
  assert.equal(sim.hits, 2);
  assert.deepEqual(sim.ci95, [wilson(2, 4).low, wilson(2, 4).high]);
  assert.deepEqual(sim.points.map((p) => p.cumUsd), [12.5, -35.5, -45.5, -32.9]);
  assert.deepEqual(sim.points.map((p) => p.n), [1, 2, 3, 4]);
  assert.equal(sim.crashes, 1, "acabar por debajo del −50 %");
  assert.equal(sim.points[1]!.crash, true);
  assert.equal(sim.totalPnlUsd, -32.9);
  assert.ok(Math.abs(sim.avgPnlUsd - -8.225) <= 0.005);
  // Frontera: la tercera misión jugada de la serie es la primera del plan 2.
  assert.deepEqual(sim.planBoundaries, [{ n: 1, planId: 1 }, { n: 3, planId: 2 }]);
  assert.deepEqual(sim.plans.map((p) => [p.planId, p.fromN, p.toN, p.missions, p.hits, p.predictedPct]), [
    [1, 1, 2, 2, 1, 37],
    [2, 3, 4, 2, 1, 40],
  ]);
  // Gemelo: media por misión de aciertos/terminados (0,5, 0 y 1 → 50 %), n = misiones; las dos medidas, dichas.
  assert.equal(sim.twin?.missions, 3);
  assert.equal(sim.twin?.meanRatePct, 50);
  assert.equal(sim.twin?.hits, 2);
  assert.equal(sim.twin?.twins, 5);
  assert.equal(sim.twin?.measure, "velas y cotizaciones");
  assert.equal(sim.twin?.agentHits, 1);
  assert.deepEqual(sim.twin?.ci95, [wilson(1.5, 3).low, wilson(1.5, 3).high]);

  const real = b.series[1]!;
  assert.equal(real.missions, 1);
  assert.equal(real.totalPnlUsd, 13);
  assert.equal(real.twin, null);

  // La tabla, de la más reciente a la más antigua; las no jugadas, sin resultado.
  assert.deepEqual(b.missions.map((m) => m.id), [7, 6, 5, 4, 3, 2, 1]);
  const cancelled = b.missions.find((m) => m.id === 5)!;
  assert.equal(cancelled.resultPct, null);
  assert.equal(cancelled.prepMinutes, null);
  assert.equal(b.missions.find((m) => m.id === 1)!.prepMinutes, 6);
  assert.equal(b.missions.find((m) => m.id === 2)!.resultPct, -96);
});

test("tandas: sin misiones rápidas, vacío", () => {
  assert.deepEqual(aggregateBatches([]), { series: [], missions: [] });
});

test("tandas desde la base de datos: token, gemelo con velas y, si faltan las columnas de velas, con cotizaciones", () => {
  const ins = db.prepare(
    `INSERT INTO missions (created_at, requested_at, initial_usd, target_usd, deadline, status, mode, class, cost_mode, plan_id, started_at, ended_at, final_usd, end_reason, entry_latency_s)
     VALUES (?, ?, 50, 62.5, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 6.4)`,
  );
  const t0 = Date.parse("2026-09-30T10:00:00.000Z");
  const iso = (m: number) => new Date(t0 + m * 60_000).toISOString();
  // Una rápida conseguida, una larga (no sale) y una real de 10 min (tampoco: una real nunca es rápida).
  const fast = Number(ins.run(iso(6), iso(0), iso(16), "succeeded", "sim", "graduado-10m-+25%", "sim", iso(6), iso(11), 62.57, "target").lastInsertRowid);
  ins.run(iso(0), iso(0), iso(24 * 60), "expired", "sim", "libre-1440m-+10%", "sim", iso(0), iso(24 * 60), 51, "deadline");
  ins.run(iso(0), iso(0), iso(10), "succeeded", "live", "libre-10m-+25%", "sim", iso(0), iso(8), 62.6, "target");
  db.prepare("INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, status, qty_open, cost_open_usd) VALUES (?, 'solana', 'So1', 'SOL', ?, 'open', 0.01, 1.5)").run(fast, iso(6));
  db.prepare("INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, status, qty_open, cost_open_usd) VALUES (?, 'solana', 'Mint1', 'Fomo Cat', ?, 'closed', 0, 48.5)").run(fast, iso(6));
  db.prepare(
    "INSERT INTO shadow_runs (mission_id, started_at, detect_until, horizon_minutes, source, size_usd, tp_usd, tp_basis, target_count, status) VALUES (?, ?, ?, 10, 'graduado', 48.5, 61.1, 'x', 3, 'done')",
  ).run(fast, iso(6), iso(16));
  const twin = db.prepare(
    "INSERT INTO shadow_positions (mission_id, token, opened_at, expires_at, usd_in, tokens_raw, decimals, entry_value_usd, status, candle_status, candle_hit_wick) VALUES (?, ?, ?, ?, 48.5, '1', 6, 48, ?, ?, ?)",
  );
  twin.run(fast, "A", iso(7), iso(17), "hit", "done", 1);
  twin.run(fast, "B", iso(8), iso(18), "expired", "done", 1); // con cotizaciones no llegó; con velas (mecha), sí
  twin.run(fast, "C", iso(9), iso(19), "expired", null, null); // pendiente de velas

  const rows = loadFastMissions();
  assert.deepEqual(rows.map((r) => r.id), [fast]);
  assert.equal(rows[0]!.symbol, "Fomo Cat", "la compra que no es SOL ni un estable");
  assert.deepEqual(rows[0]!.twin, { hits: 2, done: 2, measure: "velas", running: false });
  const b = loadBatches();
  assert.equal(b.series[0]!.missions, 1);
  assert.equal(b.series[0]!.twin?.measure, "velas");

  // Una base de datos anterior a v0.37.2: sin columnas de velas ni entradas medidas. El panel sigue, con cotizaciones.
  db.exec("ALTER TABLE shadow_positions DROP COLUMN candle_hit_wick; ALTER TABLE shadow_positions DROP COLUMN candle_status; DROP TABLE agent_entries");
  forgetColumns();
  assert.equal(columnsOf("shadow_positions").has("candle_status"), false);
  assert.deepEqual(loadFastMissions()[0]!.twin, { hits: 1, done: 3, measure: "cotizaciones", running: false });
  assert.equal(loadFastMissions()[0]!.symbol, "Fomo Cat");
});

test("tandas: las detenidas con el reloj en marcha van aparte (con su resultado), no como «canceladas sin reloj»", () => {
  nextId = 100;
  const b = aggregateBatches([
    row({ final_usd: 62.6 }), // +12,6
    row({ status: "cancelled", end_reason: "user", final_usd: 5 }), // parada a mano con reloj: −45
    row({ status: "cancelled", end_reason: "replaced", final_usd: null }), // sustituida con reloj: sin cartera final
    row({ status: "cancelled", end_reason: "prep_timeout", started_at: null, final_usd: null, reverted_entries: 2 }), // sin reloj
  ]);
  const s = b.series[0]!;
  assert.equal(s.cancelled, 1, "solo la que no arrancó el reloj");
  assert.equal(s.stopped, 2);
  assert.equal(s.stoppedPnlUsd, -45, "lo que perdió la parada a mano; la sustituida no tiene cartera final");
  assert.equal(s.missions, 1, "las detenidas no son una jugada completa: fuera de los aciertos");
  assert.equal(s.totalPnlUsd, 12.6, "y fuera del acumulado (la tarjeta lo dice)");
  const byId = new Map(b.missions.map((m) => [m.id, m]));
  assert.equal(byId.get(101)!.resultPct, -90, "en la tabla, con su resultado");
  assert.equal(byId.get(101)!.pnlUsd, -45);
  assert.equal(byId.get(102)!.resultPct, null);
  assert.equal(byId.get(103)!.resultPct, null);
  assert.equal(byId.get(103)!.revertedEntries, 2);
  // Sin detenidas, sin cifra.
  assert.equal(aggregateBatches([row()]).series[0]!.stoppedPnlUsd, null);
});
