// wait_for_signal: espera sin LLM a un token recién graduado (pool de PumpSwap en new_pools de GeckoTerminal) que pase
// los filtros del plan y tenga cotización de compra y de venta en Jupiter. Funciona antes del reloj. Todo con el
// mercado falso: GeckoTerminal y Jupiter responden lo que fija el test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOL_MINT } from "../src/market/jupiter.js";
import { createMission, getMission } from "../src/sim/mission.js";
import { writePlan, type PlanBody } from "../src/sim/plans.js";
import { poolRejection, pumpSwapPools, waitForSignal } from "../src/sim/signals.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, setExtraRoutes, tokens } from "./fake-market.js";

installFakeMarket();

const FRESH = "FResh11111111111111111111111111111111pump";
const SMALL = "SMaLL11111111111111111111111111111111pump";
const OTHER = "0ther11111111111111111111111111111111pump";
const OLD = "0LD1111111111111111111111111111111111pump";
const LATE = "LATE1111111111111111111111111111111111pump";
const CURVE = "Curve1111111111111111111111111111111pump";
const STALE = "STaLE1111111111111111111111111111111pump";
const DRY = "DRY11111111111111111111111111111111111pump";
const DRAIN = "DRaiN1111111111111111111111111111111pump";

tokens[FRESH] = { symbol: "FRESH", decimals: 6, price: 0.001, launchpad: "pump.fun" };
tokens[SMALL] = { symbol: "SMALL", decimals: 6, price: 0.002, launchpad: "pump.fun" };
tokens[OTHER] = { symbol: "OTHER", decimals: 6, price: 0.001, launchpad: "met-dbc" };
tokens[OLD] = { symbol: "OLD", decimals: 6, price: 0.001, launchpad: "pump.fun" };
tokens[DRY] = { symbol: "DRY", decimals: 6, price: 0.001, launchpad: "pump.fun" };
tokens[DRAIN] = { symbol: "DRAIN", decimals: 6, price: 0.001, launchpad: "pump.fun" };

/** Un pool de new_pools tal como lo da GeckoTerminal (el token contra SOL, o al revés con reversed). */
function pool(token: string, ageSeconds: number, over: { dex?: string; liquidity?: number; reversed?: boolean } = {}) {
  const [base, quote] = over.reversed ? [SOL_MINT, token] : [token, SOL_MINT];
  return {
    id: `solana_pool_${token.slice(0, 5)}`,
    attributes: {
      address: `pool_${token.slice(0, 5)}`,
      name: `${token.slice(0, 5)} / SOL`,
      pool_created_at: new Date(Date.now() - ageSeconds * 1000).toISOString(),
      reserve_in_usd: String(over.liquidity ?? 20_000),
      fdv_usd: "50000",
      transactions: { m5: { buys: 80, sells: 20, buyers: 60 } },
      volume_usd: { m5: "3000" },
      price_change_percentage: { m5: "12" },
    },
    relationships: {
      base_token: { data: { id: `solana_${base}` } },
      quote_token: { data: { id: `solana_${quote}` } },
      dex: { data: { id: over.dex ?? "pumpswap" } },
    },
  };
}

/** Qué devuelve GeckoTerminal: las páginas se construyen al pedirlas (las edades son del momento). */
let pages: () => unknown[][] = () => [[], []];
/** Cambia las páginas y vacía la caché HTTP (una página pedida antes seguiría valiendo hasta 30 s). */
function setPages(fn: () => unknown[][]) {
  pages = fn;
  installFakeMarket();
}
let geckoCalls = 0;
/** Código con el que responde GeckoTerminal (200 = las páginas de arriba). */
let geckoStatus = 200;
setExtraRoutes((url) => {
  // Pool vaciado: comprar DRAIN da sus tokens, pero venderlos al momento devuelve el 3 %.
  if (url.host === "lite-api.jup.ag" && url.pathname === "/swap/v1/quote" && url.searchParams.get("inputMint") === DRAIN) {
    const usd = (Number(url.searchParams.get("amount")) / 1e6) * tokens[DRAIN]!.price * 0.03;
    const route = [{ percent: 100, swapInfo: { label: "Fake AMM", ammKey: "fake" } }];
    return new Response(JSON.stringify({ inAmount: url.searchParams.get("amount"), outAmount: String(Math.floor(usd * 1e6)), priceImpactPct: "0.97", slippageBps: 300, routePlan: route, contextSlot: 1 }));
  }
  if (url.host !== "api.geckoterminal.com") return undefined;
  geckoCalls++;
  if (geckoStatus !== 200) return new Response("fallo", { status: geckoStatus });
  return new Response(JSON.stringify({ data: pages()[Number(url.searchParams.get("page")) - 1] ?? [] }));
});

const fast = { pollMs: 50, geckoPageTtlMs: [1, 60_000] as [number, number], recheckMs: 100, maxChecksPerPoll: 3 };

test("new_pools: solo los pools de PumpSwap contra SOL, y los filtros que se ven sin pedir nada", () => {
  const now = Date.now();
  const list = pumpSwapPools([pool(FRESH, 30), pool(OTHER, 30, { dex: "pump-fun" }), pool(SMALL, 30, { reversed: true }), { attributes: {} }]);
  assert.deepEqual(
    list.map((p) => p.token),
    [FRESH, SMALL],
  );
  const p = list[0]!;
  assert.equal(p.liquidityUsd, 20_000);
  assert.equal(p.buys5m, 80);
  assert.equal(poolRejection(p, {}, now), null);
  assert.equal(poolRejection(p, {}, now + 2 * 60_000), "pool de más de 2 min");
  assert.equal(poolRejection(p, { max_pool_age_minutes: 5 }, now + 2 * 60_000), null);
  assert.equal(poolRejection(p, { min_liquidity_usd: 50_000 }, now), "liquidez por debajo del mínimo");
  assert.equal(poolRejection(p, { min_buy_sell_ratio_5m: 5 }, now), "proporción compras/ventas por debajo del mínimo");
  assert.equal(poolRejection(p, { max_price_change_5m_pct: 10 }, now), "variación de 5 min por encima del máximo");
  // Lo que no viene en los datos no descarta.
  assert.equal(poolRejection({ ...p, fdvUsd: undefined }, { min_fdv_usd: 1e9 }, now), null);
});

test("antes del reloj: devuelve el recién graduado de pump.fun con cotización de ida y vuelta, y el reloj sigue parado", async () => {
  setPages(() => [[pool(OTHER, 20), pool(FRESH, 40), pool(OLD, 400), pool(SMALL, 10, { dex: "pump-fun" })], []]);
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const r = await runTool("wait_for_signal", { max_minutes: 0.25 }, { sessionId: 1, missionId: m.id });
  assert.ok(!r.isError, String(r.content));
  const out = String(r.content);
  assert.match(out, /signal: FRESH pasa los filtros/);
  assert.match(out, new RegExp(`token: ${FRESH}`));
  assert.match(out, /launchpad: pump\.fun/);
  assert.match(out, /usdIn: 48\.5/, "cotiza con todo el efectivo de la misión");
  assert.match(out, /roundTripCostPct: 0\.6/, "las dos comisiones del pool falso (0,3 % cada una)");
  assert.match(out, new RegExp(`next: enter_with_exits con token ${FRESH}`));
  assert.equal(getMission(m.id)!.started_at, null, "esperar no arranca el reloj");
});

test("aplica los filtros del plan de la misión (y su importe)", async () => {
  setPages(() => [[pool(FRESH, 30, { liquidity: 20_000 }), pool(SMALL, 50, { liquidity: 5_000 })], []]);
  const body: PlanBody = {
    event: "graduado pequeño",
    source: "graduado",
    filters: { max_liquidity_usd: 10_000 },
    sizing: "20 $",
    usd_amount: 20,
    reentry: "no",
    reentry_allowed: false,
    risks_checked: "revisé riskCheck y las creencias negativas",
    why: "x",
    evidence: "x",
    sources: ["x"],
  };
  writePlan({ cls: "graduado-10m-+25%", body, predictedP: 0.3, baselineP: 0.3, missionId: null, sessionId: null, replaceReason: "prueba de filtros del plan" });
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const out = String((await runTool("wait_for_signal", { max_minutes: 0.25 }, { sessionId: 1, missionId: m.id })).content);
  assert.match(out, /signal: SMALL pasa los filtros del plan #\d+/);
  assert.match(out, /usdIn: 20/);
  assert.match(out, /y thesis \{ plan_ref: \d+ \}/);
});

test("un pool que Jupiter aún no conoce se vuelve a mirar hasta que cotiza", async () => {
  setPages(() => [[pool(LATE, 20)], []]);
  let polls = 0;
  const r = await waitForSignal({
    source: "graduado",
    filters: {},
    usdAmount: 10,
    maxMinutes: 0.5,
    timing: fast,
    shouldStop: () => {
      // A la tercera vuelta, Jupiter ya lo tiene indexado.
      if (++polls === 3) {
        tokens[LATE] = { symbol: "LATE", decimals: 6, price: 0.001, launchpad: "pump.fun" };
        installFakeMarket();
      }
      return null;
    },
  });
  assert.equal(r.found, true);
  assert.equal(r.candidate!.token, LATE);
  assert.ok(r.polls >= 3, `vueltas: ${r.polls}`);
  assert.ok(r.candidate!.poolAgeSeconds! >= 20);
});

test("sin candidato: vuelve al acabarse el tiempo con los descartes contados; exclude y parada", async () => {
  setPages(() => [[pool(FRESH, 30), pool(SMALL, 30), pool(OTHER, 30)], []]);
  const r = await waitForSignal({ source: "graduado", filters: { min_liquidity_usd: 50_000 }, exclude: [OTHER], usdAmount: 10, maxMinutes: 0.01, timing: fast });
  assert.equal(r.found, false);
  assert.equal(r.seen, 2, "el excluido no cuenta");
  assert.deepEqual(r.rejected, { "liquidez por debajo del mínimo": 2 });

  const calls = geckoCalls;
  const stopped = await waitForSignal({ source: "graduado", filters: {}, usdAmount: 10, maxMinutes: 1, timing: fast, shouldStop: () => "la misión ya no está activa" });
  assert.equal(stopped.found, false);
  assert.equal(stopped.stopped, "la misión ya no está activa");
  assert.equal(geckoCalls, calls, "no llega a pedir nada");

  // Con launchpads: [] el plan admite cualquier origen.
  setPages(() => [[pool(OTHER, 30)], []]);
  const any = await waitForSignal({ source: "graduado", filters: { launchpads: [] }, usdAmount: 10, maxMinutes: 0.2, timing: fast });
  assert.equal(any.candidate?.token, OTHER);
  assert.equal(any.candidate?.launchpad, "met-dbc");
});

test("lista corta: detecta la graduación en Jupiter sin mirar GeckoTerminal", async () => {
  tokens[CURVE] = { symbol: "CURVE", decimals: 6, price: 0.0005, launchpad: "pump.fun", graduatedAt: new Date(Date.now() - 30_000).toISOString() };
  tokens[STALE] = { symbol: "STALE", decimals: 6, price: 0.0005, launchpad: "pump.fun", graduatedAt: new Date(Date.now() - 10 * 60_000).toISOString() };
  installFakeMarket();
  const calls = geckoCalls;
  const r = await waitForSignal({ source: "shortlist", filters: {}, shortlist: [STALE, CURVE], usdAmount: 10, maxMinutes: 0.3, timing: fast });
  assert.equal(r.found, true);
  assert.equal(r.candidate!.token, CURVE);
  assert.equal(r.candidate!.detectedBy, "shortlist");
  assert.equal(r.candidate!.inShortlist, true);
  assert.ok(r.candidate!.graduatedAgoSeconds! >= 30);
  assert.deepEqual(r.rejected, { "se graduó hace más de 2 min": 1 });
  assert.equal(geckoCalls, calls);
});

test("filtros mecánicos por defecto: un pool vaciado no pasa, ni por su liquidez ni por su ida y vuelta (el plan puede cambiarlos)", async () => {
  // DRY: 5 $ de liquidez (se descarta sin preguntar a Jupiter). DRAIN: liquidez normal, pero vender devuelve el 3 %.
  setPages(() => [[pool(DRY, 20, { liquidity: 5 }), pool(DRAIN, 30)], []]);
  const r = await waitForSignal({ source: "graduado", filters: {}, usdAmount: 48.5, maxMinutes: 0.02, timing: fast });
  assert.equal(r.found, false);
  assert.deepEqual(r.rejected, { "liquidez por debajo del mínimo": 1, "pool vaciado (ida y vuelta de más del 50 %)": 1 });
  // El plan puede bajar el suelo de liquidez: DRY cotiza normal (0,6 % de ida y vuelta) y pasa.
  const own = await waitForSignal({ source: "graduado", filters: { min_liquidity_usd: 0 }, usdAmount: 48.5, maxMinutes: 0.2, timing: fast });
  assert.equal(own.candidate?.token, DRY);
  // Y un tope de ida y vuelta más estricto que el 10 % por defecto descarta sin tachar el pool para siempre.
  const strict = await waitForSignal({ source: "graduado", filters: { min_liquidity_usd: 0, max_round_trip_cost_pct: 0.1 }, usdAmount: 48.5, maxMinutes: 0.02, timing: fast });
  assert.equal(strict.found, false);
  assert.equal(strict.rejected["ida y vuelta de más del 0.1 %"], 1);
});

test("si GeckoTerminal no responde, wait_for_signal lo dice (no es lo mismo que no haber eventos)", async () => {
  geckoStatus = 500;
  setPages(() => [[pool(FRESH, 20)], []]);
  try {
    const r = await waitForSignal({ source: "graduado", filters: {}, usdAmount: 10, maxMinutes: 0.01, timing: fast });
    assert.equal(r.found, false);
    assert.equal(r.sourceErrors?.source, "GeckoTerminal");
    assert.ok(r.sourceErrors!.failed >= 2 && r.sourceErrors!.failed === r.sourceErrors!.reads, JSON.stringify(r.sourceErrors));
    assert.deepEqual(Object.keys(r.sourceErrors!.byReason), ["500"]);
    const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
    const out = String((await runTool("wait_for_signal", { max_minutes: 0.25 }, { sessionId: 1, missionId: m.id })).content);
    assert.match(out, /GeckoTerminal no ha respondido en toda la espera \(500 ×\d+\): no se sabe si hubo eventos/);
  } finally {
    geckoStatus = 200;
    installFakeMarket();
  }
  // Con la fuente sana, el resumen no dice nada de fallos.
  const ok = await waitForSignal({ source: "graduado", filters: {}, usdAmount: 10, maxMinutes: 0.2, timing: fast });
  assert.equal(ok.found, true);
  assert.equal(ok.sourceErrors, undefined);
});
