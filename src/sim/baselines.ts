// Líneas base medidas de las misiones rápidas (baselines.json): la P de llegar al objetivo con una regla mecánica,
// sin inteligencia, por mercado × plazo × objetivo. Sirven para tres cosas:
// - la frontera: en cada plazo, qué objetivo tiene una P de al menos el 10, el 25 o el 50 % (lo realista frente a lo pedido);
// - la P base de una clase de misión ('graduado-10m-+25%'), con la que se compara al agente y a su gemelo mecánico;
// - las casillas medidas de futuros (BTC a 40x, un futuro de 10x tipo ZEC), que el modelo de strategy_fit no ve.
// Son mediciones de un periodo concreto, no predicciones: por eso el gemelo mide además la base en cada misión.
import data from "./baselines.json" with { type: "json" };
import { parseMissionClass } from "./mission-kind.js";

export const BASELINE_HORIZONS: readonly number[] = data.horizons;
export const BASELINE_TARGETS: readonly number[] = data.targets;
/** Niveles de la frontera: el objetivo más alto con una P de al menos esto. */
export const FRONTIER_LEVELS = [0.1, 0.25, 0.5] as const;

type Cells = Record<string, Record<string, number>>;
interface MarketData {
  strategy: string;
  label: string;
  sample: string;
  verified: boolean;
  reliability: string;
  evPct: number[];
  p: Cells;
  cellEvPct?: Record<string, Record<string, number[]>>;
  wick?: Cells;
  outOfSample: Cells;
}
const MARKETS = data.memecoins as Record<string, MarketData>;

export const baselineMarkets = () => Object.keys(MARKETS);
export const isBaselineMarket = (market: string) => Object.hasOwn(MARKETS, market);
export const baselineStrategy = (market: string) => MARKETS[market]?.strategy ?? market;

export const targetLabel = (t: number) => (t === 100 ? "×2" : `+${Number(t.toFixed(1))} %`);
/** P en texto, con los decimales que hacen falta para que no salga "0 %": 35 %, 4,3 %, 0,67 %. */
export const pctText = (p: number) => `${String(Number((p * 100).toFixed(p < 0.01 ? 2 : p < 0.1 ? 1 : 0))).replace(".", ",")} %`;

export interface BaselineLookup {
  market: string;
  strategy: string;
  minutes: number;
  targetPct: number;
  /** P de llegar al objetivo (0-1). Fuera de muestra si se midió; si no, la de la muestra. */
  p: number;
  /** La de la muestra, si la de fuera de muestra es otra (el verificador la rebajó). */
  inSampleP?: number;
  /** Casilla medida tal cual (5/10/15/30 min × +25/+50/+100 %); si no, interpolada. */
  exact: boolean;
  /** Fuera de la tabla: la P real es como poco (min) o como mucho (max) esta. */
  bound?: "min" | "max";
  /** Hasta dónde puede llegar si la orden pilla las mechas (el máximo dentro del minuto). */
  wickP?: number;
  /** Valor esperado por misión, en % (de la casilla o, si no, el rango del mercado): negativo en todas. */
  evPct: [number, number];
  verified: boolean;
  sample: string;
  basis: string;
}

/** Interpola en una fila (horizonte → P) o columna: lineal entre los dos puntos medidos que rodean a x. */
function interp(xs: readonly number[], ys: readonly number[], x: number) {
  if (x <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]!) return ys[i - 1]! + ((ys[i]! - ys[i - 1]!) * (x - xs[i - 1]!)) / (xs[i]! - xs[i - 1]!);
  }
  return ys.at(-1)!;
}

/** P de una casilla medida: la de fuera de muestra si la hay (la que vale), y la de la muestra. */
function cell(m: MarketData, h: number, t: number): { p: number; inSample: number } {
  const inSample = m.p[h]![t]!;
  return { p: m.outOfSample[h]?.[t] ?? inSample, inSample };
}

/**
 * P de la línea base para un mercado, un plazo y un objetivo. Entre casillas medidas interpola (en el plazo, lineal; en el
 * objetivo, sobre ln(1 + objetivo)); fuera de la tabla da la casilla del borde como cota: con más de 30 min, al menos
 * la de 30; con un objetivo por debajo de +25 %, al menos la de +25; por encima de ×2, como mucho la de ×2. Con menos de
 * 5 min, una recta desde 0.
 */
export function baselineP(market: string, minutes: number, targetPct: number): BaselineLookup | undefined {
  const m = MARKETS[market];
  if (!m || !(minutes > 0) || !(targetPct > 0)) return undefined;
  const hs = BASELINE_HORIZONS;
  const ts = BASELINE_TARGETS;
  const exact = hs.includes(minutes) && ts.includes(targetPct);
  const bounds: Array<"min" | "max"> = [];
  if (minutes > hs.at(-1)!) bounds.push("min");
  if (targetPct < ts[0]!) bounds.push("min");
  if (targetPct > ts.at(-1)!) bounds.push("max");
  const bound = bounds.length && bounds.every((b) => b === bounds[0]) ? bounds[0] : undefined;

  const logT = (t: number) => Math.log(1 + t / 100);
  const at = (h: number, pick: "p" | "inSample") =>
    interp(
      ts.map(logT),
      ts.map((t) => cell(m, h, t)[pick]),
      logT(targetPct),
    );
  const value = (pick: "p" | "inSample") => {
    const row = hs.map((h) => at(h, pick));
    // Con menos del primer plazo medido, una recta desde (0 min, P 0): en 0 minutos no se llega a nada.
    return minutes < hs[0]! ? (row[0]! * minutes) / hs[0]! : interp(hs, row, minutes);
  };
  const p = value("p");
  const inSample = value("inSample");
  const wick = exact ? m.wick?.[minutes]?.[targetPct] : undefined;
  const cellEv = exact ? m.cellEvPct?.[minutes]?.[targetPct] : undefined;
  const ev = (cellEv ?? m.evPct) as [number, number];
  const how = exact
    ? `casilla medida (${minutes} min, ${targetLabel(targetPct)})`
    : bound
      ? `fuera de la tabla: ${bound === "min" ? "como poco" : "como mucho"} esto`
      : "interpolada entre casillas medidas";
  return {
    market,
    strategy: m.strategy,
    minutes: Number(minutes.toFixed(1)),
    targetPct: Number(targetPct.toFixed(1)),
    p: Number(p.toFixed(4)),
    ...(Math.abs(inSample - p) > 1e-9 ? { inSampleP: Number(inSample.toFixed(4)) } : {}),
    exact,
    ...(bound ? { bound } : {}),
    ...(wick !== undefined ? { wickP: wick } : {}),
    evPct: ev,
    verified: m.verified,
    sample: m.sample,
    basis:
      `${m.label}: P ${pctText(p)}${Math.abs(inSample - p) > 1e-9 ? ` fuera de muestra (${pctText(inSample)} en la muestra)` : ""}` +
      `${wick !== undefined ? `, hasta ${pctText(wick)} si la orden pilla las mechas` : ""}; EV ${ev[0] === ev[1] ? `${ev[0]} %` : `${ev[0]} a ${ev[1]} %`}; ` +
      `${how}; ${m.sample}${m.verified ? ", verificado fuera de muestra" : ", sin verificar con otro día"}`,
  };
}

/** Línea base de una clase de misión ('graduado-10m-+25%'), si su mercado está medido. */
export function baselineForClass(cls: string | null | undefined): BaselineLookup | undefined {
  const c = parseMissionClass(cls);
  return c ? baselineP(c.market, c.minutes, c.targetPct) : undefined;
}

export interface FrontierRow {
  minutes: number;
  /** P de cada objetivo medido en ese plazo (%). */
  byTargetPct: Record<string, number>;
  /** El objetivo más alto con una P de al menos el 10, el 25 y el 50 % ("ninguno": ninguno de los medidos, desde +25 %). */
  frontier: Record<string, string>;
}

/** La frontera de un mercado: para cada plazo medido, qué objetivo tiene una P de al menos el 10, el 25 y el 50 %. */
export function baselineFrontier(market: string): FrontierRow[] | undefined {
  const m = MARKETS[market];
  if (!m) return undefined;
  return BASELINE_HORIZONS.map((h) => {
    const ps = BASELINE_TARGETS.map((t) => ({ t, p: cell(m, h, t).p }));
    return {
      minutes: h,
      byTargetPct: Object.fromEntries(ps.map(({ t, p }) => [targetLabel(t), Number((p * 100).toFixed(1))])),
      frontier: Object.fromEntries(
        FRONTIER_LEVELS.map((level) => {
          const best = ps.filter((x) => x.p >= level).at(-1);
          return [`P≥${level * 100} %`, best ? targetLabel(best.t) : "ninguno"];
        }),
      ),
    };
  });
}

/** La misma casilla en todos los mercados medidos, de más a menos P: qué mercado conviene para esa clase. */
export function baselineByMarket(minutes: number, targetPct: number) {
  return baselineMarkets()
    .map((market) => baselineP(market, minutes, targetPct)!)
    .sort((a, b) => b.p - a.p)
    .map((b) => ({ market: b.market, strategy: b.strategy, pPct: Number((b.p * 100).toFixed(1)), exact: b.exact, ...(b.bound ? { bound: b.bound } : {}), verified: b.verified }));
}

interface PerpCell {
  id: string;
  coin: string;
  leverage: number;
  label: string;
  p: Record<string, number>;
  gate?: { sigmaPerMinute: number; text: string };
  ci95?: Record<string, number[]>;
  evPct?: number[];
  note?: string;
}
export const PERP_CELLS = data.perps.cells as PerpCell[];
export const PERP_BASELINE_INFO = {
  about: data.perps.about,
  capitalUsd: data.perps.capitalUsd,
  targetPct: data.perps.targetPct,
  x2: data.perps.x2,
  defaultAllocation: data.perps.defaultAllocation,
};

/**
 * Lo medido con futuros para un plazo y un objetivo: solo hay casillas de +25 % (se admite de +20 a +30 %) y de ×2 o
 * más (≈0). Con otros objetivos, la casilla dice que no se midió.
 */
export function perpBaselines(minutes: number, targetPct: number) {
  return PERP_CELLS.map((c) => {
    const base = { id: c.id, coin: c.coin, leverage: c.leverage, label: c.label, ...(c.gate ? { gate: c.gate.text } : {}) };
    if (targetPct >= 100) return { ...base, pPct: 0, text: `×2: ${data.perps.x2}` };
    if (targetPct < 20 || targetPct > 30) return { ...base, pPct: null, text: `medido solo para +${data.perps.targetPct} % y ×2` };
    const hs = BASELINE_HORIZONS;
    const row = hs.map((h) => c.p[h]!);
    const p = minutes < hs[0]! ? (row[0]! * minutes) / hs[0]! : interp(hs, row, minutes);
    return {
      ...base,
      pPct: Number((p * 100).toFixed(2)),
      text:
        `${pctText(p)} de llegar a +${data.perps.targetPct} % en ${Number(minutes.toFixed(1))} min${minutes > hs.at(-1)! ? " (como poco)" : ""}` +
        `${c.evPct ? `; EV ${c.evPct[0] === c.evPct[1] ? `${c.evPct[0]} %` : `${c.evPct[0]} a ${c.evPct[1]} %`}` : ""}${c.note ? `; ${c.note}` : ""}`,
    };
  });
}
