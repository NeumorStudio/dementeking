// Medida con velas (v0.37.2): el resultado de cada entrada de una misión rápida, del agente y de cada gemelo, con las velas
// de 1 min de su pool (GeckoTerminal), la misma vara para los dos. Y la ficha de entrada de cada uno, el conjunto de
// entradas del planner (entry_dataset) y las cotizaciones que pierde el gemelo. Todo con el mercado falso: GeckoTerminal
// y Jupiter responden lo que fija el test, sin red.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { db } from "../src/db.js";
import { SOL_MINT } from "../src/market/jupiter.js";
import { MIGRATIONS } from "../src/migrations.js";
import { CANDLE_SETTLE_MS, candleOutcome, checkCandleOutcomes, resetCandlePause, type Candle } from "../src/sim/candles.js";
import { classStats } from "../src/sim/class-stats.js";
import { recordAgentEntry } from "../src/sim/entry.js";
import { fichaAt, geckoValues, jupiterValues, snapshotFrom } from "../src/sim/ficha.js";
import * as memory from "../src/sim/memory.js";
import { createMission, getMission, recordSignal, startMissionClock } from "../src/sim/mission.js";
import { checkShadows, shadowSummary, type ShadowTiming } from "../src/sim/shadow.js";
import { wilson } from "../src/sim/stats.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, setExtraRoutes, tokens } from "./fake-market.js";

installFakeMarket();

const CLS = "graduado-10m-+25%";
const sec = (iso: string) => Date.parse(iso) / 1000;
const candleAt = (ms: number, o: number, h: number, l: number, c: number): Candle => [Math.floor(ms / 60_000) * 60, o, h, l, c];

// ─── GeckoTerminal falso: new_pools, velas por pool (con 429 a demanda) y pools de un token ─────────────────────
let pages: () => unknown[][] = () => [[], []];
const ohlcv = new Map<string, Candle[]>();
const geckoCalls: URL[] = [];
let fail429 = 0;
let jupiterQuote429: string | null = null;
setExtraRoutes((url) => {
  if (url.host === "lite-api.jup.ag" && url.pathname === "/swap/v1/quote" && jupiterQuote429 && url.searchParams.get("inputMint") === jupiterQuote429) {
    return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "1" } });
  }
  if (url.host !== "api.geckoterminal.com") return undefined;
  const pool = url.pathname.match(/\/pools\/([^/]+)\/ohlcv\/minute$/)?.[1];
  if (pool) {
    geckoCalls.push(url);
    if (fail429 > 0) {
      fail429--;
      return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "1" } });
    }
    // Como GeckoTerminal: de la más reciente a la más antigua.
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [...(ohlcv.get(pool) ?? [])].reverse() } } }));
  }
  if (url.pathname.endsWith("/new_pools")) return new Response(JSON.stringify({ data: pages()[Number(url.searchParams.get("page")) - 1] ?? [] }));
  return undefined;
});

/** Un pool de PumpSwap de new_pools con los campos de la ficha. */
function newPool(token: string, ageSeconds: number) {
  return {
    id: `solana_pool_${token.slice(0, 6)}`,
    attributes: {
      address: `pool_${token.slice(0, 6)}`,
      name: `${token.slice(0, 6)} / SOL`,
      pool_created_at: new Date(Date.now() - ageSeconds * 1000).toISOString(),
      reserve_in_usd: "20000",
      fdv_usd: "61000",
      market_cap_usd: "2500000",
      volume_usd: { m5: "9000" },
      price_change_percentage: { m5: "12.5" },
      transactions: { m5: { buys: 50, sells: 20, buyers: 40, sellers: 15 } },
    },
    relationships: {
      base_token: { data: { id: `solana_${token}` } },
      quote_token: { data: { id: `solana_${SOL_MINT}` } },
      dex: { data: { id: "pumpswap" } },
    },
  };
}

/** Lo que da la búsqueda de Jupiter de un recién graduado (campos reales, recortados). */
const jupiterRow = (holders: number, graduatedAgoS = 60) => ({
  holderCount: holders,
  mcap: 37_690.4,
  fdv: 37_690.4,
  liquidity: 7016.8,
  organicScore: 51.28,
  organicScoreLabel: "medium",
  graduatedAt: new Date(Date.now() - graduatedAgoS * 1000).toISOString(),
  createdAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
  dev: "3gnFBkQKygMWuZcmdT9aeNCUMcZSwAHxPPen3aQoZikL",
  twitter: "https://x.com/x",
  tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 24.73, devMigrations: 1, devMints: 1 },
  stats5m: { priceChange: 13.16, holderChange: 5.26, buyVolume: 4695, sellVolume: 4949, numBuys: 118, numSells: 63, numTraders: 62, numOrganicBuyers: 3, numNetBuyers: 26 },
});

test("velas: mecha, cierre, minutos hasta la toma de beneficio, caída antes de tocarla y subida máxima", () => {
  const entryMs = Date.parse("2026-09-30T08:53:13Z");
  const endMs = entryMs + 10 * 60_000;
  const c = (hhmm: string, o: number, h: number, l: number, cl: number): Candle => [sec(`2026-09-30T${hhmm}:00Z`), o, h, l, cl];
  const candles = [
    c("08:52", 1, 5, 0.5, 1), // antes de entrar: no cuenta
    c("08:53", 1, 1.1, 0.9, 1.02), // la de la entrada (parcial)
    c("08:54", 1.02, 1.2, 0.8, 1.1),
    c("08:55", 1.1, 1.3, 0.6, 1.28), // la toca; su mínimo no cuenta en la caída (no se sabe si fue antes o después)
    c("09:02", 1.2, 1.25, 1.1, 1.2), // la última entera del plazo (acaba a las 09:03:00)
    c("09:03", 1.2, 1.5, 0.5, 1.45), // cruza el final del plazo (09:03:13): su cierre es de después y su pico puede serlo: no cuenta
    c("09:04", 1.2, 9, 0.1, 1), // después del plazo: no cuenta
  ];
  const at = (tp: number) => candleOutcome({ candles, entryMs, endMs, entryPriceUsd: 1, tpPriceUsd: tp })!;
  assert.deepEqual(at(1.25), { hitWick: true, hitClose: true, minutesToTp: 1.8, maxDrawdownPct: -20, maxRunupPct: 30, candleCount: 4, gapPct: 2 });
  // Solo mecha: ningún cierre llega.
  assert.deepEqual([at(1.29).hitWick, at(1.29).hitClose], [true, false]);
  // No la toca: la caída es la de todo el plazo y no hay minutos.
  const miss = at(2);
  assert.deepEqual([miss.hitWick, miss.hitClose, miss.minutesToTp, miss.maxDrawdownPct, miss.maxRunupPct], [false, false, null, -40, 30]);
  // Solo la toca la vela que cruza el final del plazo (47 de sus 60 s son de después): ni mecha ni cierre.
  const late = at(1.4);
  assert.deepEqual([late.hitWick, late.hitClose, late.minutesToTp], [false, false, null]);
  // Con un plazo de minutos enteros, justo 10 velas: la de la entrada (parcial) y hasta la que acaba en el final del plazo.
  const ten = Array.from({ length: 12 }, (_, i): Candle => [sec("2026-09-30T08:53:00Z") + i * 60, 1, 1.01, 0.99, 1]);
  assert.equal(candleOutcome({ candles: ten, entryMs, endMs, entryPriceUsd: 1, tpPriceUsd: 2 })!.candleCount, 10);
  // La toca la vela de la entrada: 0 min, y de caída solo cuenta su apertura.
  assert.deepEqual([at(1.05).minutesToTp, at(1.05).maxDrawdownPct], [0, 0]);
  // Sin velas en su plazo, o sin precios: no hay medida.
  assert.equal(candleOutcome({ candles: [c("09:10", 1, 2, 1, 2)], entryMs, endMs, entryPriceUsd: 1, tpPriceUsd: 1.25 }), null);
  assert.equal(candleOutcome({ candles, entryMs, endMs, entryPriceUsd: 0, tpPriceUsd: 1.25 }), null);
});

test("ficha: lo de GeckoTerminal y Jupiter, con las edades a la hora de entrar y sin inventar lo que falta", () => {
  const nowMs = Date.parse("2026-09-30T09:00:00Z");
  const jup = jupiterValues({ id: "x", graduatedPool: "8CRH", ...jupiterRow(340, 90), graduatedAt: "2026-09-30T08:58:30Z", createdAt: "2026-09-30T03:00:00Z" });
  assert.equal(jup.graduatedPool, "8CRH");
  const snap = snapshotFrom({
    capturedAtMs: nowMs - 4000,
    poolCreatedMs: nowMs - 50_000,
    gecko: geckoValues(newPool("TOKEN", 50).attributes),
    jupiter: jup,
    roundTripPct: 2.345,
  });
  assert.equal(snap.pool, "8CRH", "sin pool de new_pools, el graduatedPool de Jupiter");
  const f = fichaAt(snap, nowMs, "señal");
  assert.equal(f.from, "señal");
  assert.equal(f.dataAgeS, 4);
  assert.equal(f.poolAgeS, 50);
  assert.equal(f.graduatedAgoS, 90);
  assert.equal(f.tokenAgeS, 6 * 3600);
  assert.equal(f.mcapUsd, 2_500_000);
  assert.equal(f.sellers5m, 15);
  assert.equal(f.holders, 340);
  assert.equal(f.topHoldersPct, 24.7);
  assert.equal(f.mintDisabled, true);
  assert.equal(f.devMints, 1);
  assert.equal(f.netBuyers5m, 26);
  assert.equal(f.token2022, true);
  assert.equal(f.hasTwitter, true);
  assert.equal(f.roundTripPct, 2.35);
  assert.equal(f.jupFdvUsd, undefined, "el FDV de Jupiter solo si no es el mcap");
  // Nada de datos: nada en la ficha (desconocido no es cero).
  assert.deepEqual(fichaAt(snapshotFrom({ capturedAtMs: nowMs, gecko: geckoValues({}), jupiter: jupiterValues(undefined) }), nowMs, "señal"), { from: "señal", dataAgeS: 0 });
});

test("velas del agente y de sus gemelos: una petición por posición, 429 sin insistir, y en la clase, la revisión y entry_dataset", async () => {
  resetCandlePause();
  const AG = "AGcndl1111111111111111111111111111111pump";
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(m.id);
  const started = getMission(m.id)!;
  const clock = Date.parse(started.started_at!);
  const deadline = Date.parse(started.deadline);
  const tpUsd = (db.prepare("SELECT tp_usd FROM shadow_runs WHERE mission_id = ?").get(m.id) as { tp_usd: number }).tp_usd;
  const tokensBought = 48_500; // 48,5 $ a 0,001
  const tpPrice = tpUsd / tokensBought;

  // El agente entra en la señal de wait_for_signal: su ficha y su pool salen de ahí.
  const snap = snapshotFrom({
    capturedAtMs: clock - 3000,
    pool: "pool_AG",
    poolCreatedMs: clock - 40_000,
    gecko: geckoValues(newPool(AG, 40).attributes),
    jupiter: jupiterValues({ id: AG, ...jupiterRow(340), graduatedAt: new Date(clock - 60_000).toISOString() }),
  });
  recordSignal(m.id, AG, snap);
  const entryMs = clock + 2000;
  assert.equal(recordAgentEntry({ missionId: m.id, chain: "solana", token: { address: AG, symbol: "AGC", decimals: 6 }, usdIn: 48.5, tokens: tokensBought, entryPrice: 0.001, tpPrice, enteredMs: entryMs }), true);
  assert.equal(recordAgentEntry({ missionId: m.id, chain: "solana", token: { address: AG, symbol: "AGC", decimals: 6 }, usdIn: 1, tokens: 1, entryPrice: 1, enteredMs: entryMs }), false, "solo la primera entrada");
  const agentRow = db.prepare("SELECT * FROM agent_entries WHERE mission_id = ?").get(m.id) as { pool: string; horizon_end: string; features: string };
  assert.equal(agentRow.pool, "pool_AG");
  assert.equal(agentRow.horizon_end, started.deadline, "se mide hasta el plazo de la misión");
  const ficha = JSON.parse(agentRow.features) as Record<string, unknown>;
  assert.deepEqual([ficha.from, ficha.graduatedAgoS, ficha.poolAgeS, ficha.holders], ["señal", 62, 42, 340]);

  // Tres gemelos terminados (uno perdió el pico con cotizaciones: expired, pero sus velas lo tocan).
  const twin = (token: string, pool: string, status: string, openMs: number, exit: number, holders: number) =>
    Number(
      db
        .prepare(
          `INSERT INTO shadow_positions (mission_id, token, symbol, pool, opened_at, expires_at, usd_in, tokens_raw, decimals, entry_value_usd, status, closed_at, exit_usd, quotes, quotes_missed, features)
           VALUES (?, ?, ?, ?, ?, ?, 48.5, '48500000000', 6, 47, ?, ?, ?, 60, 55, ?)`,
        )
        .run(m.id, token, token.slice(0, 3), pool, new Date(openMs).toISOString(), new Date(openMs + 10 * 60_000).toISOString(), status, new Date(openMs + 10 * 60_000).toISOString(), exit, JSON.stringify({ from: "señal", holders }))
        .lastInsertRowid,
    );
  const t1 = twin("TA1xxxxx", "pool_T1", "expired", clock + 30_000, 40, 50);
  const t2 = twin("TB2xxxxx", "pool_T2", "hit", clock + 60_000, tpUsd, 500);
  const t3 = twin("TC3xxxxx", "pool_T3", "expired", clock + 90_000, 30, 20);
  const path = (startMs: number, highs: number[], closes: number[]) =>
    highs.map((h, i) => candleAt(startMs + i * 60_000, closes[i - 1] ?? 0.001, h, Math.min(0.0009, closes[i]!), closes[i]!));
  const flat = Array(11).fill(0.00105);
  ohlcv.set("pool_AG", path(entryMs, [0.0011, 0.0012, 0.0013, ...flat.slice(3)], [0.00105, 0.0011, tpPrice * 1.01, ...flat.slice(3)]));
  ohlcv.set("pool_T1", path(clock + 30_000, [0.0011, tpPrice * 1.05, ...flat.slice(2)], [0.00105, 0.0011, ...flat.slice(2)])); // solo mecha
  ohlcv.set("pool_T2", path(clock + 60_000, [0.0011, tpPrice * 1.1, ...flat.slice(2)], [0.00105, tpPrice * 1.02, ...flat.slice(2)])); // mecha y cierre
  ohlcv.set("pool_T3", path(clock + 90_000, flat, flat)); // no llega

  db.prepare("UPDATE missions SET status = 'succeeded', final_usd = 62.6, ended_at = ?, end_reason = 'target' WHERE id = ?").run(new Date(clock + 5 * 60_000).toISOString(), m.id);
  db.prepare("UPDATE shadow_runs SET status = 'done' WHERE mission_id = ?").run(m.id);
  db.prepare("UPDATE missions SET shadow_hits = 1, shadow_return = -0.1 WHERE id = ?").run(m.id);

  // Antes de que acaben los plazos (más el margen para que se publiquen las velas), no se pide nada.
  assert.deepEqual(await checkCandleOutcomes({ nowMs: deadline + 60_000, maxRequests: 4 }), []);
  assert.equal(geckoCalls.length, 0);

  const late = clock + 90_000 + 10 * 60_000 + CANDLE_SETTLE_MS + 1000;
  // Un 429: no se insiste; la posición se deja para más tarde y el bucle espera.
  fail429 = 1;
  const first = await checkCandleOutcomes({ nowMs: late, maxRequests: 4 });
  assert.equal(geckoCalls.length, 1);
  assert.match(first.join("\n"), /429/);
  const retried = db.prepare("SELECT candle_status, candle_next_at FROM agent_entries WHERE mission_id = ?").get(m.id) as { candle_status: string | null; candle_next_at: string | null };
  assert.equal(retried.candle_status, null);
  assert.ok(Date.parse(retried.candle_next_at!) > late, "vuelve a pedirse más tarde");
  assert.deepEqual(await checkCandleOutcomes({ nowMs: late, maxRequests: 4 }), [], "tras el 429, el bucle espera");
  assert.equal(geckoCalls.length, 1);

  resetCandlePause();
  await new Promise((r) => setTimeout(r, 1100)); // la pausa común que pidió GeckoTerminal (retry-after: 1)
  await checkCandleOutcomes({ nowMs: late, maxRequests: 4 });
  assert.equal(geckoCalls.length, 4, "los tres gemelos; el agente aún no toca");
  await checkCandleOutcomes({ nowMs: late + 30 * 60_000, maxRequests: 4 });
  assert.equal(geckoCalls.length, 5, "una petición por posición (más la del 429)");
  for (const u of geckoCalls) {
    assert.equal(u.searchParams.get("aggregate"), "1");
    assert.equal(u.searchParams.get("currency"), "usd");
    assert.ok(Number(u.searchParams.get("before_timestamp")) > 0 && Number(u.searchParams.get("limit")) >= 11);
  }
  assert.equal(geckoCalls.at(-1)!.searchParams.get("token"), AG, "el precio del lado del token");

  const got = (table: string, key: string, id: number) =>
    ({ ...(db.prepare(`SELECT candle_status, candle_hit_wick, candle_hit_close, minutes_to_tp, candle_count FROM ${table} WHERE ${key} = ?`).get(id) as object) }) as Record<string, unknown>;
  // La toca la tercera vela desde la de la entrada: los minutos, desde la entrada hasta el principio de esa vela.
  const minutesToTp = Number(((Math.floor(entryMs / 60_000) * 60 + 120 - entryMs / 1000) / 60).toFixed(1));
  // Las velas que acaban después de la entrada y no más tarde del plazo de la misión.
  const agentCandles = Math.floor(deadline / 60_000) - Math.floor(entryMs / 60_000);
  assert.deepEqual(got("agent_entries", "mission_id", m.id), { candle_status: "done", candle_hit_wick: 1, candle_hit_close: 1, minutes_to_tp: minutesToTp, candle_count: agentCandles });
  assert.deepEqual(
    [t1, t2, t3].map((id) => got("shadow_positions", "id", id)).map((r) => [r.candle_hit_wick, r.candle_hit_close]),
    [
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  );
  assert.deepEqual(await checkCandleOutcomes({ nowMs: late + 60 * 60_000, maxRequests: 4 }), [], "medidas: no se vuelven a pedir");

  // En la clase: agente (n = entradas) y gemelo (media por misión, n = misiones) con la misma vara, y la observación.
  const cls = classStats({ cls: CLS, costMode: "sim" }).find((c) => c.perMission.some((p) => p.missionId === m.id))!;
  const candles = cls.candles as { agent: { wick: string; close: string }; twin: { wick: string; close: string }; vsTwin: string };
  const one = wilson(1, 1);
  assert.equal(candles.agent.wick, `1 de 1 (100 %; IC95 ${one.low}-${one.high} %)`);
  assert.equal(candles.agent.close, candles.agent.wick);
  assert.match(candles.twin.wick, /^67 % de media por misión en 1 misiones \(2 de 3 gemelos\)/);
  assert.match(candles.twin.close, /^33 % de media por misión en 1 misiones \(1 de 3 gemelos\)/);
  assert.match(candles.vsTwin, /con velas \(mecha\), en las 1 misiones con las dos medidas: .*se solapan/);
  assert.ok(cls.hitRate.startsWith("1 de 1"), "los aciertos reales del agente siguen ahí");
  const row = cls.perMission.find((p) => p.missionId === m.id)!;
  assert.equal(row.candleAgent, "mecha y cierre");
  assert.equal(row.candleTwin, "2 de 3 mecha, 1 cierre");
  assert.match(cls.twinObservation!, /los 3 gemelos terminados cotizaron 180 de las ~360 veces que tocaba mientras estuvieron abiertos \(50 %\); 165 perdidas/);

  // En la revisión de la misión: el gemelo y la entrada del agente, con sus velas y su ficha.
  const review = memory.missionReviewData(m.id);
  const pos = review.twin!.positions.find((p) => p.twinId === t1)! as { candles: Record<string, unknown>; quotesMissed: number };
  assert.deepEqual([pos.candles.touchesTp, pos.candles.closesAtTp, pos.quotesMissed], ["sí (mecha)", false, 55]);
  assert.match(review.twin!.observation!, /180 cotizaciones de las ~360/);
  const agentEntry = review.agentEntry as unknown as { candles: Record<string, unknown>; ficha: Record<string, unknown>; tpRisePct: number };
  assert.equal(agentEntry.candles.touchesTp, "sí (mecha)");
  assert.equal(agentEntry.ficha.holders, 340);
  assert.ok(Math.abs(agentEntry.tpRisePct - (tpPrice / 0.001 - 1) * 100) < 0.1);
  assert.equal((review.mission as Record<string, unknown>).signal_features, undefined, "la lectura en bruto no sale");

  // entry_dataset: una fila por entrada con su ficha y sus resultados, y los aciertos partidos por un campo.
  const r = await runTool("entry_dataset", { mission_class: CLS, costs: "sim", split_by: "holders", split_at: 100 }, { sessionId: 1, missionId: null });
  assert.ok(!r.isError, String(r.content));
  const out = String(r.content);
  assert.match(out, /rows:\n {2}\[\d+\] who\|mission\|twin\|costs\|at\|symbol\|realHit\|retPct\|tpRisePct\|wick\|close\|minToTp\|drawdownPct\|runupPct\|/);
  assert.match(out, new RegExp(`\\n  agente\\|${m.id}\\|\\|sim\\|[^|]*\\|AGC\\|sí\\|\\|[\\d.]+\\|sí\\|sí\\|${minutesToTp}\\|`));
  assert.match(out, /split:\n {2}feature: holders\n {2}at: 100/);
  assert.match(out, /\n {4}≤ 100\|/);
  assert.match(out, /rules: Antes de proponer un filtro/);
  const bad = await runTool("entry_dataset", { mission_class: CLS, split_by: "noexiste" }, { sessionId: 1, missionId: null });
  assert.ok(bad.isError && /Campos disponibles: .*holders/.test(String(bad.content)));
});

test("velas: sin pool guardado lo busca en Jupiter; sin velas en su plazo, tras varios intentos queda sin medir", async () => {
  resetCandlePause();
  const OLD = "OLDpool111111111111111111111111111111pump";
  tokens[OLD] = { symbol: "OLD", decimals: 6, price: 0.001, launchpad: "pump.fun", extra: { graduatedPool: "pool_from_jup" } };
  const endMs = Date.now() - CANDLE_SETTLE_MS - 60_000;
  const entryMs = endMs - 10 * 60_000;
  const ins = (missionId: number, token: string) =>
    db
      .prepare("INSERT INTO agent_entries (mission_id, token, entered_at, horizon_end, usd_in, tokens, entry_price_usd, tp_price_usd) VALUES (?, ?, ?, ?, 48.5, 48500, 0.001, 0.00126)")
      .run(missionId, token, new Date(entryMs).toISOString(), new Date(endMs).toISOString());
  ins(90_001, OLD);
  ohlcv.set("pool_from_jup", [candleAt(entryMs + 60_000, 0.001, 0.0013, 0.0009, 0.0011)]);
  await checkCandleOutcomes({ maxRequests: 1, missionIds: [90_001] });
  const row = { ...(db.prepare("SELECT pool, candle_status, candle_hit_wick, candle_hit_close FROM agent_entries WHERE mission_id = 90001").get() as object) };
  assert.deepEqual(row, { pool: "pool_from_jup", candle_status: "done", candle_hit_wick: 1, candle_hit_close: 0 });

  // Un pool sin velas en su plazo: se reintenta más tarde y, tras 4 intentos, queda sin medir (no se pide más).
  ins(90_002, "EMPTYxxxx");
  db.prepare("UPDATE agent_entries SET pool = 'pool_empty' WHERE mission_id = 90002").run();
  let nowMs = Date.now();
  for (let i = 0; i < 4; i++) {
    await checkCandleOutcomes({ nowMs, maxRequests: 1, missionIds: [90_002] });
    nowMs += 11 * 60_000;
  }
  const empty = db.prepare("SELECT candle_status, candle_attempts, candle_note FROM agent_entries WHERE mission_id = 90002").get() as { candle_status: string; candle_attempts: number; candle_note: string };
  assert.equal(empty.candle_status, "unavailable");
  assert.equal(empty.candle_attempts, 4);
  assert.match(empty.candle_note, /sin velas en su plazo/);
});

test("gemelo: ficha al entrar y cotizaciones perdidas contadas (sin turno en la vuelta o con 429 de Jupiter)", async () => {
  const T = ["TWf111111111111111111111111111111111pump", "TWf222222222222222222222222222222222pump", "TWf333333333333333333333333333333333pump"];
  T.forEach((mint, i) => (tokens[mint] = { symbol: `TF${i + 1}`, decimals: 6, price: 0.001, launchpad: "pump.fun", extra: jupiterRow(100 * (i + 1)) }));
  pages = () => [T.map((t, i) => newPool(t, 20 + i * 10)), []];
  installFakeMarket();
  const OPEN: Partial<ShadowTiming> = { quoteEveryMs: 1e12, jupiterPerTick: 3, signal: { geckoPageTtlMs: [60_000, 60_000], recheckMs: 0 } };
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(m.id);
  for (let i = 0; i < 3; i++) await checkShadows({ timing: OPEN });
  const twins = () =>
    db.prepare("SELECT id, token, pool, features, quotes, quotes_missed FROM shadow_positions WHERE mission_id = ? ORDER BY id").all(m.id) as Array<{
      id: number;
      token: string;
      pool: string;
      features: string;
      quotes: number;
      quotes_missed: number;
    }>;
  assert.deepEqual(
    twins().map((t) => t.token),
    T,
  );
  const f = JSON.parse(twins()[0]!.features) as Record<string, unknown>;
  assert.equal(twins()[0]!.pool, `pool_${T[0]!.slice(0, 6)}`);
  assert.equal(f.from, "señal");
  assert.deepEqual([f.holders, f.sellers5m, f.mcapUsd, f.reserveUsd, f.topHoldersPct, f.launchpad], [100, 15, 2_500_000, 20_000, 24.7, "pump.fun"]);
  assert.ok(typeof f.poolAgeS === "number" && typeof f.graduatedAgoS === "number" && typeof f.roundTripPct === "number", JSON.stringify(f));

  // Una vuelta con sitio para una sola cotización: las otras dos tocaban y se cuentan como perdidas.
  await checkShadows({ timing: { ...OPEN, quoteEveryMs: 0, jupiterPerTick: 1 } });
  assert.equal(
    twins().reduce((s, t) => s + t.quotes_missed, 0),
    2,
  );
  // Jupiter responde 429 a las cotizaciones de uno: también se cuenta (antes se perdía sin dejar rastro).
  jupiterQuote429 = T[1]!;
  const before = twins().find((t) => t.token === T[1])!.quotes_missed;
  await new Promise((r) => setTimeout(r, 1100));
  await checkShadows({ timing: { ...OPEN, quoteEveryMs: 0, jupiterPerTick: 3 } });
  jupiterQuote429 = null;
  assert.equal(twins().find((t) => t.token === T[1])!.quotes_missed, before + 1);
  const summary = shadowSummary(m.id)!;
  assert.ok(summary.positions.some((p) => (p as { quotesMissed?: number }).quotesMissed));
});

test("agente: wait_for_signal y enter_with_exits dejan su entrada con el pool y la ficha de la señal", async () => {
  const FR = "FRcndl1111111111111111111111111111111pump";
  tokens[FR] = { symbol: "FRC", decimals: 6, price: 0.001, launchpad: "pump.fun", extra: jupiterRow(777, 30) };
  pages = () => [[newPool(FR, 25)], []];
  installFakeMarket();
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const ctx = { sessionId: 1, missionId: m.id, startClock: async () => (startMissionClock(m.id), 7) };
  const thesis = { why: "x", evidence: "x", sources: ["t"], exit_plan: "x", beliefs_applied: [], memory_note: "x", risks_checked: "revisé riskCheck y las creencias negativas" };
  const signal = String((await runTool("wait_for_signal", { max_minutes: 0.25 }, ctx)).content);
  assert.match(signal, /FRC pasa los filtros/);
  assert.doesNotMatch(signal, /holders|snapshot/, "la ficha no es para el executor: queda en la misión");
  assert.ok(getMission(m.id)!.signal_features);
  const r = await runTool("enter_with_exits", { token: FR, thesis }, ctx);
  assert.ok(!r.isError, String(r.content));
  const out = JSON.parse(String(r.content)) as { tokensBought: number; entryPrice: number; takeProfit: { triggerPrice: number } };
  const row = db.prepare("SELECT * FROM agent_entries WHERE mission_id = ?").get(m.id) as {
    token: string;
    pool: string;
    usd_in: number;
    tokens: number;
    entry_price_usd: number;
    tp_price_usd: number;
    horizon_end: string;
    features: string;
  };
  assert.equal(row.token, FR);
  assert.equal(row.pool, `pool_${FR.slice(0, 6)}`);
  assert.ok(Math.abs(row.tokens - out.tokensBought) < 1e-6);
  assert.ok(Math.abs(row.entry_price_usd - row.usd_in / row.tokens) < 1e-12);
  assert.ok(Math.abs(row.entry_price_usd - out.entryPrice) / out.entryPrice < 1e-3);
  assert.ok(Math.abs(row.tp_price_usd - out.takeProfit.triggerPrice) / out.takeProfit.triggerPrice < 1e-3);
  assert.equal(row.horizon_end, getMission(m.id)!.deadline);
  const f = JSON.parse(row.features) as Record<string, unknown>;
  assert.deepEqual([f.from, f.holders, f.buyers5m], ["señal", 777, 40]);
  assert.ok((f.graduatedAgoS as number) >= 30 && (f.poolAgeS as number) >= 25);
});

test("migración 15: reconstruye las entradas del agente de antes (compra del diario, toma de beneficio y hora de la posición)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dementeking-m15-"));
  const conn = new DatabaseSync(path.join(dir, "sim.db"));
  conn.exec(`
    CREATE TABLE missions (id INTEGER PRIMARY KEY, created_at TEXT, deadline TEXT, started_at TEXT, mode TEXT, class TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, mission_id INTEGER, venue TEXT, condition TEXT, trigger_asset TEXT, trigger_price REAL, created_at TEXT, reasoning TEXT);
    CREATE TABLE journal (id INTEGER PRIMARY KEY, ts TEXT, mission_id INTEGER, kind TEXT, summary TEXT, details TEXT);
    CREATE TABLE positions (id INTEGER PRIMARY KEY, mission_id INTEGER, venue TEXT, asset TEXT, symbol TEXT, opened_at TEXT, entry_features TEXT);
    CREATE TABLE shadow_positions (id INTEGER PRIMARY KEY);
    INSERT INTO missions VALUES (16, '2026-09-30T08:45:41.785Z', '2026-09-30T08:55:41.785Z', '2026-09-30T08:45:41.785Z', 'sim', '${CLS}');
    INSERT INTO missions VALUES (17, '2026-09-30T08:00:00.000Z', '2026-09-30T09:00:00.000Z', '2026-09-30T08:00:00.000Z', 'sim', 'libre-60m-+10%');
    INSERT INTO orders VALUES (16, 16, 'solana', 'above', 'BuXk', 0.0000833, '2026-09-30T08:45:50.391Z', 'Toma de beneficio de enter_with_exits: el objetivo de la misión');
    INSERT INTO orders VALUES (17, 17, 'solana', 'above', 'Slow', 0.5, '2026-09-30T08:10:00.000Z', 'Toma de beneficio de enter_with_exits: x');
    INSERT INTO journal VALUES (1, '2026-09-30T08:45:44.889Z', 16, 'swap', 'Swap 48.5 USDC → 738485 Grail',
      '{"outputMint":"BuXk","sold":"48.500000053440225 USDC","received":"738485.453284 Grail"}');
    INSERT INTO positions VALUES (1, 16, 'solana', 'BuXk', 'Grail', '2026-09-30T08:45:48.237Z',
      '{"holders":487,"topHoldersPct":17.1,"mcapUsd":63050,"pairAgeMinutes":2,"creatorTokens":2,"rugcheckWarnRisks":0}');
  `);
  MIGRATIONS.find((s) => s.version === 15)!.up(conn);
  const rows = conn.prepare("SELECT * FROM agent_entries").all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1, "solo las misiones rápidas");
  const r = rows[0]!;
  assert.equal(r.mission_id, 16);
  assert.equal(r.entered_at, "2026-09-30T08:45:48.237Z");
  assert.equal(r.horizon_end, "2026-09-30T08:55:41.785Z");
  assert.ok(Math.abs((r.entry_price_usd as number) - 48.500000053440225 / 738485.453284) < 1e-15);
  assert.equal(r.tp_price_usd, 0.0000833);
  assert.equal(r.pool, null, "el pool lo busca la medida con velas");
  assert.equal(r.candle_status, null);
  assert.deepEqual(JSON.parse(r.features as string), { from: "posición (leídos tras la compra, antes de v0.37.2)", holders: 487, jupMcapUsd: 63050, topHoldersPct: 17.1, devMints: 2, graduatedAgoS: 120 });
  // Las columnas nuevas del gemelo.
  const cols = (conn.prepare("PRAGMA table_info(shadow_positions)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["features", "quotes_missed", "candle_status", "candle_hit_wick", "candle_hit_close", "minutes_to_tp", "max_drawdown_pct", "max_runup_pct", "candle_count"]) assert.ok(cols.includes(c), c);
});
