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
 * Margen sobre el objetivo al calcular la toma de beneficio: cubre la red de la venta y lo que se mueva el precio del
 * nativo (el gas) mientras espera. La renta de la cuenta del token, que se recupera al venderlo todo, no se cuenta.
 * Lo usan enter_with_exits y el gemelo mecánico (shadow.ts), que tiene que poner la misma toma de beneficio.
 */
export const TP_TARGET_MARGIN = 0.003;
