// Líneas base medidas y strategy_fit: la frontera de cada plazo, la P base de una clase de misión, las casillas de
// futuros (BTC a 40x, 10x tipo ZEC), el margen de un futuro con el efectivo de una sola cadena, la probabilidad de
// llegar ANTES de liquidarse (dos barreras) y el intervalo de Wilson de las estadísticas por clase.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMission, getMission, startMissionClock } from "../src/sim/mission.js";
import { baselineByMarket, baselineForClass, baselineFrontier, baselineP, perpBaselines } from "../src/sim/baselines.js";
import { perpMoveNeeded, probFirstTouch, probTouch, strategyFit, tableFit } from "../src/sim/fit.js";
import { wilson } from "../src/sim/stats.js";
import { runTool } from "../src/tools/index.js";
import { installFakeMarket, setExtraRoutes, tokens } from "./fake-market.js";
import { SOL_MINT } from "../src/market/jupiter.js";

installFakeMarket();

// Velas de 1 min de Binance con una oscilación fija por moneda (±0,1 % en SOL, ±0,2 % en BTC y ZEC) y Hyperliquid con
// BTC a 40x y ZEC a 10x además de SOL a 20x.
const swing: Record<string, number> = { SOLUSDT: 0.001, BTCUSDT: 0.002, ZECUSDT: 0.002 };
setExtraRoutes((url) => {
  if (url.host === "api.binance.com" && url.pathname === "/api/v3/klines") {
    const s = swing[url.searchParams.get("symbol")!];
    if (s === undefined) return new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 });
    const limit = Number(url.searchParams.get("limit"));
    const t0 = Date.now() - limit * 60_000;
    const rows = Array.from({ length: limit }, (_, i) => {
      const c = 100 * (i % 2 ? 1 + s : 1);
      return [t0 + i * 60_000, String(c), String(c * 1.001), String(c * 0.999), String(c)];
    });
    return new Response(JSON.stringify(rows));
  }
  if (url.host === "api.hyperliquid.xyz") {
    return new Response(
      JSON.stringify([
        { universe: [{ name: "SOL", maxLeverage: 20 }, { name: "BTC", maxLeverage: 40 }, { name: "ZEC", maxLeverage: 10 }] },
        [
          { markPx: String(tokens[SOL_MINT]!.price), funding: "0" },
          { markPx: "100000", funding: "0" },
          { markPx: "50", funding: "0" },
        ],
      ]),
    );
  }
  return undefined;
});

test("tabla medida: casillas exactas, fuera de muestra, interpolación y cotas", () => {
  const g = baselineP("graduado", 10, 25)!;
  assert.equal(g.p, 0.35);
  assert.equal(g.exact, true);
  assert.equal(g.wickP, 0.51, "hasta dónde llega si la orden pilla las mechas");
  assert.deepEqual(g.evPct, [-12, -12]);
  assert.equal(g.verified, false);

  // Momentum a 10 min: vale la cifra fuera de muestra (16 %), con la de la muestra al lado.
  const mo = baselineP("momentum", 10, 25)!;
  assert.equal(mo.p, 0.16);
  assert.equal(mo.inSampleP, 0.19);
  assert.equal(baselineP("lanzamiento", 5, 100)!.p, 0.01);

  // Entre casillas, interpolada; fuera de la tabla, la del borde como cota.
  const mid = baselineP("graduado", 12, 30)!;
  assert.equal(mid.exact, false);
  assert.ok(mid.p > 0.25 && mid.p < 0.37, String(mid.p));
  assert.equal(baselineP("graduado", 45, 20)!.bound, "min");
  assert.equal(baselineP("graduado", 45, 20)!.p, 0.39);
  const x3 = baselineP("graduado", 10, 200)!;
  assert.equal(x3.bound, "max");
  assert.equal(x3.p, 0.09);
  assert.ok(baselineP("graduado", 3, 25)!.p < 0.24, "con menos de 5 min, menos que a 5");
  assert.equal(baselineP("inventado", 10, 25), undefined);

  assert.equal(baselineForClass("graduado-5m-+50%")!.p, 0.11);
  assert.equal(baselineForClass("libre-60m-+10%"), undefined, "mercado sin medir");
  assert.equal(baselineForClass(null), undefined);
});

test("frontera: en cada plazo, el objetivo más alto con P ≥10, ≥25 y ≥50 %", () => {
  const f = baselineFrontier("graduado")!;
  assert.deepEqual(
    f.map((r) => r.minutes),
    [5, 10, 15, 30],
  );
  const at = (m: number) => f.find((r) => r.minutes === m)!;
  assert.deepEqual(at(10).byTargetPct, { "+25 %": 35, "+50 %": 21, "×2": 9 });
  assert.deepEqual(at(10).frontier, { "P≥10 %": "+50 %", "P≥25 %": "+25 %", "P≥50 %": "ninguno" });
  assert.deepEqual(at(5).frontier, { "P≥10 %": "+50 %", "P≥25 %": "ninguno", "P≥50 %": "ninguno" });
  assert.deepEqual(at(15).frontier, { "P≥10 %": "×2", "P≥25 %": "+50 %", "P≥50 %": "ninguno" });
  // Momentum usa la cifra fuera de muestra: a 10 min, ×2 = 7 %.
  assert.equal(baselineFrontier("momentum")!.find((r) => r.minutes === 10)!.byTargetPct["×2"], 7);
  // La misma casilla en todos los mercados, de más a menos P.
  assert.deepEqual(
    baselineByMarket(10, 25).map((b) => b.market),
    ["graduado", "momentum", "lanzamiento"],
  );
});

test("futuros medidos: BTC a 40x (con y sin esperar a la volatilidad) y 10x tipo ZEC; ×2 ≈ 0", () => {
  const cells = perpBaselines(15, 25);
  const byId = Object.fromEntries(cells.map((c) => [c.id, c]));
  assert.equal(byId["btc-40x"]!.pPct, 0.67);
  assert.equal(byId["btc-40x-vol"]!.pPct, 7.6);
  assert.equal(byId["zec-10x"]!.pPct, 0.48);
  assert.match(byId["btc-40x-vol"]!.gate!, /0,125 % por minuto/);
  assert.ok(perpBaselines(10, 100).every((c) => c.pPct === 0), "×2: ≈0");
  assert.ok(perpBaselines(10, 50).every((c) => c.pPct === null), "+50 % no se midió");
});

test("dos barreras: llegar antes de liquidarse, no tocar el objetivo sin más", () => {
  // Sin barrera de abajo al alcance, es la reflexión de siempre.
  const far = probFirstTouch(0.1, 10, 0.1);
  assert.ok(Math.abs(far.up - probTouch(0.1, 0.1)) < 1e-4, JSON.stringify(far));
  assert.equal(far.down, 0);
  // Simétrico.
  const sym = probFirstTouch(0.05, 0.05, 0.05);
  assert.ok(Math.abs(sym.up - sym.down) < 1e-12);
  assert.ok(sym.up < probTouch(0.05, 0.05), "la liquidación le quita caminos");
  // Con mucho tiempo, la ruina del jugador: llega antes a lo que está más cerca.
  const long = probFirstTouch(0.01, 0.03, 1);
  assert.ok(Math.abs(long.up - 0.75) < 1e-3 && Math.abs(long.down - 0.25) < 1e-3, JSON.stringify(long));
  // Un ×2 a 40x (hace falta un +5 %) con la liquidación a un 1,25 % y mucho movimiento: tocar el objetivo es probable
  // (80 %), pero llegar antes de liquidarse es como mucho lo de la ruina del jugador (1,25 / 6,25 = 20 %).
  const x2 = probFirstTouch(0.05, 0.0125, 0.2);
  assert.ok(probTouch(0.05, 0.2) > 0.75);
  assert.ok(x2.up > 0.15 && x2.up <= 0.2 + 1e-6, JSON.stringify(x2));
  assert.ok(x2.up + x2.down <= 1 + 1e-9);
});

test("margen de un futuro: el efectivo de una sola cadena, más los 1,30 $ fijos", () => {
  // Con toda la cartera como margen (el cálculo de antes) y con solo los 13,95 $ de una cadena.
  const all = perpMoveNeeded(50, 62.5, 40);
  const one = perpMoveNeeded(50, 62.5, 40, 13.95);
  assert.ok(Math.abs(all - ((12.5 + 1.3) / (49.7 * 40) + 0.0009)) < 1e-9, String(all));
  assert.ok(one > 3 * all, `${one} frente a ${all}`);
});

test("strategy_fit de una misión rápida: línea base de su clase, frontera, memecoins medidas y futuros con dos barreras", async () => {
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const fit = await strategyFit(m.id);
  assert.equal(fit.missionClass, "graduado-10m-+25%");
  assert.equal(fit.baseline!.pPct, 35);
  assert.equal(fit.frontier.market, "graduado");
  assert.equal(fit.minutesLeft, 10, "antes del reloj cuenta la duración entera");
  const row = (name: string) => fit.strategies.find((r) => r.strategy.startsWith(name));
  const grad = row("Memecoin recién graduada")!;
  assert.ok(Math.abs(grad.reachTargetPct! - 35) <= 1, String(grad.reachTargetPct));
  assert.equal(grad.fit, "encaja");
  // Futuros: el margen es el efectivo de Solana (toda la cartera está ahí, menos el gas) y la P, la de llegar antes de liquidarse.
  const sol = row("Futuros SOL 20x")!;
  assert.match(sol.basis, /de margen \(el efectivo de Solana/);
  assert.match(sol.basis, /1,30 \$ fijos|1\.30 \$ fijos/);
  assert.equal(typeof sol.ruinPct, "number");
  const btc = row("Futuros BTC 40x")!;
  assert.match(btc.basis, /medido con la réplica del simulador/);
  assert.match(btc.basis, /BTC a 40x, sin esperar: 0,3 %/);
  assert.match(btc.basis, /SÍ se cumple/, "la volatilidad de la última hora (±0,2 %/min) pasa del umbral de 0,125 %");
  assert.ok(row("Futuros ZEC 10x"), "el futuro de 10x tipo ZEC");
  // Ordenadas por la P de llegar (en futuros ya descuenta la liquidación).
  const ps = fit.strategies.map((r) => r.reachTargetPct ?? -1);
  assert.deepEqual(ps, [...ps].sort((a, b) => b - a));
  // Con el reparto por defecto, el efectivo de una cadena es mucho menos que la cartera.
  const spread = await createMission(50, 62.5, 10);
  const spreadSol = (await strategyFit(spread.id)).strategies.find((r) => r.strategy === "Futuros SOL 20x")!;
  assert.ok((spreadSol.reachTargetPct ?? 0) <= (sol.reachTargetPct ?? 0), `${spreadSol.reachTargetPct} frente a ${sol.reachTargetPct}`);
  assert.match(spreadSol.basis, /de margen/);
});

test("strategy_fit sin misión o con una clase: la tabla medida, sin cartera", async () => {
  const noMission = String((await runTool("strategy_fit", { duration_minutes: 10, target_pct: 25 }, { sessionId: 1, missionId: null })).content);
  assert.match(noMission, /requested: graduado · 10 min · \+25 %/);
  assert.match(noMission, /P 35 %/);
  assert.match(noMission, /BTC a 40x/);
  assert.match(noMission, /"P≥25 %":"\+25 %","P≥50 %":"ninguno"/);
  const other = String((await runTool("strategy_fit", { market: "momentum", duration_minutes: 10, target_pct: 100 }, { sessionId: 1, missionId: null })).content);
  assert.match(other, /P 7 % fuera de muestra \(8 % en la muestra\)/);
  const frontierOnly = tableFit({});
  assert.equal(frontierOnly.frontier.market, "graduado");
  assert.equal((await runTool("strategy_fit", { duration_minutes: 10 }, { sessionId: 1, missionId: null })).isError, true);
  // Con misión y sin nada más, el encaje completo de la misión.
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  const full = String((await runTool("strategy_fit", {}, { sessionId: 1, missionId: m.id })).content);
  assert.match(full, /strategies:/);
  assert.match(full, /missionClass: graduado-10m-\+25%/);
});

test("write_plan sin baseline_p toma la de la tabla medida; un mercado sin fuente de eventos se rechaza", async () => {
  const input = {
    duration_minutes: 10,
    target_pct: 25,
    event: "token de pump.fun migrado a PumpSwap hace 2 min o menos",
    reentry: "no",
    reentry_allowed: false,
    risks_checked: "revisé las creencias negativas y riskCheck: nada lo descarta",
    why: "la P base más alta medida",
    evidence: "35 % en 925 tokens",
    sources: ["estudio"],
    predicted_p: 0.38,
  };
  const r = await runTool("write_plan", input, { sessionId: 1, missionId: null });
  assert.ok(!r.isError, String(r.content));
  const m = await createMission(50, 62.5, 10, undefined, { solana: 100 });
  startMissionClock(m.id);
  assert.equal(getMission(m.id)!.baseline_p, 0.35);
  // La clase lleva el mercado de lo que se opera (el de la fuente): otra etiqueta cambiaría la línea base y quitaría el gemelo.
  const odd = await runTool("write_plan", { ...input, market: "momentum" }, { sessionId: 1, missionId: null });
  assert.equal(odd.isError, true);
  assert.match(String(odd.content), /El mercado de un plan es el de su fuente/);
  const same = await runTool("write_plan", { ...input, market: "graduado", replace_reason: "el mismo mercado que su fuente, dicho explícitamente" }, { sessionId: 1, missionId: null });
  assert.ok(!same.isError, String(same.content));
});

test("sin plan, la misión rápida guarda al arrancar el reloj la P base de la tabla para su clase", async () => {
  const m = await createMission(20, 30, 5, undefined, { solana: 100 });
  assert.equal(getMission(m.id)!.baseline_p, null);
  startMissionClock(m.id);
  assert.equal(getMission(m.id)!.baseline_p, 0.11, "graduado-5m-+50%");
  const slow = await createMission(1000, 1100, 60, undefined, { solana: 100 });
  startMissionClock(slow.id);
  assert.equal(getMission(slow.id)!.baseline_p, null, "libre: no hay tabla");
});

test("Wilson al 95 %: con pocas misiones no se concluye nada", () => {
  assert.deepEqual(wilson(0, 20), { low: 0, high: 16 });
  assert.deepEqual(wilson(7, 20), { low: 18, high: 57 });
  assert.deepEqual(wilson(35, 100), { low: 26, high: 45 });
  assert.deepEqual(wilson(0, 0), { low: 0, high: 100 });
});
