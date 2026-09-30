// Medidas de la entrada: cuándo se pidió la misión (requested_at, que no cambia al arrancar el reloj, a diferencia de
// created_at), cuándo llegó la señal de wait_for_signal y cuándo compró enter_with_exits. Con ellas, mission_status y la
// retrospectiva dicen cuánto se tardó en prepararse y en entrar desde la señal.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { db } from "../src/db.js";
import { SOL_MINT } from "../src/market/jupiter.js";
import { MIGRATIONS } from "../src/migrations.js";
import * as memory from "../src/sim/memory.js";
import { createMission, getMission, missionStatus, recordSignal, startMissionClock } from "../src/sim/mission.js";
import { statusReport } from "../src/sim/status.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, MEME, setExtraRoutes, setPrice, tokens } from "./fake-market.js";

installFakeMarket();

const FRESH = "FResh22222222222222222222222222222222pump";
tokens[FRESH] = { symbol: "FRESH", decimals: 6, price: 0.001, launchpad: "pump.fun" };

const pool = (token: string, ageSeconds: number) => ({
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
});
setExtraRoutes((url) =>
  url.host === "api.geckoterminal.com" ? new Response(JSON.stringify({ data: Number(url.searchParams.get("page")) === 1 ? [pool(FRESH, 20)] : [] })) : undefined,
);

const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y las creencias negativas" };
const text = (r: { content: unknown }) => String(r.content);

test("preparación y entrada: requested_at no cambia con el reloj, y la señal y la compra quedan en la misión", async () => {
  setPrice(FRESH, 0.001);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  assert.equal(m.requested_at, m.created_at, "se pide al crearla");
  assert.equal(m.signal_at, null);
  // Como si se hubiera pedido hace 3 minutos (lo que tarda el planner en preparar el plan).
  const requested = new Date(Date.now() - 3 * 60_000).toISOString();
  db.prepare("UPDATE missions SET requested_at = ?, created_at = ?, deadline = ? WHERE id = ?").run(requested, requested, new Date(Date.parse(requested) + 10 * 60_000).toISOString(), m.id);
  const before = (await missionStatus(m.id)) as { measurement?: { prepMinutes: number; prepNote?: string } };
  assert.ok(Math.abs(before.measurement!.prepMinutes - 3) < 0.2 && before.measurement!.prepNote, "preparándose, sin reloj");

  const ctx = { sessionId: 1, missionId: m.id, startClock: async () => (startMissionClock(m.id), 7) };
  const signal = text(await runTool("wait_for_signal", { max_minutes: 0.25 }, ctx));
  assert.match(signal, /FRESH pasa los filtros/);
  const signaled = getMission(m.id)!;
  assert.equal(signaled.signal_token, FRESH);
  assert.ok(signaled.signal_at && Date.now() - Date.parse(signaled.signal_at) < 10_000);

  const r = await runTool("enter_with_exits", { token: FRESH, thesis }, ctx);
  assert.ok(!r.isError, text(r));
  const after = getMission(m.id)!;
  assert.equal(after.requested_at, requested, "el reloj no toca requested_at");
  assert.notEqual(after.created_at, requested, "created_at sí se reescribe al arrancar el reloj");
  assert.ok(after.entry_at);
  const latency = (Date.parse(after.entry_at!) - Date.parse(signaled.signal_at!)) / 1000;
  assert.ok(after.entry_latency_s !== null && Math.abs(after.entry_latency_s - latency) < 0.11, `${after.entry_latency_s} frente a ${latency}`);

  // En mission_status, la retrospectiva y el resumen para el usuario.
  const st = (await missionStatus(m.id)) as { measurement?: Record<string, unknown> };
  assert.ok(Math.abs((st.measurement!.prepMinutes as number) - 3) < 0.5, JSON.stringify(st.measurement));
  assert.equal(st.measurement!.prepNote, undefined);
  assert.equal(st.measurement!.entryLatencySeconds, after.entry_latency_s);
  assert.equal(st.measurement!.signalToken, FRESH);
  const review = memory.missionReviewData(m.id);
  assert.deepEqual(review.measurement, st.measurement);
  assert.equal((review.mission as { requested_at: string }).requested_at, requested);
  assert.match(await statusReport(m.id), /Tiempos: preparación 3(,\d)? min · entrada a [\d,]+ s de la señal/);

  // Una señal posterior (p. ej. antes de una reentrada) ya no cambia la medida de la primera entrada.
  recordSignal(m.id, MEME);
  assert.equal(getMission(m.id)!.signal_token, FRESH);
});

test("entrada en otro token que el de la señal: la latencia no se sabe (null), y lo dice", async () => {
  setPrice(MEME, 0.01);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  recordSignal(m.id, FRESH);
  const r = await runTool("enter_with_exits", { token: MEME, thesis }, { sessionId: 1, missionId: m.id });
  assert.ok(!r.isError, text(r));
  const after = getMission(m.id)!;
  assert.ok(after.entry_at);
  assert.equal(after.entry_latency_s, null);
  const st = (await missionStatus(m.id)) as { measurement?: Record<string, unknown> };
  assert.equal(st.measurement!.entryLatencyNote, "compró otro token que el de la señal");
  assert.equal(typeof st.measurement!.prepMinutes, "number");
});

test("migración 14: cost_mode 'sim' en las misiones de antes; requested_at solo en las que aún no habían arrancado el reloj", () => {
  const conn = new DatabaseSync(":memory:");
  conn.exec(`
    CREATE TABLE missions (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, started_at TEXT);
    CREATE TABLE shadow_positions (id INTEGER PRIMARY KEY);
    INSERT INTO missions (id, created_at, started_at) VALUES (1, '2026-09-30T08:00:00.000Z', '2026-09-30T08:05:00.000Z');
    INSERT INTO missions (id, created_at, started_at) VALUES (2, '2026-09-30T09:00:00.000Z', NULL);
    INSERT INTO shadow_positions (id) VALUES (1);
  `);
  MIGRATIONS.find((x) => x.version === 14)!.up(conn);
  const rows = conn.prepare("SELECT id, cost_mode, requested_at, signal_at, entry_at, entry_latency_s FROM missions ORDER BY id").all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { id: 1, cost_mode: "sim", requested_at: null, signal_at: null, entry_at: null, entry_latency_s: null },
      { id: 2, cost_mode: "sim", requested_at: "2026-09-30T09:00:00.000Z", signal_at: null, entry_at: null, entry_latency_s: null },
    ],
  );
  assert.deepEqual({ ...(conn.prepare("SELECT costs_usd FROM shadow_positions").get() as object) }, { costs_usd: 0 });
});
