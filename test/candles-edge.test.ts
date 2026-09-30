// Casos límite de la medida con velas y de la ficha (revisión de v0.37.2), con el mercado falso y su propia base de datos:
// - el presupuesto de peticiones cuenta la búsqueda del pool en GeckoTerminal aunque falle;
// - un fallo pasajero (5xx, IP bloqueada) no gasta intentos: solo las respuestas definitivas llevan a 'unavailable';
// - la cobertura del gemelo se mide sobre el tiempo que estuvo abierto (uno que acierta pronto no pierde cotizaciones);
// - una entrada fuera de Solana no se guarda para medirla (GeckoTerminal/solana y Jupiter no la conocen);
// - la ficha dice cuántos segundos tienen los datos de cada fuente, aunque la fila de new_pools sea de una lectura anterior.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.js";
import { fetchJsonAt } from "../src/market/http.js";
import { SOL_MINT } from "../src/market/jupiter.js";
import { CANDLE_SETTLE_MS, checkCandleOutcomes, resetCandlePause, type Candle } from "../src/sim/candles.js";
import { classStats } from "../src/sim/class-stats.js";
import { recordAgentEntry } from "../src/sim/entry.js";
import { fichaAt } from "../src/sim/ficha.js";
import { createMission, getMission, startMissionClock } from "../src/sim/mission.js";
import { shadowSummary } from "../src/sim/shadow.js";
import { SignalScanner } from "../src/sim/signals.js";
import { CAKE, installFakeMarket, setExtraRoutes, tokens } from "./fake-market.js";

installFakeMarket();

// ─── GeckoTerminal falso: pools de un token, velas por pool y new_pools, con el código de respuesta que fije el test ───
const poolCalls: string[] = [];
const ohlcvCalls: string[] = [];
let poolsStatus = 200;
let ohlcvStatus = 200;
const ohlcv = new Map<string, Candle[]>();
let newPools: unknown[] = [];
setExtraRoutes((url) => {
  if (url.host === "example.test") return new Response(JSON.stringify({ ok: true }));
  if (url.host !== "api.geckoterminal.com") return undefined;
  if (/\/tokens\/[^/]+\/pools$/.test(url.pathname)) {
    poolCalls.push(url.pathname);
    if (poolsStatus !== 200) return new Response("error", { status: poolsStatus });
    return new Response(JSON.stringify({ data: [] }));
  }
  const pool = url.pathname.match(/\/pools\/([^/]+)\/ohlcv\/minute$/)?.[1];
  if (pool) {
    ohlcvCalls.push(pool);
    if (ohlcvStatus !== 200) return new Response("Bad Gateway", { status: ohlcvStatus });
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [...(ohlcv.get(pool) ?? [])].reverse() } } }));
  }
  if (url.pathname.endsWith("/new_pools")) return new Response(JSON.stringify({ data: url.searchParams.get("page") === "1" ? newPools : [] }));
  return undefined;
});

const endMs = Date.now() - CANDLE_SETTLE_MS - 60_000;
const entryMs = endMs - 10 * 60_000;
const insAgent = (missionId: number, token: string, pool: string | null) =>
  db
    .prepare("INSERT INTO agent_entries (mission_id, token, pool, entered_at, horizon_end, usd_in, tokens, entry_price_usd, tp_price_usd) VALUES (?, ?, ?, ?, ?, 48.5, 48500, 0.001, 0.00126)")
    .run(missionId, token, pool, new Date(entryMs).toISOString(), new Date(endMs).toISOString());
const row = (missionId: number) =>
  ({ ...(db.prepare("SELECT candle_status, candle_attempts, candle_next_at, candle_note FROM agent_entries WHERE mission_id = ?").get(missionId) as object) }) as {
    candle_status: string | null;
    candle_attempts: number;
    candle_next_at: string | null;
    candle_note: string | null;
  };
// Los turnos de GeckoTerminal (uno cada 2,1 s) se comparten en la base: entre vueltas del test, libres.
const freeTurns = () => db.exec("DELETE FROM http_pacing");

test("velas: la búsqueda del pool en GeckoTerminal cuenta en maxRequests aunque falle; un 5xx no gasta intentos y un 404 sí", async () => {
  resetCandlePause();
  freeTurns();
  // Tres entradas sin pool (como las reconstruidas por la migración 15) de tokens que Jupiter no conoce: se busca en GeckoTerminal.
  const ids = [90_101, 90_102, 90_103];
  ids.forEach((id, i) => insAgent(id, `NOPOOL${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump`, null));
  poolsStatus = 500;
  await checkCandleOutcomes({ maxRequests: 1, missionIds: ids });
  assert.equal(poolCalls.length, 1, "con maxRequests = 1, una sola petición aunque haya fallado");
  const first = row(90_101);
  assert.equal(first.candle_status, null);
  assert.equal(first.candle_attempts, 0, "un 500 es pasajero: no gasta intento");
  assert.match(first.candle_note!, /fallo pasajero.*HTTP 500/);
  assert.ok(Date.parse(first.candle_next_at!) > Date.now(), "se vuelve a pedir más tarde");
  assert.deepEqual([row(90_102), row(90_103)].map((r) => [r.candle_attempts, r.candle_note]), [
    [0, null],
    [0, null],
  ]);

  // Un 404 (el token no tiene pool en GeckoTerminal) sí es definitivo: con maxRequests = 2, dos peticiones y un intento cada una.
  poolsStatus = 404;
  freeTurns();
  await checkCandleOutcomes({ maxRequests: 2, missionIds: ids });
  assert.equal(poolCalls.length, 3);
  assert.deepEqual([row(90_102), row(90_103)].map((r) => r.candle_attempts), [1, 1]);
  assert.equal(row(90_101).candle_attempts, 0, "la aplazada no toca todavía");
  poolsStatus = 200;
});

test("velas: GeckoTerminal con 502 o con la IP bloqueada no deja la entrada sin medir; cuando vuelve, se mide", async () => {
  resetCandlePause();
  insAgent(90_110, "BADGWxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump", "pool_badgw");
  ohlcv.set("pool_badgw", [[Math.floor((entryMs + 60_000) / 60_000) * 60, 0.001, 0.0013, 0.0009, 0.0011]]);
  ohlcvStatus = 502;
  let nowMs = Date.now();
  // Más que MAX_FAILURES seguidos, cada uno cuando ya tocaba volver a pedirlo.
  for (let i = 0; i < 5; i++) {
    freeTurns();
    await checkCandleOutcomes({ nowMs, maxRequests: 1, missionIds: [90_110] });
    nowMs += 20 * 60_000;
  }
  assert.equal(ohlcvCalls.length, 5);
  let r = row(90_110);
  assert.deepEqual([r.candle_status, r.candle_attempts], [null, 0]);
  assert.match(r.candle_note!, /fallo pasajero.*HTTP 502/);

  // GeckoTerminal bloquea la IP (418): no gasta intento, y mientras dure el bloqueo la petición ni sale (tampoco gasta).
  ohlcvStatus = 418;
  freeTurns();
  nowMs += 60 * 60_000;
  await checkCandleOutcomes({ nowMs, maxRequests: 1, missionIds: [90_110] });
  r = row(90_110);
  assert.deepEqual([r.candle_status, r.candle_attempts], [null, 0]);
  assert.match(r.candle_note!, /HTTP 418/);
  assert.equal(ohlcvCalls.length, 6);
  ohlcvStatus = 200;
  nowMs += 60 * 60_000;
  await checkCandleOutcomes({ nowMs, maxRequests: 1, missionIds: [90_110] });
  r = row(90_110);
  assert.deepEqual([r.candle_status, r.candle_attempts], [null, 0]);
  assert.match(r.candle_note!, /bloqueado temporalmente/);
  assert.equal(ohlcvCalls.length, 6, "bloqueada: no se llama");

  db.exec("DELETE FROM http_blocked");
  freeTurns();
  nowMs += 60 * 60_000;
  await checkCandleOutcomes({ nowMs, maxRequests: 1, missionIds: [90_110] });
  const done = db.prepare("SELECT candle_status, candle_hit_wick, candle_attempts FROM agent_entries WHERE mission_id = 90110").get() as Record<string, unknown>;
  assert.deepEqual({ ...done }, { candle_status: "done", candle_hit_wick: 1, candle_attempts: 0 });
});

test("gemelo: la cobertura de sus cotizaciones es sobre el tiempo que estuvo abierto (uno que acierta pronto no pierde nada)", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(m.id);
  const clock = Date.parse(getMission(m.id)!.started_at!);
  const twin = (status: string, openMs: number, closeMs: number, quotes: number) =>
    db
      .prepare(
        `INSERT INTO shadow_positions (mission_id, token, symbol, pool, opened_at, expires_at, usd_in, tokens_raw, decimals, entry_value_usd, status, closed_at, exit_usd, quotes, quotes_missed)
         VALUES (?, ?, 'X', 'p', ?, ?, 48.5, '48500000000', 6, 47, ?, ?, 60, ?, 0)`,
      )
      .run(m.id, `T${openMs}`, new Date(openMs).toISOString(), new Date(openMs + 10 * 60_000).toISOString(), status, new Date(closeMs).toISOString(), quotes);
  // Cotizados cada 5 s mientras estuvieron abiertos: uno acierta al minuto (12 cotizaciones) y dos cierran por tiempo (120);
  // el último, visto tarde: su cierre llega después del plazo, pero cuenta hasta el plazo.
  twin("hit", clock + 10_000, clock + 70_000, 12);
  twin("expired", clock + 20_000, clock + 620_000, 120);
  twin("expired", clock + 30_000, clock + 30_000 + 10 * 60_000 + 40_000, 120);
  db.prepare("UPDATE missions SET status = 'expired', final_usd = 40, ended_at = ?, shadow_hits = 1, shadow_return = 0 WHERE id = ?").run(new Date(clock + 600_000).toISOString(), m.id);
  db.prepare("UPDATE shadow_runs SET status = 'done' WHERE mission_id = ?").run(m.id);
  assert.match(shadowSummary(m.id)!.observation!, /^252 cotizaciones de las ~252 que tocaban mientras estuvieron abiertos \(100 %\)/);
  const cls = classStats({ cls: getMission(m.id)!.class!, costMode: "sim" })[0]!;
  assert.match(cls.twinObservation!, /los 3 gemelos terminados cotizaron 252 de las ~252 veces que tocaba mientras estuvieron abiertos \(100 %\)/);
});

test("agente: una entrada rápida fuera de Solana no se guarda para medirla con velas", async () => {
  resetCandlePause();
  const m = await createMission(50, 62.5, 10, undefined, { bsc: 100 });
  startMissionClock(m.id);
  const calls = poolCalls.length + ohlcvCalls.length;
  const entry = { missionId: m.id, token: { address: CAKE, symbol: "CAKE", decimals: 18 }, usdIn: 48.5, tokens: 24, entryPrice: 2, tpPrice: 2.5, enteredMs: Date.now() };
  assert.equal(recordAgentEntry({ ...entry, chain: "bsc" }), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_entries WHERE mission_id = ?").get(m.id)!.n, 0);
  await checkCandleOutcomes({ maxRequests: 4, missionIds: [m.id] });
  assert.equal(poolCalls.length + ohlcvCalls.length, calls, "nada que pedir a GeckoTerminal");
});

test("ficha: la edad de cada fuente, aunque la fila de new_pools sea de una lectura anterior y Jupiter venga de su caché", async () => {
  // Una respuesta de la caché conserva la hora de la petición que la llenó.
  const a = await fetchJsonAt("https://example.test/x", { ttlMs: 60_000 });
  await new Promise((r) => setTimeout(r, 30));
  const b = await fetchJsonAt("https://example.test/x", { ttlMs: 60_000 });
  assert.equal(b.atMs, a.atMs);

  const TOK = "STALEfich1111111111111111111111111111pump";
  newPools = [
    {
      id: "solana_pool_stale",
      attributes: {
        address: "pool_stale",
        name: "STALE / SOL",
        pool_created_at: new Date(Date.now() - 20_000).toISOString(),
        reserve_in_usd: "20000",
        fdv_usd: "50000",
        transactions: { m5: { buys: 80, sells: 20, buyers: 60 } },
        volume_usd: { m5: "3000" },
        price_change_percentage: { m5: "12" },
      },
      relationships: { base_token: { data: { id: `solana_${TOK}` } }, quote_token: { data: { id: `solana_${SOL_MINT}` } }, dex: { data: { id: "pumpswap" } } },
    },
  ];
  freeTurns();
  const s = new SignalScanner({ source: "graduado", filters: {}, usdAmount: 48.5, timing: { pollMs: 10, geckoPageTtlMs: [1, 1], recheckMs: 0, maxChecksPerPoll: 3 } });
  const readAt = Date.now();
  assert.equal(await s.poll(), null, "Jupiter aún no conoce el token: se vuelve a mirar");
  // El pool sale de las páginas de new_pools (llegan otros más nuevos) y Jupiter ya lo conoce.
  newPools = [];
  await new Promise((r) => setTimeout(r, 1500));
  tokens[TOK] = { symbol: "STL", decimals: 6, price: 0.001, launchpad: "pump.fun", extra: { holderCount: 90 } };
  installFakeMarket();
  const hit = await s.poll();
  assert.ok(hit?.snapshot, "pasa en la segunda vuelta");
  const nowMs = Date.now();
  const f = fichaAt(hit.snapshot, nowMs, "señal");
  const geckoRealAgeS = Math.round((nowMs - readAt) / 1000);
  assert.equal(f.buys5m, 80, "la fila de la lectura anterior");
  assert.ok(Math.abs((f.geckoAgeS as number) - geckoRealAgeS) <= 1, `geckoAgeS ${f.geckoAgeS} frente a ${geckoRealAgeS} s`);
  assert.equal(f.dataAgeS, f.geckoAgeS, "dataAgeS: lo más antiguo");
  assert.ok((f.jupAgeS as number) < (f.geckoAgeS as number), `jupAgeS ${f.jupAgeS} (de la segunda vuelta) frente a geckoAgeS ${f.geckoAgeS}`);
  assert.equal(f.holders, 90);
});
