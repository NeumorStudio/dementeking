import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { db, now } from "../src/db.js";
import { MIGRATIONS, runMigrations } from "../src/migrations.js";
import * as memory from "../src/sim/memory.js";
import { createMission } from "../src/sim/mission.js";
import { fingerprint, lessonRefs, similarity } from "../src/sim/text.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket } from "./fake-market.js";

installFakeMarket();

test("lee las referencias a lecciones de las tesis antiguas", () => {
  assert.deepEqual(lessonRefs("Lección 5: única entrada. Lección 4/estadísticas: no compré. Lección 3: margen."), [5, 4, 3]);
  assert.deepEqual(lessonRefs("Lecciones 5 y 6: token recién graduado. Lección 1: organicScore."), [5, 6, 1]);
  assert.deepEqual(lessonRefs("Primera misión, sin lecciones previas."), []);
  assert.deepEqual(lessonRefs("Lección propia de hoy: el stop saltó."), []);
});

test("huella de texto: detecta frases casi iguales", () => {
  const a = fingerprint("Los tokens recién graduados de pump.fun con mucho volumen suelen dar beneficio rápido");
  const b = fingerprint("Los tokens recien graduados en pump.fun con mucho volumen suelen dar un beneficio rápido");
  const c = fingerprint("Las órdenes condicionales se ejecutan a precio de liquidación");
  assert.ok(similarity(a, b) >= 0.6);
  assert.ok(similarity(a, c) < 0.2);
});

test("tipo de error: sin direcciones ni cifras", () => {
  assert.equal(
    memory.errorClass("Saldo insuficiente: tienes 12.5 USDC y quieres vender 20 de EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    "Saldo insuficiente: tienes N USDC y quieres vender N de <dirección>",
  );
});

test("migración: las lecciones pasan a creencias con el mismo id y las tesis las citan", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dementeking-mem-"));
  const legacy = new DatabaseSync(path.join(dir, "sim.db"));
  legacy.exec(`
    CREATE TABLE missions (id INTEGER PRIMARY KEY, status TEXT, reviewed_at TEXT);
    CREATE TABLE lessons (id INTEGER PRIMARY KEY, created_at TEXT, mission_id INTEGER, text TEXT, applies_to TEXT, evidence TEXT, confidence TEXT);
    CREATE TABLE positions (id INTEGER PRIMARY KEY, mission_id INTEGER, lessons_applied TEXT);
    INSERT INTO missions VALUES (1, 'expired', '2026-09-27T12:00:00Z'), (2, 'succeeded', NULL);
    INSERT INTO lessons VALUES (1, '2026-09-27T12:00:00Z', 1, 'No comprar tras un pump enorme con volumen de bots', 'misiones cortas', 'misión 1', 'media');
    INSERT INTO lessons VALUES (5, '2026-09-27T13:00:00Z', 1, 'Entrar en el retroceso de un recién graduado', NULL, NULL, NULL);
    INSERT INTO positions VALUES (1, 1, 'Primera misión, sin lecciones'), (2, 2, 'Lecciones 5 y 1; también la lección 9, que no existe');
  `);
  const steps = MIGRATIONS.filter((m) => m.version <= 2);
  runMigrations(legacy, dir, steps);
  assert.deepEqual(runMigrations(legacy, dir, steps), [], "una segunda vez no hace nada");

  const beliefs = legacy.prepare("SELECT id, statement, applies_to, origin, legacy_evidence FROM beliefs ORDER BY id").all() as any[];
  assert.deepEqual(beliefs.map((b) => b.id), [1, 5]);
  assert.equal(beliefs[0].origin, "migrated");
  assert.match(beliefs[0].legacy_evidence, /confianza que declaró el agente: media/);
  assert.equal(beliefs[1].applies_to, "(sin especificar)");
  const applied = legacy.prepare("SELECT id, beliefs_applied FROM positions ORDER BY id").all() as any[];
  assert.equal(applied[0].beliefs_applied, null);
  assert.equal(applied[1].beliefs_applied, "[5,1]");
  const reviews = legacy.prepare("SELECT mission_id, origin FROM mission_reviews").all() as any[];
  assert.deepEqual(reviews.map((r) => [r.mission_id, r.origin]), [[1, "legacy"]]);
  // La tabla de lecciones se conserva intacta.
  assert.equal((legacy.prepare("SELECT COUNT(*) AS n FROM lessons").get() as any).n, 2);
});

// Posiciones cerradas sintéticas para medir la evidencia.
const mission = await createMission(100, 200, 60, undefined, { solana: 100 });
let n = 0;
function closedPosition(entry: Record<string, unknown>, pnlPct: number, beliefs: number[] = []) {
  const cost = 10;
  db.prepare(
    `INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, closed_at, status, qty_open, cost_open_usd,
       realized_cost_usd, realized_proceeds_usd, entry_features, research, beliefs_applied)
     VALUES (?, 'solana', ?, 'T', ?, ?, 'closed', 0, 0, ?, ?, ?, '{}', ?)`,
  ).run(mission.id, `tok${++n}`, now(), now(), cost, cost * (1 + pnlPct / 100), JSON.stringify({ venue: "solana", ...entry }), JSON.stringify(beliefs));
}

test("creencia con condición: el simulador la contrasta con todas las operaciones", () => {
  closedPosition({ ageMinutes: 5 }, -40);
  closedPosition({ ageMinutes: 10 }, -20);
  closedPosition({ ageMinutes: 12 }, 30);
  closedPosition({ ageMinutes: 90 }, 15);
  closedPosition({}, -50); // edad desconocida: no cuenta
  const b = memory.writeBelief({
    statement: "Comprar tokens con menos de 30 minutos de vida suele salir mal",
    appliesTo: "memecoins de Solana",
    expectation: "negative",
    condition: { all: [{ f: "ageMinutes", op: "<", v: 30 }] },
    missionId: mission.id,
  });
  assert.deepEqual(
    { trades: b.evidence.matchingTrades!.trades, inFavor: b.evidence.matchingTrades!.inFavor, against: b.evidence.matchingTrades!.against },
    { trades: 3, inFavor: 2, against: 1 },
  );
  // 2 a favor y 1 en contra: con tan pocos casos no se puede concluir nada (intervalo de Wilson).
  assert.ok(b.evidence.verdict.includes("sin confirmar (2 a favor, 1 en contra; acierto 67 %, intervalo 21-94 %) · hipótesis"), b.evidence.verdict);
  // También cuánto se movieron: media, mejor y cuántas dieron +20 % o más.
  assert.match(b.evidence.verdict, /mejor 30 %, 1 de 3 con \+20 % o más/);
});

test("creencia sin condición: cuenta el resultado de las operaciones que la aplicaron", () => {
  const b = memory.writeBelief({ statement: "Vender la mitad cuando un token se gradúa y salta", appliesTo: "misiones de 1 h", missionId: mission.id });
  const id = memory.activeBeliefIds().at(-1)!;
  closedPosition({}, 25, [id]);
  closedPosition({}, -5, [id]);
  assert.equal(b.evidence.appliedIn.trades, 0);
  const again = memory.recall(mission.id).beliefs.find((x) => x.id === id)!;
  assert.deepEqual([again.evidence.appliedIn.trades, again.evidence.appliedIn.wins, again.evidence.appliedIn.losses], [2, 1, 1]);
});

test("duplicados: no se guardan dos veces", () => {
  assert.throws(
    () => memory.writeBelief({ statement: "Comprar tokens con menos de 30 minutos de vida suele salir mal casi siempre", appliesTo: "x", missionId: null }),
    /casi igual/,
  );
  assert.throws(
    () =>
      memory.writeBelief({
        statement: "Otra forma de decirlo",
        appliesTo: "x",
        expectation: "negative",
        condition: { all: [{ f: "ageMinutes", op: "<", v: 30 }] },
        missionId: null,
      }),
    /misma condición/,
  );
  const id = memory.writeHowto({ scope: "solana", topic: "órdenes", title: "Margen en las órdenes de venta", steps: "Cotizar la venta antes y dejar un 5 % de margen", missionId: null });
  assert.throws(() => memory.writeHowto({ scope: "solana", topic: "órdenes", title: "Margen en órdenes de venta", steps: "Cotizar la venta antes y dejar 5 % de margen", missionId: null }), new RegExp(`#${id}`));
});

test("una creencia retirada deja de estar activa y no se puede citar", async () => {
  const id = memory.activeBeliefIds()[0]!;
  memory.reviseBelief({ id, retire: true, reason: "los datos la contradicen" });
  assert.ok(!memory.activeBeliefIds().includes(id));
  assert.deepEqual(memory.unknownBeliefs([id]), [id]);
});

test("el briefing del revisor llega una sola vez al agente, en su siguiente acción", async () => {
  memory.writeBriefing(mission.id, "Ten presente el howto #1.");
  const ctx = { sessionId: 1, missionId: mission.id };
  // mission_status no se la queda: también la usa la sesión del usuario para ver si la misión sigue.
  assert.doesNotMatch(String((await runTool("mission_status", {}, ctx)).content), /El revisor ha actualizado/);
  const first = await runTool("portfolio", {}, ctx);
  assert.match(String(first.content), /El revisor ha actualizado tu briefing[\s\S]*howto #1/);
  const second = await runTool("portfolio", {}, ctx);
  assert.doesNotMatch(String(second.content), /El revisor ha actualizado/);
});

test("los errores de herramientas se guardan agrupados por tipo", async () => {
  const ctx = { sessionId: 1, missionId: mission.id };
  await runTool("cancel_order", { id: 999 }, ctx);
  await runTool("cancel_order", { id: 998 }, ctx);
  const errs = memory.recurringErrors() as Array<{ tool: string; count: number }>;
  assert.equal(errs.find((e) => e.tool === "cancel_order")?.count, 2);
});

test("las peticiones de capacidades parecidas se agrupan", () => {
  const a = memory.requestCapability({ source: "trader", missionId: mission.id, category: "cuenta", capability: "Cuenta de X para publicar", why: "a", plan: "b" });
  const b = memory.requestCapability({ source: "trader", missionId: mission.id, category: "cuenta", capability: "cuenta de X para publicar", why: "c", plan: "d" });
  assert.equal(b.id, a.id);
  assert.equal(b.duplicate, true);
  const open = memory.listCapabilityRequests();
  assert.equal(open.find((r) => r.id === a.id)?.times_requested, 2);
  memory.resolveCapabilityRequest(a.id, "rejected", "de momento no");
  assert.equal(memory.listCapabilityRequests().length, 0);
});

test("cada cambio en la memoria queda visible en el panel (también las correcciones)", () => {
  const titles = memory.recentLearning(20).map((l) => l.title);
  assert.ok(titles.some((t) => t.startsWith("Nueva creencia")));
  assert.ok(titles.some((t) => t.startsWith("Retira la creencia")));
  assert.ok(titles.some((t) => t.startsWith("Nuevo howto")));
});

test("cola del revisor y retrospectiva", () => {
  const q = memory.reviewQueue();
  assert.equal((q.activeMission as { missionId: number }).missionId, mission.id);
  assert.throws(() => memory.writeMissionReview({ missionId: mission.id, whatWasTried: "a", whatHappened: "b", nextTime: "c" }), /sigue activa/);
  db.prepare("UPDATE missions SET status = 'expired', final_usd = 90, ended_at = ? WHERE id = ?").run(now(), mission.id);
  assert.deepEqual(memory.pendingReviews(), [mission.id]);
  const stats = memory.writeMissionReview({ missionId: mission.id, whatWasTried: "a", whatHappened: "b", nextTime: "c" });
  assert.equal(stats.result.pct, -10);
  assert.deepEqual(memory.pendingReviews(), []);
  // El revisor ve cómo jugó el trader en sus últimas misiones, para detectar si está estancado.
  const approach = memory.recentApproach()!;
  assert.equal(approach.summary.missions, 1);
  assert.equal(approach.perMission[0]!.resultPct, -10);
  assert.equal(approach.perMission[0]!.venues, "solana");
  assert.equal(approach.summary.succeeded, "0 de 1");
  assert.equal(approach.summary.successStreak, 0);
});
