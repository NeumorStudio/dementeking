// Reloj de la misión: el plazo cuenta desde que arranca (no desde que se crea), antes no se puede operar ni
// saltan órdenes, una misión sin arrancar se cancela a los 60 min, y las misiones rápidas se vigilan cada 5 s.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import { db, logJournal, now } from "../src/db.js";
import { USDC_MINT } from "../src/market/jupiter.js";
import { MIGRATIONS, runMigrations } from "../src/migrations.js";
import {
  checkMission,
  createMission,
  getMission,
  isFastMission, isShortMission,
  missionClass,
  missionStatus,
  PREP_TIMEOUT_MINUTES,
  startMissionClock,
  stopMission,
} from "../src/sim/mission.js";
import { checkOrders } from "../src/sim/orders.js";
import { getHoldings } from "../src/sim/portfolio.js";
import { currentWatchState, dueWatchWork, waitTiming, watchIntervals } from "../src/sim/watch.js";
import { CLOCK_NOT_STARTED, runTool, SIM_TOOLS } from "../src/tools/index.js";
import { installFakeMarket, MEME, setPrice } from "./fake-market.js";

installFakeMarket();

const iso = (ms: number) => new Date(ms).toISOString();
const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck" };
/** Simula que la misión se creó hace `minutes` sin arrancar el reloj (conserva la duración). */
function createdAgo(id: number, minutes: number) {
  const m = getMission(id)!;
  const duration = new Date(m.deadline).getTime() - new Date(m.created_at).getTime();
  const created = Date.now() - minutes * 60_000;
  db.prepare("UPDATE missions SET created_at = ?, deadline = ? WHERE id = ?").run(iso(created), iso(created + duration), id);
}

test("clase de misión y cuándo es rápida", () => {
  assert.equal(missionClass({ durationMinutes: 10, initialUsd: 50, targetUsd: 62.5 }), "graduado-10m-+25%");
  assert.equal(missionClass({ durationMinutes: 5, initialUsd: 50, targetUsd: 100 }), "graduado-5m-+100%");
  assert.equal(missionClass({ durationMinutes: 60, initialUsd: 1000, targetUsd: 1100 }), "libre-60m-+10%");
  assert.equal(missionClass({ durationMinutes: 10, initialUsd: 50, targetUsd: 62.5, market: "momentum" }), "momentum-10m-+25%");
  const at = (minutes: number, mode = "sim") => ({ created_at: iso(0), deadline: iso(minutes * 60_000), mode });
  assert.equal(isFastMission(at(15)), true);
  assert.equal(isFastMission(at(16)), false);
  // Una real nunca es rápida (el flujo del executor solo existe en simulación), aunque sea corta: su clase es libre.
  assert.equal(isFastMission(at(15, "live")), false);
  assert.equal(isShortMission(at(15, "live")), true, "pero se vigila al ritmo de una corta");
  assert.equal(missionClass({ durationMinutes: 15, initialUsd: 50, targetUsd: 55, live: true }), "libre-15m-+10%");
});

test("la espera antes del reloj no mata la misión: el plazo cuenta desde que arranca", async () => {
  const m = await createMission(50, 62.5, 5, undefined, { solana: 100 });
  assert.equal(m.class, "graduado-5m-+25%");
  // Creada hace 6 min sin start_session: con el plazo desde la creación ya habría caducado.
  createdAgo(m.id, 6);
  assert.deepEqual(await checkMission(m.id), []);
  assert.equal(getMission(m.id)!.status, "active");

  const s = (await missionStatus(m.id)) as Record<string, unknown>;
  assert.equal(s.deadline, undefined, "sin reloj no hay plazo");
  assert.match(String(s.clock), /sin arrancar: los 5 min empiezan a contar con start_session/);
  assert.equal(s.secondsLeft, 300, "le queda la duración entera");
  assert.equal(s.warning, undefined, "esperar antes del reloj no es estar parado");

  assert.equal(startMissionClock(m.id), true);
  const started = getMission(m.id)!;
  const left = new Date(started.deadline).getTime() - Date.now();
  assert.ok(left > 5 * 60_000 - 2_000 && left <= 5 * 60_000, `deadline = ahora + 5 min (quedan ${left} ms)`);
  assert.equal(startMissionClock(m.id), false, "solo arranca una vez");
});

test("sin arrancar el reloj en 60 min, la misión se cancela (prep_timeout) sin resultado", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  createdAgo(m.id, PREP_TIMEOUT_MINUTES - 1);
  await checkMission(m.id);
  assert.equal(getMission(m.id)!.status, "active", "a los 59 min sigue esperando");

  createdAgo(m.id, PREP_TIMEOUT_MINUTES + 1);
  const log = await checkMission(m.id);
  assert.match(log.join("\n"), /prep_timeout/);
  const after = getMission(m.id)!;
  assert.equal(after.status, "cancelled");
  assert.equal(after.end_reason, "prep_timeout");
  assert.equal(after.final_usd, null, "no llegó a jugarse");
  assert.equal(startMissionClock(m.id), false, "ya no se puede arrancar");
});

test("con el reloj en marcha el plazo sí vence, y cada cierre guarda su motivo", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(m.id);
  db.prepare("UPDATE missions SET created_at = ?, deadline = ? WHERE id = ?").run(iso(Date.now() - 11 * 60_000), iso(Date.now() - 60_000), m.id);
  await checkMission(m.id);
  assert.equal(getMission(m.id)!.status, "expired");
  assert.equal(getMission(m.id)!.end_reason, "deadline");

  const a = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  await createMission(50, 62.5, 10, undefined, { solana: 100 });
  assert.equal(getMission(a.id)!.end_reason, "replaced");
  const b = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  await stopMission(false, b.id);
  assert.equal(getMission(b.id)!.end_reason, "user");
});

test("antes del reloj no se puede operar: swaps, órdenes y futuros se rechazan", async () => {
  setPrice(MEME, 1);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const ctx = { sessionId: 1, missionId: m.id };
  const before = JSON.stringify(getHoldings(m.id));
  const calls: Array<[string, Record<string, unknown>]> = [
    ["simulate_swap", { chain: "solana", input: "USDC", output: MEME, amount: 20, slippage_bps: 300, thesis }],
    ["execute_swap", { chain: "solana", input: "USDC", output: MEME, amount: 20, slippage_bps: 300, thesis }],
    ["place_swap_trigger_order", { chain: "solana", condition: "time", in_minutes: 1, input: "USDC", output: MEME, amount: 5, thesis }],
    ["open_perp", { coin: "BTC", side: "long", leverage: 10, margin_usd: 20, thesis }],
  ];
  for (const [name, input] of calls) {
    const r = await runTool(name, input, ctx);
    assert.equal(r.isError, true, name);
    assert.equal(r.content, `Error: ${CLOCK_NOT_STARTED}`, name);
  }
  assert.equal(JSON.stringify(getHoldings(m.id)), before, "la cartera no se ha tocado");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM orders WHERE mission_id = ?").get(m.id) as { n: number }).n, 0);
  // Mirar sí se puede: preparar antes del reloj es legítimo.
  assert.equal((await runTool("mission_status", {}, ctx)).isError, false);

  startMissionClock(m.id);
  const r = await runTool("simulate_swap", { chain: "solana", input: "USDC", output: MEME, amount: 20, slippage_bps: 300, thesis }, ctx);
  assert.ok(!r.isError, String(r.content));
});

test("las órdenes de una misión sin reloj no se vigilan", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  // Una orden por tiempo ya vencida, como la habría dejado una versión anterior antes del reloj.
  const id = Number(
    db
      .prepare(
        `INSERT INTO orders (created_at, mission_id, session_id, venue, trigger_asset, trigger_label, condition, trigger_price, action, reasoning, expires_at)
         VALUES (?, ?, NULL, 'solana', 'time', 'hora', 'time', ?, ?, 'antes del reloj', NULL)`,
      )
      .run(now(), m.id, Date.now() - 1_000, JSON.stringify({ input: USDC_MINT, output: MEME, amount: 5, slippageBps: 100 })).lastInsertRowid,
  );
  const status = () => (db.prepare("SELECT status FROM orders WHERE id = ?").get(id) as { status: string }).status;
  await checkOrders();
  assert.equal(status(), "open");
  startMissionClock(m.id);
  await checkOrders();
  assert.equal(status(), "filled");
});

test("una herramienta con startsClock arranca el reloj ella misma y opera en la sesión nueva", async () => {
  const run = async (_i: unknown, c: { sessionId: number }) => `sesión ${c.sessionId}`;
  const tools = [
    { name: "entrar", kind: "trade", startsClock: true, description: "", schema: z.object({}), run },
    { name: "comprar", kind: "trade", description: "", schema: z.object({}), run },
  ];
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const ctx = {
    sessionId: 1,
    missionId: m.id,
    startClock: async () => {
      startMissionClock(m.id);
      return 99;
    },
  };
  assert.equal((await runTool("comprar", {}, ctx, tools)).content, `Error: ${CLOCK_NOT_STARTED}`);
  assert.equal(getMission(m.id)!.started_at, null);
  const r = await runTool("entrar", {}, ctx, tools);
  assert.deepEqual(r, { content: "sesión 99", isError: false });
  assert.ok(getMission(m.id)!.started_at, "el reloj ya corre");
  assert.equal((await runTool("comprar", {}, ctx, tools)).content, "sesión 1", "y ya se puede operar");

  // Sin ctx.startClock (runner por API), arranca solo el reloj.
  const m2 = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  assert.deepEqual(await runTool("entrar", {}, { sessionId: 7, missionId: m2.id }, tools), { content: "sesión 7", isError: false });
  assert.ok(getMission(m2.id)!.started_at);
});

test("vigilancia: todo cada 5 s en una misión rápida; si no, cada minuto y las órdenes por precio cada 15 s", async () => {
  const base = { full: 60, fast: 5 };
  assert.deepEqual(watchIntervals({ fastMission: true, priceOrders: false }, base), { fullSeconds: 5, ordersSeconds: 5 });
  assert.deepEqual(watchIntervals({ fastMission: false, priceOrders: true }, base), { fullSeconds: 60, ordersSeconds: 15 });
  assert.deepEqual(watchIntervals({ fastMission: false, priceOrders: false }, base), { fullSeconds: 60, ordersSeconds: 60 });

  const t = 1_000_000;
  const due = (fastMission: boolean, priceOrders: boolean, fullAgo: number, ordersAgo: number) =>
    dueWatchWork({ fastMission, priceOrders, nowMs: t, lastFullMs: t - fullAgo, lastOrdersMs: t - ordersAgo }, base);
  assert.equal(due(true, false, 5_000, 5_000), "full");
  assert.equal(due(true, false, 2_000, 2_000), null);
  assert.equal(due(false, true, 20_000, 16_000), "orders");
  assert.equal(due(false, true, 20_000, 5_000), null);
  assert.equal(due(false, true, 61_000, 5_000), "full");
  assert.equal(due(false, false, 30_000, 30_000), null);
  assert.equal(due(false, false, 60_000, 60_000), "full");

  // Qué se ve en la base de datos: solo cuenta una misión rápida con el reloj en marcha.
  const fast = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  assert.equal(currentWatchState().fastMission, false, "sin reloj, nada que vigilar deprisa");
  startMissionClock(fast.id);
  assert.equal(currentWatchState().fastMission, true);
  const slow = await createMission(1000, 1100, 60, undefined, { solana: 100 });
  startMissionClock(slow.id);
  assert.equal(currentWatchState().fastMission, false);
});

test("wait: desde 15 s y mirando cada 5 s en una misión rápida; desde 1 min y cada 20 s en una larga", async () => {
  const schema = SIM_TOOLS.find((t) => t.name === "wait")!.schema;
  assert.equal(schema.safeParse({ minutes: 0.25 }).success, true);
  assert.equal(schema.safeParse({ minutes: 0.2 }).success, false);
  assert.deepEqual(waitTiming(0.25, true), { minutes: 0.25, pollMs: 5_000 });
  assert.deepEqual(waitTiming(0.25, false), { minutes: 1, pollMs: 20_000 });
  assert.deepEqual(waitTiming(3, false), { minutes: 3, pollMs: 20_000 });

  // De verdad: una novedad al segundo de empezar despierta la espera en el sondeo siguiente (5 s), no a los 20.
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(m.id);
  const t0 = Date.now();
  setTimeout(() => logJournal({ missionId: m.id, sessionId: null, kind: "note", summary: "algo pasa" }), 1_000);
  const r = await runTool("wait", { minutes: 1 }, { sessionId: 1, missionId: m.id });
  assert.ok(!r.isError, String(r.content));
  assert.match(String(r.content), /hay novedades/);
  assert.ok(Date.now() - t0 < 12_000, `volvió a los ${Date.now() - t0} ms`);
});

test("migración 10: columnas nuevas y clase para las misiones que ya existían", () => {
  const cols = (db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["class", "predicted_p", "baseline_p", "plan_id", "shadow_hits", "shadow_return", "end_reason"]) assert.ok(cols.includes(c), c);

  const dir = mkdtempSync(path.join(os.tmpdir(), "dementeking-mig10-"));
  const conn = new DatabaseSync(path.join(dir, "sim.db"));
  conn.exec("CREATE TABLE missions (id INTEGER PRIMARY KEY, created_at TEXT, deadline TEXT, initial_usd REAL, target_usd REAL, mode TEXT NOT NULL DEFAULT 'sim')");
  conn
    .prepare("INSERT INTO missions VALUES (1, ?, ?, 50, 62.5, 'sim'), (2, ?, ?, 1000, 1100, 'sim'), (3, ?, ?, 80, 88, 'live')")
    .run(iso(0), iso(10 * 60_000), iso(0), iso(24 * 60 * 60_000), iso(0), iso(15 * 60_000));
  runMigrations(conn, dir, MIGRATIONS.filter((m) => m.version === 10));
  const classes = () => (conn.prepare("SELECT class FROM missions ORDER BY id").all() as Array<{ class: string }>).map((r) => r.class);
  // Una real de 15 min no es rápida: mercado libre.
  assert.deepEqual(classes(), ["graduado-10m-+25%", "libre-1440m-+10%", "libre-15m-+10%"]);

  // Migración 13: las reales que la 10 (antes de este cambio) dejó en graduado pasan a libre.
  conn.exec("UPDATE missions SET class = 'graduado-15m-+10%' WHERE id = 3");
  runMigrations(conn, dir, MIGRATIONS.filter((m) => m.version === 13));
  assert.deepEqual(classes(), ["graduado-10m-+25%", "libre-1440m-+10%", "libre-15m-+10%"]);
});
