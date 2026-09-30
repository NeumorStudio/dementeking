// Encaje de estrategias: con lo que falta para el objetivo y el tiempo que queda, qué estrategia puede
// llegar y con qué riesgo. Lo calcula el simulador con datos reales, no el agente "a ojo":
// - memecoins: con las líneas base medidas (baselines.json: recién graduados, momentum, lanzamientos) y con el
//   historial de las propias operaciones del agente;
// - cripto grande al contado y futuros: con la volatilidad real de los últimos minutos (Binance), y en futuros además
//   las casillas medidas con una réplica del simulador (BTC a 40x, un futuro de 10x tipo ZEC).
// El modelo es una estimación (movimiento aleatorio sin tendencia), pero ordena bien: pedir un +10 % a SOL en 15 min
// es casi imposible; con futuros a 10x basta un +1 %, a cambio de liquidación. Con futuros cuenta la probabilidad de
// llegar al objetivo ANTES de la liquidación (dos barreras), no la de tocarlo sin más: un camino que se liquida antes
// de llegar no vale, y con reach·(1−ruin) contaba como bueno (así parecía jugable un ×2 que no lo es).
import * as binance from "../market/binance.js";
import { perpMarkets } from "../market/hyperliquid.js";
import { PERP_DEPOSIT_FEE_USD, PERP_MIN_NOTIONAL_USD, PERP_TAKER_FEE, PERP_WITHDRAW_FEE_USD } from "./perps.js";
import { getMission, minutesLeft as missionMinutesLeft, type Mission } from "./mission.js";
import { DEFAULT_FAST_MARKET, parseMissionClass } from "./mission-kind.js";
import { balance, valuation } from "./portfolio.js";
import { listPositions } from "./positions.js";
import { allChains } from "./venues/index.js";
import {
  baselineByMarket,
  baselineFrontier,
  baselineMarkets,
  baselineP,
  isBaselineMarket,
  PERP_BASELINE_INFO,
  PERP_CELLS,
  perpBaselines,
  targetLabel,
} from "./baselines.js";

const SPOT = ["SOL", "ETH", "BNB", "BTC"] as const;
/**
 * Futuros que se estudian y a qué apalancamientos: los majors a 5, 10 y 20x, y las dos casillas medidas con la réplica
 * del simulador: BTC a 40x y un futuro de alta volatilidad a 10x (ZEC). Solo los que permite Hyperliquid.
 */
const PERPS: ReadonlyArray<{ coin: string; leverages: number[] }> = [
  { coin: "SOL", leverages: [5, 10, 20] },
  { coin: "ETH", leverages: [5, 10, 20] },
  { coin: "BNB", leverages: [5, 10, 20] },
  { coin: "BTC", leverages: [40] },
  { coin: "ZEC", leverages: [10] },
];

/** Plazo máximo con el que las memecoins de la tabla medida salen como estrategia (el doble del plazo más largo medido). */
const TABLE_MAX_MINUTES = 60;

/** Costes fijos de cada futuro: depósito y retirada de Hyperliquid (0,30 $ + 1 $). */
export const PERP_FIXED_COST_USD = PERP_DEPOSIT_FEE_USD + PERP_WITHDRAW_FEE_USD;

/** Φ, la normal estándar acumulada (aproximación de Abramowitz-Stegun). */
function phi(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Cola de la normal, 1 − Φ(x), con error relativo < 1,2e-7 también muy lejos (erfc de Numerical Recipes). */
function upperTail(x: number) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r / 2 : 1 - r / 2;
}

/** Probabilidad de que un precio sin tendencia toque un nivel a `a` (en log) en un tiempo con desviación `s`. */
export const probTouch = (a: number, s: number) => (a <= 0 ? 1 : s <= 0 ? 0 : Math.min(1, 2 * (1 - phi(a / s))));

/**
 * Dos barreras: probabilidad de que un precio sin tendencia (desviación total `s` en el plazo, en log) toque +up antes
 * que −down (up) y de que toque −down antes que +up (down), dentro del plazo. Serie exacta del método de las imágenes
 * para un movimiento browniano, con L = up + down:
 *   P(up primero) = 2·Q(up/s) − Σ_{k≥1} 2·[Q((2kL − up)/s) − Q((2kL + up)/s)],   Q = 1 − Φ.
 * Sin límite de tiempo tiende a down/L (la ruina del jugador); sin la barrera de abajo, a la reflexión de probTouch.
 */
export function probFirstTouch(up: number, down: number, s: number): { up: number; down: number } {
  if (up <= 0) return { up: 1, down: 0 };
  if (down <= 0) return { up: 0, down: 1 };
  if (!(s > 0)) return { up: 0, down: 0 };
  const L = up + down;
  // Barreras diminutas frente al movimiento del plazo: sale por una u otra casi seguro, como sin límite de tiempo.
  if (s / L > 1e4) return { up: down / L, down: up / L };
  const first = (a: number) => {
    let p = 2 * upperTail(a / s);
    for (let k = 1; (2 * k * L - a) / s < 9; k++) p -= 2 * (upperTail((2 * k * L - a) / s) - upperTail((2 * k * L + a) / s));
    return Math.min(1, Math.max(0, p));
  };
  return { up: first(up), down: first(down) };
}

/** Desviación por minuto de los rendimientos logarítmicos (velas de 1 min de las últimas 4 h), la de la última hora y el cambio en esa hora. */
async function volatility(symbol: string): Promise<{ sigma: number; sigma1h: number; change1hPct: number }> {
  const k = await binance.klines(symbol, "1m", 240);
  const r = k.slice(1).map((c, i) => Math.log(c[4] / k[i]![4]));
  const sd = (xs: number[]) => {
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  };
  const last = k.at(-1)![4];
  const hourAgo = k.at(-61)?.[4] ?? k[0]![4];
  return { sigma: sd(r), sigma1h: sd(r.slice(-60)), change1hPct: Number(((last / hourAgo - 1) * 100).toFixed(2)) };
}

/** P en % para las filas: con un decimal por debajo del 10 % (un 0,3 % no es un 0 %). */
const pct = (p: number) => Number((p * 100).toFixed(p < 0.1 ? 1 : 0));
const label = (p: number) => (p >= 0.25 ? "encaja" : p >= 0.05 ? "posible" : "no encaja");

/**
 * Movimiento del precio (fracción) que necesita un futuro para llegar al objetivo, contando el depósito, la retirada
 * y la comisión de apertura y cierre sobre el nocional. El margen sale del efectivo de UNA cadena (cashUsd, por
 * defecto toda la cartera) menos el depósito; lo que falta es lo de toda la cartera.
 */
export function perpMoveNeeded(totalUsd: number, targetUsd: number, leverage: number, cashUsd = totalUsd): number {
  const margin = Math.max(1, cashUsd - PERP_DEPOSIT_FEE_USD);
  return (targetUsd - totalUsd + PERP_FIXED_COST_USD) / (margin * leverage) + 2 * PERP_TAKER_FEE;
}

/** El efectivo que puede ir de margen a un futuro: el estable de la cadena que más tiene (el margen sale de una sola). */
export function perpCash(missionId: number): { chain: string; cashUsd: number } {
  const best = allChains()
    .map((c) => ({ chain: c.label, cashUsd: balance(missionId, c.id, c.cash.address) }))
    .sort((a, b) => b.cashUsd - a.cashUsd)[0];
  return best ?? { chain: "ninguna", cashUsd: 0 };
}

export interface FitRow {
  strategy: string;
  /** Probabilidad estimada de llegar al objetivo en el tiempo que queda (%); en futuros, antes de liquidarse. */
  reachTargetPct: number | null;
  /** Riesgo de ruina o de pérdida grande (%), si aplica; en futuros, liquidarse antes de llegar. */
  ruinPct?: number | null;
  fit: "encaja" | "posible" | "no encaja" | "sin datos";
  basis: string;
  available: boolean;
}

/**
 * Lo que dice la tabla medida para una clase de misión, sin mirar ninguna cartera: la P base de (mercado, plazo,
 * objetivo), la misma casilla en los otros mercados, lo medido con futuros y la frontera de cada plazo. Lo usa el
 * planner antes de que exista la misión.
 */
export function tableFit(a: { market?: string; minutes?: number; targetPct?: number }) {
  const market = a.market ?? DEFAULT_FAST_MARKET;
  const known = isBaselineMarket(market);
  const asked = a.minutes !== undefined && a.targetPct !== undefined;
  const baseline = asked && known ? baselineP(market, a.minutes!, a.targetPct!) : undefined;
  return {
    ...(asked
      ? {
          requested: `${market} · ${Number(a.minutes!.toFixed(1))} min · ${targetLabel(a.targetPct!)}`,
          baseline: baseline ?? `sin línea base medida para el mercado ${market} (medidos: ${baselineMarkets().join(", ")})`,
          byMarket: baselineByMarket(a.minutes!, a.targetPct!),
          perps: perpBaselines(a.minutes!, a.targetPct!),
        }
      : {}),
    frontier: known
      ? { market, horizons: baselineFrontier(market) }
      : Object.fromEntries(baselineMarkets().map((m) => [m, baselineFrontier(m)])),
    note:
      "Tabla medida con datos reales (P por cierre de vela de 1 min, una compra con todo y la venta en el objetivo neto de costes). " +
      "frontier: en cada plazo, el objetivo más alto con una P de al menos el 10, el 25 y el 50 %. EV negativo en todas las casillas. " +
      `Futuros: ${PERP_BASELINE_INFO.about}`,
  };
}

export async function strategyFit(missionOrId: Mission | number) {
  const mission = typeof missionOrId === "number" ? getMission(missionOrId)! : missionOrId;
  const v = await valuation(mission.id);
  // Antes de arrancar el reloj (el cerebro planifica), cuenta la duración entera.
  const minutesLeft = Math.max(1, missionMinutesLeft(mission));
  const need = mission.target_usd / v.totalUsd - 1;
  const a = Math.log(1 + Math.max(need, 0));
  const rows: FitRow[] = [];

  // Memecoins según la tabla medida: la P de cada mercado para lo que falta en el tiempo que queda. Solo con una hora o
  // menos por delante: la tabla mide minutos después de la migración, y más allá solo daría una cota que no dice nada.
  if (need > 0 && minutesLeft <= TABLE_MAX_MINUTES) {
    for (const market of baselineMarkets()) {
      // Lo que falta, redondeado a una décima: con 49,999 $ en la cartera, +25 % es la casilla medida, no una interpolada.
      const b = baselineP(market, minutesLeft, Math.max(0.1, Number((need * 100).toFixed(1))))!;
      rows.push({
        strategy: `${b.strategy} (línea base medida)`,
        reachTargetPct: pct(b.p),
        fit: label(b.p),
        basis: b.basis,
        available: true,
      });
    }
  }

  // Cripto grande al contado y con futuros (solo los apalancamientos que permite Hyperliquid para cada moneda).
  const perpMax = await perpMarkets().then(
    (m) => new Map([...m.values()].map((x) => [x.coin, x.maxLeverage])),
    () => new Map<string, number>(),
  );
  const cash = perpCash(mission.id);
  const margin = cash.cashUsd - PERP_DEPOSIT_FEE_USD;
  for (const coin of new Set([...SPOT, ...PERPS.map((p) => p.coin)])) {
    const perp = PERPS.find((p) => p.coin === coin);
    const maxLev = perpMax.get(coin) ?? 0;
    const levs = perp?.leverages.filter((l) => l <= maxLev) ?? [];
    if (!SPOT.includes(coin as (typeof SPOT)[number]) && !levs.length) continue;
    const vol = await volatility(`${coin}USDT`).catch(() => null);
    if (vol === null) continue;
    const s = vol.sigma * Math.sqrt(minutesLeft);
    if (SPOT.includes(coin as (typeof SPOT)[number])) {
      const spot = probTouch(a, s);
      rows.push({
        strategy: `${coin} al contado`,
        reachTargetPct: pct(spot),
        fit: label(spot),
        basis: `movimiento típico en ${Math.round(minutesLeft)} min: ±${(s * 100).toFixed(2)} %; última hora: ${vol.change1hPct > 0 ? "+" : ""}${vol.change1hPct} %`,
        available: true,
      });
    }
    for (const lev of levs) {
      // El margen es el efectivo de una sola cadena menos el depósito (el gas en el nativo no cuenta), y el movimiento
      // necesario cubre lo que falta a toda la cartera más los costes fijos (depósito y retirada, 1,30 $) y la comisión
      // de apertura y cierre sobre el nocional: sin ellos, a 20x parecía que bastaba un +0,5 % cuando hacía falta un
      // +0,75 %. La liquidación llega cuando la pérdida se come el margen hasta el mantenimiento: 1/L − 1/(2·máximo).
      const measured = perpBaselines(minutesLeft, need * 100).filter((c) => c.coin === coin && c.leverage === lev);
      const measuredText = measured.length
        ? `; medido con la réplica del simulador (${PERP_BASELINE_INFO.capitalUsd} $ en una cadena): ` +
          measured
            .map((c) => {
              const gate = PERP_CELLS.find((x) => x.id === c.id)?.gate;
              const now = gate ? ` (ahora ${(vol.sigma1h * 100).toFixed(3).replace(".", ",")} %/min: ${vol.sigma1h >= gate.sigmaPerMinute ? "SÍ se cumple" : "no se cumple"})` : "";
              return `${c.label}${now}: ${c.text}`;
            })
            .join(" · ")
        : "";
      if (!(margin * lev >= PERP_MIN_NOTIONAL_USD)) {
        rows.push({
          strategy: `Futuros ${coin} ${lev}x`,
          reachTargetPct: null,
          fit: "sin datos",
          basis: `no hay margen: el efectivo de una sola cadena (${cash.chain}: ${cash.cashUsd.toFixed(2)} $) menos el depósito no llega a ${PERP_MIN_NOTIONAL_USD} $ de nocional${measuredText}`,
          available: false,
        });
        continue;
      }
      const needMove = perpMoveNeeded(v.totalUsd, mission.target_usd, lev, cash.cashUsd);
      const up = Math.log(1 + Math.max(needMove, 0));
      const liqDistance = 1 / lev - 1 / (2 * maxLev);
      const down = -Math.log(1 - liqDistance);
      const touch = probFirstTouch(up, down, s);
      rows.push({
        strategy: `Futuros ${coin} ${lev}x`,
        reachTargetPct: pct(touch.up),
        ruinPct: pct(touch.down),
        fit: label(touch.up),
        basis:
          `necesita ${(needMove * 100).toFixed(2)} % a favor ANTES de un ${(liqDistance * 100).toFixed(1)} % en contra (liquidación), con ${margin.toFixed(2)} $ de margen ` +
          `(el efectivo de ${cash.chain}: el margen sale de una sola cadena) y ~${(PERP_FIXED_COST_USD + 2 * PERP_TAKER_FEE * margin * lev).toFixed(2)} $ de costes ` +
          `(${PERP_FIXED_COST_USD.toFixed(2)} $ fijos por posición y la comisión); open_perp${measuredText}`,
        available: true,
      });
    }
  }

  // Memecoins jóvenes: con el historial propio.
  const closed = listPositions().filter((p) => p.status === "closed" && (p.entry.ageMinutes ?? Infinity) < 60 && p.pnlPct !== null);
  if (closed.length >= 5) {
    const hit = closed.filter((p) => (p.pnlPct ?? 0) >= need * 100).length / closed.length;
    const ruin = closed.filter((p) => (p.pnlPct ?? 0) <= -50).length / closed.length;
    rows.push({
      strategy: "Memecoin joven (< 60 min), según tu historial",
      reachTargetPct: pct(hit),
      ruinPct: pct(ruin),
      fit: label(hit),
      basis:
        `tus ${closed.length} operaciones: ${pct(hit)} % dieron +${(need * 100).toFixed(0)} % o más en una sola operación y ${pct(ruin)} % perdieron la mitad o más` +
        (hit < 0.05 && need > 0.3 ? "; con un objetivo así, solo encadenando varias ganadoras" : ""),
      available: true,
    });
  } else {
    rows.push({ strategy: "Memecoin joven (< 60 min), según tu historial", reachTargetPct: null, fit: "sin datos", basis: "menos de 5 operaciones propias", available: true });
  }

  // De más a menos P de llegar: en futuros ya es la de llegar antes de liquidarse, así que no se descuenta la ruina otra vez.
  rows.sort((x, y) => (y.reachTargetPct ?? -1) - (x.reachTargetPct ?? -1));
  const cls = parseMissionClass(mission.class);
  const market = cls && isBaselineMarket(cls.market) ? cls.market : DEFAULT_FAST_MARKET;
  const baseline = cls && isBaselineMarket(cls.market) ? baselineP(cls.market, cls.minutes, cls.targetPct) : undefined;
  return {
    needPct: Number((need * 100).toFixed(1)),
    minutesLeft: Math.round(minutesLeft),
    ...(mission.class ? { missionClass: mission.class } : {}),
    // La P base de la clase (la de la misión entera, no la de lo que queda): con ella se compara al agente y a su gemelo.
    ...(baseline ? { baseline: { pPct: pct(baseline.p), basis: baseline.basis } } : {}),
    frontier: { market, horizons: baselineFrontier(market) },
    note:
      "Estimación del simulador: probabilidad de llegar al objetivo en el tiempo que queda, con las líneas base medidas (memecoins), " +
      "la volatilidad real (cripto grande; en futuros, llegar antes de liquidarse) o tu historial. No es una predicción: sirve para descartar " +
      "lo que no encaja con la misión y comparar riesgos. frontier: en cada plazo medido, el objetivo más alto con P ≥10/25/50 %. " +
      "available: false = no se puede ejecutar ahora.",
    strategies: rows,
  };
}
