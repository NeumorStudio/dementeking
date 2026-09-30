// Gemelo mecánico de las misiones rápidas: al arrancar el reloj, posiciones en papel (sin tocar la cartera) en los 3
// eventos siguientes de la fuente de wait_for_signal, con el mismo tamaño, la misma toma de beneficio y el mismo plazo;
// resultado guardado en la misión cuando han terminado ella y sus gemelos. Y el seguimiento por clase del revisor:
// aciertos con su IC de Wilson, calibración del cerebro, línea base y comparación misión a misión con el gemelo.
// Todo con el mercado falso: GeckoTerminal y Jupiter responden lo que fija el test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now } from "../src/db.js";
import { SOL_MINT } from "../src/market/jupiter.js";
import { classStats } from "../src/sim/class-stats.js";
import * as memory from "../src/sim/memory.js";
import { checkMission, createMission, getMission, missionHistory, startMissionClock, stopMission } from "../src/sim/mission.js";
import { writePlan, type PlanBody } from "../src/sim/plans.js";
import { logResearch } from "../src/sim/positions.js";
import { checkShadows, SHADOW_COUNT, SHADOW_TIMING, shadowsRunning, shadowSummary, startShadowRun, type ShadowTiming } from "../src/sim/shadow.js";
import { wilson } from "../src/sim/stats.js";
import { NATIVE_DRIFT_MARGIN, TP_TARGET_MARGIN } from "../src/sim/mission-kind.js";
import { config } from "../src/config.js";
import { shadowTick, watchTick } from "../src/sim/watch.js";
import { installFakeMarket, POOL_FEE, setExtraRoutes, setPrice, tokens } from "./fake-market.js";

installFakeMarket();

const AGENT = "AGeNT11111111111111111111111111111111pump";
const T1 = "TwiN111111111111111111111111111111111pump";
const T2 = "TwiN222222222222222222222222222222222pump";
const T3 = "TwiN333333333333333333333333333333333pump";
const T4 = "TwiN444444444444444444444444444444444pump";
for (const [mint, symbol] of [
  [AGENT, "AGENT"],
  [T1, "TW1"],
  [T2, "TW2"],
  [T3, "TW3"],
  [T4, "TW4"],
] as const) {
  tokens[mint] = { symbol, decimals: 6, price: 0.001, launchpad: "pump.fun" };
}

/** Un pool de PumpSwap de new_pools (el token contra SOL), con la edad del momento en que se pide. */
function pool(token: string, ageSeconds: number) {
  return {
    id: `solana_pool_${token.slice(0, 6)}`,
    attributes: {
      address: `pool_${token.slice(0, 6)}`,
      name: `${token.slice(0, 6)} / SOL`,
      pool_created_at: new Date(Date.now() - ageSeconds * 1000).toISOString(),
      reserve_in_usd: "20000",
      transactions: { m5: { buys: 50, sells: 20, buyers: 40 } },
    },
    relationships: {
      base_token: { data: { id: `solana_${token}` } },
      quote_token: { data: { id: `solana_${SOL_MINT}` } },
      dex: { data: { id: "pumpswap" } },
    },
  };
}

let pages: () => unknown[][] = () => [[], []];
function setPages(fn: () => unknown[][]) {
  pages = fn;
  installFakeMarket();
}
setExtraRoutes((url) =>
  url.host === "api.geckoterminal.com" ? new Response(JSON.stringify({ data: pages()[Number(url.searchParams.get("page")) - 1] ?? [] })) : undefined,
);

// Abrir: sin volver a cotizar los abiertos (así cada vuelta abre uno). Seguir: cotizar todos en cada vuelta.
const OPEN: Partial<ShadowTiming> = { quoteEveryMs: 1e12, jupiterPerTick: 3, signal: { geckoPageTtlMs: [60_000, 60_000], recheckMs: 0 } };
const TRACK: Partial<ShadowTiming> = { ...OPEN, quoteEveryMs: 0 };

const runOf = (id: number) =>
  db.prepare("SELECT * FROM shadow_runs WHERE mission_id = ?").get(id) as { size_usd: number; tp_usd: number; tp_basis: string; status: string; note: string | null } | undefined;
const twinsOf = (id: number) =>
  db.prepare("SELECT token, status, exit_usd, usd_in FROM shadow_positions WHERE mission_id = ? ORDER BY id").all(id) as Array<{
    token: string;
    status: string;
    exit_usd: number | null;
    usd_in: number;
  }>;
const shadowJournal = (id: number) => db.prepare("SELECT summary FROM journal WHERE mission_id = ? AND kind = 'shadow'").all(id) as Array<{ summary: string }>;
/** Lo que da vender los tokens de 48,5 $ comprados a 0,001 con el precio en `price` (dos comisiones del pool falso). */
const sellValue = (usd: number, price: number) => usd * (1 - POOL_FEE) ** 2 * (price / 0.001);

test("gemelo: abre los 3 eventos siguientes (sin el del agente), sigue su precio y guarda el resultado al terminar todo", async () => {
  setPages(() => [[pool(AGENT, 10), pool(T1, 20), pool(T2, 30), pool(T3, 40), pool(T4, 50)], []]);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  logResearch(m.id, "wait_for_signal", AGENT); // el evento en el que entró el agente: no es de los siguientes
  assert.equal(runOf(m.id), undefined, "sin reloj no hay gemelo");
  startMissionClock(m.id);

  // Mismo tamaño y misma toma de beneficio que el agente: todo el efectivo de Solana y el precio que deja el objetivo
  // cumplido neto de costes (el resto de la cartera, el gas, sigue ahí: 0,01 SOL menos la red de la compra, la de la venta
  // y la de convertirlo al cerrar, con su precio un 0,5 % más bajo).
  const run = runOf(m.id)!;
  assert.equal(run.size_usd, 48.5);
  assert.ok(Math.abs(run.tp_usd - (62.5 * (1 + TP_TARGET_MARGIN) - (0.01 - 3 * 0.0001) * 150 * (1 - NATIVE_DRIFT_MARGIN))) < 1e-9, String(run.tp_usd));
  assert.equal(shadowsRunning(), true);
  // Cada gemelo se cotiza al ritmo de la orden del agente en una misión rápida (antes, cada 10 s: la mitad).
  assert.equal(SHADOW_TIMING.quoteEveryMs, config.fastWatchIntervalSeconds * 1000);

  // Un candidato por vuelta (3 peticiones a Jupiter): tres vueltas, tres gemelos; la cuarta ya no abre más.
  for (let i = 0; i < SHADOW_COUNT + 1; i++) await checkShadows({ timing: OPEN });
  assert.deepEqual(
    twinsOf(m.id).map((t) => t.token),
    [T1, T2, T3],
  );
  assert.ok(twinsOf(m.id).every((t) => t.status === "open" && t.usd_in === 48.5));

  // Uno llega a la toma de beneficio: se llena justo a su precio, como la orden límite del agente.
  setPrice(T1, 0.0014);
  setPrice(T2, 0.0005);
  await checkShadows({ timing: TRACK });
  assert.deepEqual(
    twinsOf(m.id).map((t) => t.status),
    ["hit", "open", "open"],
  );
  assert.ok(Math.abs(twinsOf(m.id)[0]!.exit_usd! - run.tp_usd) < 1e-9);

  // Cada gemelo tiene el plazo entero de la misión (10 min) desde que entra: pasado, vende a la cotización del momento.
  const expiries = (db.prepare("SELECT expires_at FROM shadow_positions WHERE mission_id = ?").all(m.id) as Array<{ expires_at: string }>).map((r) => Date.parse(r.expires_at));
  const later = Math.max(...expiries) + 5_000;
  await checkShadows({ timing: TRACK, nowMs: later });
  const [, t2, t3] = twinsOf(m.id);
  assert.equal(t2!.status, "expired");
  assert.ok(Math.abs(t2!.exit_usd! - sellValue(48.5, 0.0005)) < 0.01, String(t2!.exit_usd));
  assert.ok(Math.abs(t3!.exit_usd! - sellValue(48.5, 0.001)) < 0.01, String(t3!.exit_usd));

  // Con la misión aún en marcha no se guarda nada ni se escribe en su diario (el agente no debe verlo).
  assert.equal(getMission(m.id)!.shadow_hits, null);
  assert.equal(shadowJournal(m.id).length, 0);
  assert.match(shadowSummary(m.id)!.status, /en curso/);

  // Termina la misión: ahora sí, aciertos y resultado medio sobre el capital de la misión.
  db.prepare("UPDATE missions SET deadline = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), m.id);
  await checkMission();
  assert.equal(getMission(m.id)!.status, "expired");
  await checkShadows({ timing: TRACK, nowMs: later });
  const done = getMission(m.id)!;
  assert.equal(done.shadow_hits, 1);
  const expected = (run.tp_usd - 48.5 + (t2!.exit_usd! - 48.5) + (t3!.exit_usd! - 48.5)) / 3 / 50;
  assert.ok(Math.abs(done.shadow_return! - expected) < 1e-9, `${done.shadow_return} frente a ${expected}`);
  assert.equal(runOf(m.id)!.status, "done");
  assert.match(shadowJournal(m.id)[0]!.summary, /1 de 3 llegaron a la toma de beneficio/);
  assert.equal(shadowsRunning(), false, "sin gemelos en marcha, su bucle no hace nada");

  // El revisor lo ve en la retrospectiva, en su clase, en el historial y en recentApproach.
  const summary = memory.missionReviewData(m.id).twin!;
  assert.equal(summary.hits, 1);
  assert.equal(summary.twins, 3);
  assert.deepEqual(
    summary.positions.map((p) => p.status),
    ["toma de beneficio", "cerrado por tiempo", "cerrado por tiempo"],
  );
  const cls = classStats({ cls: "graduado-10m-+25%" })[0]!;
  assert.equal(cls.missions, 1);
  assert.equal(cls.hits, 0);
  const twinCi = wilson(1 / 3, 1);
  assert.equal(typeof cls.twin === "object" && cls.twin.hitRate, `33 % de media por misión en 1 misiones (1 de 3 gemelos); IC95 ${twinCi.low}-${twinCi.high} % con n = misiones`);
  const row = cls.perMission.at(-1)!;
  assert.equal(row.twin, "1 de 3");
  assert.equal(row.baselinePct, 35, "sin plan, la P base de la tabla");
  assert.equal(row.vsTwinPoints, Number((row.resultPct! - row.twinReturnPct!).toFixed(1)));
  assert.equal(missionHistory().find((h) => h.missionId === m.id)!.twin, "1 de 3");
  assert.equal(memory.recentApproach()!.perMission.find((x) => x.missionId === m.id)!.twin, "1 de 3");
  assert.ok(memory.reviewQueue().missionClasses.some((c) => c.class === "graduado-10m-+25%"));
});

test("gemelo: usa el tamaño y la toma de beneficio del plan; si se cancela la misión, se abandona", async () => {
  setPages(() => [[pool(T4, 15)], []]);
  const body: PlanBody = {
    event: "graduado",
    source: "graduado",
    filters: { min_liquidity_usd: 50_000 }, // los filtros propios del plan NO se aplican al gemelo
    sizing: "20 $",
    usd_amount: 20,
    tp_ratio: 1.3,
    reentry: "no",
    reentry_allowed: false,
    risks_checked: "revisé riskCheck y las creencias negativas",
    why: "x",
    evidence: "x",
    sources: ["x"],
  };
  const plan = writePlan({ cls: "graduado-5m-+50%", body, predictedP: 0.15, baselineP: 0.11, missionId: null, sessionId: null });
  const m = await createMission(50, 75, 5, undefined, { solana: 100 });
  startMissionClock(m.id);
  const run = runOf(m.id)!;
  assert.equal(run.size_usd, 20);
  assert.ok(Math.abs(run.tp_usd - 26) < 1e-9);
  assert.match(run.tp_basis, new RegExp(`plan #${plan.id}`));
  await checkShadows({ timing: OPEN });
  assert.deepEqual(
    twinsOf(m.id).map((t) => t.token),
    [T4],
    "solo filtros mecánicos: la liquidez mínima del plan no cuenta",
  );

  await stopMission(false, m.id);
  await checkShadows({ timing: OPEN });
  assert.equal(runOf(m.id)!.status, "abandoned");
  assert.deepEqual(
    twinsOf(m.id).map((t) => t.status),
    ["abandoned"],
  );
  assert.equal(getMission(m.id)!.shadow_hits, null);
  assert.match(shadowSummary(m.id)!.status, /abandonado/);
});

test("sin gemelo: misiones largas y mercados sin fuente mecánica; sin eventos en su plazo, sin resultado", async () => {
  const slow = await createMission(1000, 1100, 60, undefined, { solana: 100 });
  startMissionClock(slow.id);
  assert.equal(runOf(slow.id), undefined);
  assert.deepEqual(startShadowRun(slow.id), { started: false, reason: "no es una misión rápida" });

  // Un plan de otro mercado (momentum, escrito a mano: write_plan ya no lo deja) no se adopta: la misión sigue en su
  // clase, con su línea base y su gemelo.
  const body: PlanBody = {
    event: "primera vela de +25 %",
    source: "graduado",
    filters: {},
    sizing: "todo",
    reentry: "no",
    reentry_allowed: false,
    risks_checked: "revisé riskCheck y las creencias negativas",
    why: "x",
    evidence: "x",
    sources: ["x"],
  };
  writePlan({ cls: "momentum-7m-+25%", body, predictedP: 0.2, baselineP: 0.18, missionId: null, sessionId: null });
  const g7 = await createMission(50, 62.5, 7, undefined, { solana: 100 });
  startMissionClock(g7.id);
  assert.equal(getMission(g7.id)!.class, "graduado-7m-+25%");
  assert.equal(getMission(g7.id)!.plan_id, null, "el plan de otro mercado no es suyo");
  assert.ok(runOf(g7.id), "con su gemelo");
  await stopMission(false, g7.id);
  // Una misión cuya clase dice un mercado sin fuente de eventos mecánica no tiene gemelo.
  const mo = await createMission(50, 62.5, 7, undefined, { solana: 100 });
  db.prepare("UPDATE missions SET class = 'momentum-7m-+25%' WHERE id = ?").run(mo.id);
  startMissionClock(mo.id);
  assert.equal(runOf(mo.id), undefined);
  assert.match((startShadowRun(mo.id) as { reason: string }).reason, /momentum no tiene fuente/);

  // Ningún evento en todo el plazo: el gemelo termina sin resultado (no es un 0 de 3).
  setPages(() => [[], []]);
  const quiet = await createMission(50, 62.5, 3, undefined, { solana: 100 });
  startMissionClock(quiet.id);
  await checkShadows({ timing: OPEN });
  db.prepare("UPDATE missions SET deadline = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), quiet.id);
  await checkMission();
  await checkShadows({ timing: OPEN, nowMs: Date.now() + 4 * 60_000 });
  assert.equal(runOf(quiet.id)!.status, "done");
  assert.match(runOf(quiet.id)!.note!, /ningún evento/);
  assert.equal(getMission(quiet.id)!.shadow_hits, null);
  assert.equal(missionHistory().find((h) => h.missionId === quiet.id)!.twin, "sin eventos en su plazo");
});

test("estadísticas por clase: aciertos con Wilson, calibración del cerebro, línea base y gemelo", () => {
  const cls = "graduado-15m-+50%";
  const insert = db.prepare(
    `INSERT INTO missions (created_at, initial_usd, target_usd, deadline, status, started_at, final_usd, class, predicted_p, baseline_p, plan_id, shadow_hits, shadow_return)
     VALUES (?, 50, 75, ?, ?, ?, ?, ?, ?, ?, 7, ?, ?)`,
  );
  const twin = db.prepare(
    "INSERT INTO shadow_runs (mission_id, started_at, detect_until, horizon_minutes, source, size_usd, tp_usd, tp_basis, target_count, status) VALUES (?, ?, ?, 15, 'graduado', 48.5, 73.7, 'x', 3, ?)",
  );
  const pos = db.prepare(
    "INSERT INTO shadow_positions (mission_id, token, opened_at, expires_at, usd_in, tokens_raw, decimals, entry_value_usd, status, exit_usd) VALUES (?, ?, ?, ?, 48.5, '1', 6, 48, ?, ?)",
  );
  // Cinco misiones: 2 conseguidas (+50 %) y 3 no (−20 %); el cerebro esperaba un 30 % en cada una (1,5 aciertos).
  // Gemelos: 4 misiones con 3 cada una (1 acierto en total) y una con el gemelo aún en curso.
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const ok = i < 2;
    const done = i < 4;
    const hits = i === 0 ? 1 : 0;
    const id = Number(
      insert.run(now(), now(), ok ? "succeeded" : "expired", now(), ok ? 75 : 40, cls, 0.3, 0.25, done ? hits : null, done ? (hits ? 0.02 : -0.2) : null).lastInsertRowid,
    );
    ids.push(id);
    twin.run(id, now(), now(), done ? "done" : "running");
    for (let k = 0; k < 3; k++) {
      const hit = i === 0 && k === 0;
      pos.run(id, `tok${i}${k}`, now(), now(), done ? (hit ? "hit" : "expired") : "open", done ? (hit ? 73.7 : 30) : null);
    }
  }
  const s = classStats({ cls })[0]!;
  assert.equal(s.missions, 5);
  assert.equal(s.hits, 2);
  const ci = wilson(2, 5);
  assert.equal(s.hitRate, `2 de 5 (40 %; IC95 ${ci.low}-${ci.high} %)`);
  assert.deepEqual(s.ci95Pct, [ci.low, ci.high]);
  assert.equal(s.avgResultPct, 8, "(2 × 50 − 3 × 20) / 5");
  assert.deepEqual(typeof s.calibration === "object" && [s.calibration.predictedHits, s.calibration.actualHits], [1.5, 2]);
  assert.match(typeof s.calibration === "object" ? s.calibration.reading : "", /esperaba 1,5 aciertos en 5 misiones y hubo 2/);
  assert.equal("tablePct" in s.baseline && s.baseline.tablePct, 25, "graduado 15 min +50 %: la casilla medida");
  assert.equal(s.baseline.expectedHits, 1.3, "5 × 0,25, redondeado a una décima");
  const t = typeof s.twin === "object" ? s.twin : undefined;
  assert.ok(t, JSON.stringify(s.twin));
  assert.equal(t!.twins, 12);
  assert.equal(t!.hits, 1);
  assert.equal(t!.pending, 1);
  assert.equal(t!.avgReturnPct, -14.5, "(2 − 20 − 20 − 20) / 4");
  assert.equal(t!.meanRatePct, 8.3, "(1/3 + 0 + 0 + 0) / 4");
  const tci = wilson(1 / 3, 4);
  assert.deepEqual(t!.ci95Pct, [tci.low, tci.high], "IC con n = misiones");
  assert.match(s.vsTwin, /en las 4 misiones con gemelo, el agente 2 de 4 .* frente al gemelo 8 % de media por misión en 4 misiones \(1 de 12 gemelos\)/);
  assert.match(s.vsTwin, /se solapan|acierta más/);
  assert.match(s.verdict, /5 de 20 misiones: aún no se saca ninguna conclusión/);
  // Misión a misión: su P predicha, la base, el gemelo y la diferencia con él.
  const first = s.perMission[0]!;
  assert.deepEqual(
    { id: first.missionId, hit: first.hit, pred: first.predictedPct, base: first.baselinePct, twin: first.twin, twinRet: first.twinReturnPct, vs: first.vsTwinPoints },
    { id: ids[0], hit: true, pred: 30, base: 25, twin: "1 de 3", twinRet: 2, vs: 48 },
  );
  assert.match(s.perMission[4]!.twin, /en curso/);
  assert.equal(classStats({ cls, perMissionLimit: 2 })[0]!.perMission.length, 2);
});

test("gemelo visto tarde: no acierta con precios de después de su plazo; sin observar al final, no cuenta", async () => {
  // Dos gemelos abiertos hace 12 min (plazo de 10): uno se miró hasta el final (hace 2 min, a 47 $), el otro no desde que entró.
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(m.id);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const tokensRaw = String(Math.floor((48.5 / 0.001) * 1e6));
  const put = db.prepare(
    `INSERT INTO shadow_positions (mission_id, token, opened_at, expires_at, usd_in, tokens_raw, decimals, entry_value_usd, last_value_usd, best_value_usd, last_quote_at, quotes)
     VALUES (?, ?, ?, ?, 48.5, ?, 6, 48, ?, ?, ?, 5)`,
  );
  put.run(m.id, T1, ago(12), ago(2), tokensRaw, 47, 49, new Date(Date.now() - 2 * 60_000 - 3_000).toISOString());
  put.run(m.id, T2, ago(12), ago(2), tokensRaw, 48, 48, ago(12));
  put.run(m.id, T3, ago(12), ago(2), tokensRaw, 48, 48, ago(12));
  // El precio ha subido mucho después de su plazo: con él, los dos "llegarían" a la toma de beneficio.
  setPrice(T1, 0.01);
  setPrice(T2, 0.01);
  setPrice(T3, 0.01);
  await checkShadows({ timing: TRACK });
  const rows = db.prepare("SELECT token, status, exit_usd FROM shadow_positions WHERE mission_id = ? ORDER BY id").all(m.id) as Array<{ token: string; status: string; exit_usd: number | null }>;
  assert.deepEqual(
    rows.map((r) => [r.status, r.exit_usd]),
    [
      ["expired", 47],
      ["abandoned", null],
      ["abandoned", null],
    ],
    "el visto hasta el final, con su última cotización; los demás, fuera",
  );
  db.prepare("UPDATE missions SET deadline = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), m.id);
  await checkMission();
  await checkShadows({ timing: TRACK });
  const done = getMission(m.id)!;
  assert.equal(done.shadow_hits, 0, "ningún acierto con precios tardíos");
  assert.ok(Math.abs(done.shadow_return! - (47 - 48.5) / 50) < 1e-9, "solo cuenta el que se observó");
  assert.match(shadowSummary(m.id)!.unobserved!, /2 gemelo\(s\) sin observar/);
  for (const t of [T1, T2, T3]) setPrice(t, 0.001);
});

test("la vuelta de órdenes y misión no espera al gemelo: sus peticiones a GeckoTerminal van en su propio bucle", async () => {
  let gecko = 0;
  setPages(() => {
    gecko++;
    return [[pool(T4, 10)], []];
  });
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(m.id);
  assert.equal(shadowsRunning(), true);
  await watchTick();
  assert.equal(gecko, 0, "watchTick no toca el gemelo");
  await shadowTick();
  assert.ok(gecko > 0, "shadowTick sí");
  await stopMission(false, m.id);
  await shadowTick();
});

test("el intervalo del gemelo va con n = misiones: 3 gemelos de la misma franja no son 3 muestras independientes", () => {
  // 20 misiones: el agente acierta 10 (50 %); cada gemelo, 1 de cada 6 (10 de 60). Contando 60 gemelos independientes,
  // los intervalos no se solaparían ("el agente acierta más"); con n = 20 misiones, sí se solapan.
  const cls = "graduado-5m-+100%";
  const insert = db.prepare(
    `INSERT INTO missions (created_at, initial_usd, target_usd, deadline, status, started_at, final_usd, class, shadow_hits, shadow_return)
     VALUES (?, 50, 100, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const run = db.prepare(
    "INSERT INTO shadow_runs (mission_id, started_at, detect_until, horizon_minutes, source, size_usd, tp_usd, tp_basis, target_count, status) VALUES (?, ?, ?, 5, 'graduado', 48.5, 100, 'x', 3, 'done')",
  );
  const pos = db.prepare(
    "INSERT INTO shadow_positions (mission_id, token, opened_at, expires_at, usd_in, tokens_raw, decimals, entry_value_usd, status, exit_usd) VALUES (?, ?, ?, ?, 48.5, '1', 6, 48, ?, 30)",
  );
  for (let i = 0; i < 20; i++) {
    const hits = i < 10 ? 1 : 0;
    const id = Number(insert.run(now(), now(), i % 2 ? "succeeded" : "expired", now(), i % 2 ? 100 : 40, cls, hits).lastInsertRowid);
    run.run(id, now(), now());
    for (let k = 0; k < 3; k++) pos.run(id, `ci${i}-${k}`, now(), now(), k < hits ? "hit" : "expired");
  }
  const s = classStats({ cls })[0]!;
  const old = wilson(10, 60);
  const agent = wilson(10, 20);
  assert.ok(old.high < agent.low, "con n = gemelos se declararía una diferencia");
  const t = typeof s.twin === "object" ? s.twin : undefined;
  assert.deepEqual(t!.ci95Pct, [wilson(20 / 6, 20).low, wilson(20 / 6, 20).high]);
  assert.match(s.vsTwin, /los intervalos se solapan/);
});
