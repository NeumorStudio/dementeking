// Tipo de misión: rápida o larga, y su clase. Sin dependencias (lo usan también las migraciones, que no
// pueden importar la base de datos).

/**
 * Misión rápida: simulada y de 15 minutos o menos. La prepara el planner con un plan de reglas y la opera el executor;
 * lleva briefing ligero, gemelo mecánico y tesis abreviada (plan_ref), y no lleva vigía. Una real nunca es rápida (el
 * flujo del executor solo existe en simulación): la opera el trader, aunque sea corta.
 * Lo que solo depende de lo que dura (vigilar cada 5 s, `wait` desde 15 s, contrafactuales a 1-5 min) vale para
 * cualquier misión corta, real o simulada (isShortMission).
 */
export const FAST_MISSION_MAX_MINUTES = 15;

/** Si el reloj no arranca en este tiempo desde que se creó la misión, se cancela (motivo prep_timeout). */
export const PREP_TIMEOUT_MINUTES = 60;

/** Mercado por defecto de las misiones rápidas: un token de pump.fun recién migrado a su pool de PumpSwap. */
export const DEFAULT_FAST_MARKET = "graduado";

/** Mercado de las misiones largas: el agente elige dónde operar. */
export const FREE_MARKET = "libre";

/**
 * Duración de la misión en minutos. Se guarda como deadline − created_at: al crearla, created_at es la creación
 * y al arrancar el reloj se reescriben los dos, así que la diferencia es siempre la duración pedida.
 */
export function missionDurationMinutes(m: { created_at: string; deadline: string }): number {
  return (new Date(m.deadline).getTime() - new Date(m.created_at).getTime()) / 60_000;
}

// Margen de unos milisegundos: las fechas se guardan con precisión de milisegundo.
export const isFastMinutes = (minutes: number) => minutes <= FAST_MISSION_MAX_MINUTES + 0.001;

/** Misión corta (15 min o menos), real o simulada: lo que depende solo de la duración (ritmo de vigilancia y esperas). */
export const isShortMission = (m: { created_at: string; deadline: string }) => isFastMinutes(missionDurationMinutes(m));

/** Misión rápida: simulada y corta (ver FAST_MISSION_MAX_MINUTES). mode es obligatorio: una real de 15 min no lo es. */
export const isFastMission = (m: { created_at: string; deadline: string; mode: string | null }) => m.mode !== "live" && isShortMission(m);

/**
 * Clase de la misión: '<mercado>-<minutos>m-+<objetivo>%', p. ej. 'graduado-10m-+25%'. Las misiones de la misma
 * clase se comparan entre sí (y con su línea base). Las rápidas, en el mercado de su plan (graduado); las normales y
 * todas las reales, en 'libre' (el agente elige dónde operar).
 */
export function missionClass(a: { durationMinutes: number; initialUsd: number; targetUsd: number; market?: string; live?: boolean }): string {
  const market = a.market?.trim() || (!a.live && isFastMinutes(a.durationMinutes) ? DEFAULT_FAST_MARKET : FREE_MARKET);
  const num = (x: number) => String(Number(x.toFixed(1)));
  return `${market}-${num(a.durationMinutes)}m-+${num(((a.targetUsd - a.initialUsd) / a.initialUsd) * 100)}%`;
}

/** Lo contrario de missionClass: 'graduado-10m-+25%' → { market: 'graduado', minutes: 10, targetPct: 25 }. */
export function parseMissionClass(cls: string | null | undefined): { market: string; minutes: number; targetPct: number } | null {
  const m = cls?.match(/^([^-]+)-(\d+(?:\.\d+)?)m-\+(-?\d+(?:\.\d+)?)%$/);
  return m ? { market: m[1]!, minutes: Number(m[2]), targetPct: Number(m[3]) } : null;
}

/**
 * Colchón sobre el objetivo al calcular la toma de beneficio en el objetivo (takeProfitProceeds): el resto de costes (la
 * red y la renta de la venta y convertir el gas a estable al cerrar) ya se descuenta aparte, así que esto cubre redondeos
 * y lo que baje el precio del nativo mientras espera (ver takeProfitProceeds). Cada punto de más en la toma de beneficio
 * resta aciertos. Lo usan enter_with_exits y el gemelo mecánico (shadow.ts), que tiene que poner la misma.
 */
export const TP_TARGET_MARGIN = 0.001;

/**
 * Descuento sobre el precio del nativo (el gas que queda en la cartera) al contarlo para el objetivo: lo que cuesta
 * convertirlo al cerrar (la comisión del pool y la diferencia con el libro de Binance, con el que se valora). Lo aplican
 * igual la toma de beneficio en el objetivo (restAtCloseUsd) y checkMission (portfolio.ts, closingCostsUsd), así que no
 * cubre que el nativo baje mientras espera: eso lo cubre TP_TARGET_MARGIN (takeProfitProceeds).
 */
export const NATIVE_DRIFT_MARGIN = 0.005;

/**
 * Una toma de beneficio de tp_ratio que, al saltar, dejaría la cartera por debajo del objetivo pero a menos de esto (en
 * fracción del objetivo) se sube a la del objetivo: saltar y perder la misión por céntimos es la peor forma de perderla
 * (en la M3 de la v0.37.0 saltó en 60,91 $ con el gas en 1,46 $: 62,37 frente a 62,50). Más abajo es una decisión del
 * plan (p. ej. salir antes y reentrar) y se respeta.
 */
export const TP_LIFT_BAND = 0.02;

/**
 * Slippage de la compra de enter_with_exits si el plan no fija otro (slippage_bps): 300 = 3 %, el mismo que el del gemelo
 * mecánico. Es también el tope: una entrada no se fuerza subiéndolo. En la M18 (costes reales) la compra revirtió dos
 * veces con el precio moviéndose un 12 % en los 2 s de latencia; a la tercera, con el 25 %, entró, y el token cayó un 79 %.
 */
export const ENTRY_SLIPPAGE_BPS = 300;

/** El slippage máximo (y por defecto) de la entrada con un plan: el suyo o ENTRY_SLIPPAGE_BPS. */
export const entrySlippageBps = (plan?: { body: { slippage_bps?: number } }) => plan?.body.slippage_bps ?? ENTRY_SLIPPAGE_BPS;

/** La parte de la cartera que no es el token, tal como queda tras venderlo y al cerrar la misión. */
export interface RestAfterSale {
  /** Estables y todo lo que no es el token ni el nativo de su cadena, valorado ahora. */
  otherUsd: number;
  /** Nativo que queda tras la venta de la toma de beneficio (ya pagada su red y, si toca, su renta). */
  nativeAfterSale: number;
  /** Nativo que no llega a convertirse al cerrar la misión: la red de esa última venta. */
  closeFeeNative: number;
  /** Precio de venta real del nativo ahora (USD por unidad). */
  nativeUsd: number;
}

/**
 * Lo que vale como mínimo el resto de la cartera cuando se cierra la misión: el nativo, sin la red de convertirlo y con
 * su precio NATIVE_DRIFT_MARGIN más bajo. Es lo que se puede contar para llegar al objetivo.
 */
export const restAtCloseUsd = (r: RestAfterSale) => r.otherUsd + Math.max(0, r.nativeAfterSale - r.closeFeeNative) * r.nativeUsd * (1 - NATIVE_DRIFT_MARGIN);

/**
 * Lo que tiene que dar la venta de todo el token para que la cartera llegue al objetivo aunque el gas valga algo menos al
 * cerrar: objetivo × (1 + TP_TARGET_MARGIN) − lo que valdrá como mínimo el resto. checkMission mide el objetivo con las
 * mismas reglas (portfolio.ts, closingCostsUsd: la red de cada venta y el nativo convertido, con su precio
 * NATIVE_DRIFT_MARGIN más bajo): al llenarse, lo que quedaría al cerrar es objetivo × (1 + TP_TARGET_MARGIN), y la misión
 * se cierra conseguida, también tras convertir el gas (NATIVE_DRIFT_MARGIN cubre la comisión de convertirlo). Lo que
 * aguanta que baje el nativo entre poner la orden y que se llene es TP_TARGET_MARGIN × objetivo / el gas que queda: en
 * la misión por defecto (50 $ → 62,50 $, 1,5 $ de SOL), ~4 % con los costes de siempre y ~7 % con los realistas (queda
 * menos gas). Si baja más, se llena y la misión no llega: no se da por conseguida.
 */
export const takeProfitProceeds = (targetUsd: number, rest: RestAfterSale) => targetUsd * (1 + TP_TARGET_MARGIN) - restAtCloseUsd(rest);

/**
 * La toma de beneficio de un tp_ratio, subida a la del objetivo si se queda corta por poco (TP_LIFT_BAND). Devuelve lo que
 * dará la venta y, si se ha subido, lo que habría dejado la del ratio.
 */
export function liftTakeProfit(a: { ratioProceeds: number; targetUsd: number; rest: RestAfterSale }): { proceeds: number; liftedFromUsd?: number } {
  const after = a.ratioProceeds + restAtCloseUsd(a.rest);
  if (after < a.targetUsd && after >= a.targetUsd * (1 - TP_LIFT_BAND)) return { proceeds: takeProfitProceeds(a.targetUsd, a.rest), liftedFromUsd: after };
  return { proceeds: a.ratioProceeds };
}
