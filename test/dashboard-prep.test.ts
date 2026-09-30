// Misión recién creada, antes del reloj, con el cerebro escribiendo el plan (lo que se vio en directo con la #27): el panel
// enseña la misión nueva (su capital, su meta, «sin arrancar», la pista vacía), nunca el resultado de la anterior, y la
// fase es «plan» con el cerebro trabajando, no «esperando señal» con el plan viejo.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installFakeMarket } from "./fake-market.js";

const home = mkdtempSync(path.join(os.tmpdir(), "dementeking-claude-"));
process.env.CLAUDE_CONFIG_DIR = home;
delete process.env.CRYPTOAGENT_HOST;
const project = path.join(home, "projects", "C--tf-tmp-dk-run");
mkdirSync(project, { recursive: true });
installFakeMarket();

const { db } = await import("../src/db.js");
const { heroModel } = await import("../src/dashboard/hero.js");
const { startDashboard, stopDashboard } = await import("../src/dashboard/server.js");

const NOW = Date.now();
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

test("carrera: sin reloj, la misión enseña su punto de partida; en carrera y terminada, su valor (y nunca el de otra misión)", () => {
  const m27 = { id: 27, status: "active", started_at: null, initial_usd: 50, target_usd: 62.5, final_usd: null };
  // La valoración en caché es de la misión anterior (la #26, que acabó en 62,57 $): no vale para esta.
  const prev = { missionId: 26, totalUsd: 62.57, benchmarkUsd: 49.9 };
  const prep = heroModel(m27, prev);
  assert.equal(prep.mode, "prep");
  assert.equal(prep.valueUsd, 50, "la cifra grande es su capital inicial");
  assert.equal(prep.deltaPct, null, "sin resultado: «sin arrancar»");
  assert.equal(prep.runnerUsd, 50, "el corredor, en la salida");
  assert.equal(prep.benchmarkUsd, null, "sin fantasma");
  assert.equal(prep.toGoUsd, 12.5);
  // Ni con una valoración suya de antes del reloj (el panel valora cada 30 s): antes de la salida no hay carrera.
  assert.equal(heroModel(m27, { missionId: 27, totalUsd: 49.2 }).valueUsd, 50);

  // Reloj en marcha: su valoración; si todavía es la de la otra misión, «valorando» (sin cifra de nadie).
  const live = { ...m27, started_at: iso(60) };
  assert.deepEqual(
    [heroModel(live, { missionId: 27, totalUsd: 55, benchmarkUsd: 49.9 })].map((h) => [h.mode, h.valueUsd, h.deltaPct, h.toGoUsd, h.benchmarkUsd]),
    [["live", 55, 10, 7.5, 49.9]],
  );
  const valuing = heroModel(live, prev);
  assert.equal(valuing.mode, "valuing");
  assert.equal(valuing.valueUsd, null);
  assert.equal(valuing.runnerUsd, 50);

  // Terminada: su valor final, sin fantasma.
  const done = heroModel({ ...live, status: "succeeded", final_usd: 62.57 }, prev);
  assert.equal(done.mode, "ended");
  assert.equal(done.valueUsd, 62.57);
  assert.ok(Math.abs(done.deltaPct! - 25.14) < 1e-9);
  assert.equal(done.toGoUsd, 0);
  assert.equal(done.benchmarkUsd, null);
});

test("panel: la #27 recién creada con el cerebro escribiendo sale como «plan» con su propia carrera, no con la de la #26", async () => {
  // La #26: conseguida, 62,57 $. La #27: pedida hace 70 s, sin reloj, con el plan #1 vigente de su clase.
  const cls = "graduado-10m-+25%";
  db.prepare("INSERT INTO plans (created_at, class, body, predicted_p, baseline_p, active) VALUES (?, ?, '{}', 0.4, 0.35, 1)").run(iso(36_000), cls);
  const ins = db.prepare(
    `INSERT INTO missions (created_at, requested_at, initial_usd, target_usd, deadline, status, mode, class, cost_mode, plan_id, started_at, ended_at, final_usd, end_reason, reviewed_at)
     VALUES (?, ?, 50, 62.5, ?, ?, 'sim', ?, 'sim', 1, ?, ?, ?, ?, ?)`,
  );
  ins.run(iso(8000), iso(8600), iso(7400), "succeeded", cls, iso(8000), iso(7700), 62.57, "target", iso(7650));
  const m27 = Number(ins.run(iso(70), iso(70), iso(70 - 600), "active", cls, null, null, null, null, null).lastInsertRowid);
  db.prepare("INSERT INTO snapshots (ts, mission_id, total_usd, benchmark_usd) VALUES (?, ?, 50, 50)").run(iso(30), m27);

  // El cerebro, lanzado a los 7 s por `claude -p "Prepara el plan." --agent dementeking:planner`: su transcripción es el
  // hilo principal de su sesión y sigue creciendo (sin cost-state).
  writeFileSync(
    path.join(project, "planner-27.jsonl"),
    [
      { type: "agent-setting", agentSetting: "dementeking:planner", sessionId: "planner-27" },
      { type: "queue-operation", operation: "enqueue", timestamp: iso(63), sessionId: "planner-27", content: "Prepara el plan." },
      { type: "user", uuid: "u1", timestamp: iso(61), sessionId: "planner-27", message: { role: "user", content: "Prepara el plan." } },
      { type: "assistant", uuid: "u2", timestamp: iso(20), message: { content: [{ type: "text", text: "Repaso el bloque del plan #1." }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );

  const port = 4392;
  const { url } = await startDashboard({ port, log: () => undefined });
  try {
    const s = (await (await fetch(`${url}/api/state`)).json()) as {
      mission: { id: number };
      hero: { missionId: number; mode: string; valueUsd: number; deltaPct: number | null; runnerUsd: number };
      phase: { id: string; planStep?: string; agent: { name: string; since: string } | null; since: string; planId: number | null; classPlanId?: number };
    };
    assert.equal(s.mission.id, m27);
    assert.deepEqual(
      [s.hero.missionId, s.hero.mode, s.hero.valueUsd, s.hero.deltaPct, s.hero.runnerUsd],
      [m27, "prep", 50, null, 50],
      "la carrera es la de la #27, sin arrancar",
    );
    assert.equal(s.phase.id, "esperando-plan");
    assert.equal(s.phase.planStep, "escribiendo");
    assert.equal(s.phase.agent?.name, "planner", "trabaja el cerebro");
    assert.equal(s.phase.since, iso(63), "desde que empezó el cerebro");
    assert.equal(s.phase.planId, null);
    assert.equal(s.phase.classPlanId, 1);
  } finally {
    await stopDashboard({ port });
  }
});
