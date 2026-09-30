// Vigilancia de fondo: órdenes (con transferencias y futuros) y misión. Cada cuánto depende de la misión:
// - misión corta con el reloj en marcha (15 min o menos): todo cada 5 s. Con la vuelta de cada minuto, el cierre
//   por tiempo y el objetivo llegaban hasta 60 s tarde, casi un 10 % de una misión de 10 min;
// - con órdenes por precio abiertas: las órdenes cada 15 s (un pico de un memecoin dura segundos) y la misión cada minuto;
// - si no: todo cada minuto.
// El gemelo mecánico (shadow.ts) va en un bucle aparte, cada 5 s mientras quede alguno en marcha (aunque la misión ya
// haya terminado): sus peticiones a GeckoTerminal pueden tardar decenas de segundos con un 429, y dentro de la misma
// vuelta retrasaban la revisión de la toma de beneficio del agente y del plazo (se midieron vueltas de 14-24 s).
// Jupiter admite una petición cada 1,1 s entre todos los procesos (market/http.ts). Por eso las vueltas no se solapan
// (la siguiente se programa al acabar la anterior) y nadie repite una vuelta que otro proceso acaba de hacer.
import { config } from "../config.js";
import { db, getMeta, setMeta } from "../db.js";
import { checkMission } from "./mission.js";
import { isShortMission } from "./mission-kind.js";
import { checkOrders } from "./orders.js";
import { checkShadows, shadowsRunning } from "./shadow.js";

export const PRICE_ORDERS_WATCH_SECONDS = 15;

/** Pausa mínima entre dos vueltas del bucle, aunque la anterior se haya alargado: deja turnos de Jupiter al agente. */
const MIN_GAP_MS = 1_500;

/** Margen para que el latido de 5 s no se salte una vuelta por unos milisegundos de retraso del temporizador. */
const SLACK_MS = 250;

export interface WatchState {
  /** Hay una misión corta (15 min o menos) con el reloj en marcha. */
  fastMission: boolean;
  /** Hay órdenes por precio abiertas en una misión con el reloj en marcha. */
  priceOrders: boolean;
}

export function currentWatchState(): WatchState {
  const running = db.prepare("SELECT created_at, deadline FROM missions WHERE status = 'active' AND started_at IS NOT NULL").all() as Array<{
    created_at: string;
    deadline: string;
  }>;
  const priceOrders = !!db
    .prepare(
      `SELECT 1 FROM orders o JOIN missions m ON m.id = o.mission_id
       WHERE o.status = 'open' AND o.condition != 'time' AND m.status = 'active' AND m.started_at IS NOT NULL LIMIT 1`,
    )
    .get();
  return { fastMission: running.some(isShortMission), priceOrders };
}

/** Cada cuántos segundos se revisa todo (órdenes, futuros y misión) y cada cuántos las órdenes. */
export function watchIntervals(s: WatchState, base = { full: config.watchIntervalSeconds, fast: config.fastWatchIntervalSeconds }) {
  if (s.fastMission) return { fullSeconds: base.fast, ordersSeconds: base.fast };
  return { fullSeconds: base.full, ordersSeconds: s.priceOrders ? Math.min(PRICE_ORDERS_WATCH_SECONDS, base.full) : base.full };
}

/** Qué toca ahora: 'full' (órdenes, futuros y misión), 'orders' (solo órdenes) o nada. */
export function dueWatchWork(
  s: WatchState & { nowMs: number; lastFullMs: number; lastOrdersMs: number },
  base?: { full: number; fast: number },
): "full" | "orders" | null {
  const { fullSeconds, ordersSeconds } = watchIntervals(s, base);
  if (s.nowMs - s.lastFullMs >= fullSeconds * 1000 - SLACK_MS) return "full";
  if (s.nowMs - Math.max(s.lastFullMs, s.lastOrdersMs) >= ordersSeconds * 1000 - SLACK_MS) return "orders";
  return null;
}

const LAST_TICK_KEY = "watch_tick_at";
let inFlight: Promise<string[]> | null = null;

/**
 * Una vuelta completa: órdenes (con transferencias y futuros) y misión; el gemelo va aparte (shadowTick). Las llamadas
 * simultáneas del mismo proceso comparten la vuelta en curso. Con skipIfFresherMs no hace nada si alguien (este proceso
 * u otro) hizo una que empezó hace menos de eso. Los errores vuelven como líneas que empiezan por "Error".
 */
export function watchTick(opts: { skipIfFresherMs?: number } = {}): Promise<string[]> {
  if (inFlight) return inFlight;
  if (opts.skipIfFresherMs && Date.now() - Number(getMeta(LAST_TICK_KEY) ?? 0) < opts.skipIfFresherMs) return Promise.resolve([]);
  inFlight = (async () => {
    // Se guarda cuándo empezó (lo que ha visto es de ese momento), y solo si llega al final.
    const startedAt = Date.now();
    const log = await checkOrders().catch((err) => [`Error revisando órdenes: ${(err as Error).message}`]);
    log.push(...(await checkMission().catch((err) => [`Error revisando la misión: ${(err as Error).message}`])));
    setMeta(LAST_TICK_KEY, String(startedAt));
    return log;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let shadowInFlight: Promise<string[]> | null = null;

/** Una vuelta de los gemelos mecánicos, con su propio turno: nunca retrasa la de órdenes y misión. */
export function shadowTick(): Promise<string[]> {
  if (shadowInFlight) return shadowInFlight;
  shadowInFlight = checkShadows()
    .catch((err) => [`Error revisando el gemelo: ${(err as Error).message}`])
    .finally(() => {
      shadowInFlight = null;
    });
  return shadowInFlight;
}

/**
 * Bucle de vigilancia: late cada pocos segundos y hace lo que toque según dueWatchWork. Al lado, el bucle de los
 * gemelos (cada 5 s mientras quede alguno). canRun decide si este proceso trabaja en esta vuelta (el servidor MCP:
 * solo quien tiene el turno). Devuelve la función que para los dos.
 */
export function startWatchLoop(opts: { canRun?: () => boolean; log?: (line: string) => void } = {}): () => void {
  const heartbeatMs = Math.max(1, Math.min(config.fastWatchIntervalSeconds, PRICE_ORDERS_WATCH_SECONDS, config.watchIntervalSeconds)) * 1000;
  // Como un setInterval: la primera vuelta completa llega pasado su intervalo, no al arrancar.
  let lastFullMs = Date.now();
  let lastOrdersMs = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const beat = async () => {
    const started = Date.now();
    try {
      if (opts.canRun?.() ?? true) {
        const state = currentWatchState();
        const work = dueWatchWork({ ...state, nowMs: started, lastFullMs, lastOrdersMs });
        if (work === "full") {
          lastFullMs = started;
          const { fullSeconds } = watchIntervals(state);
          for (const line of await watchTick({ skipIfFresherMs: fullSeconds * 1000 - 1_000 })) opts.log?.(line);
        } else if (work === "orders") {
          lastOrdersMs = started;
          for (const line of await checkOrders().catch((err) => [`Error revisando órdenes: ${(err as Error).message}`])) opts.log?.(line);
        }
      }
    } catch (err) {
      opts.log?.(`Error en la vigilancia: ${(err as Error).message}`);
    }
    if (!stopped) timer = setTimeout(beat, Math.max(MIN_GAP_MS, heartbeatMs - (Date.now() - started)));
  };
  timer = setTimeout(beat, heartbeatMs);

  // Los gemelos: al ritmo de las órdenes del agente en una misión rápida, sin compartir vuelta con ellas.
  const shadowMs = Math.max(1, config.fastWatchIntervalSeconds) * 1000;
  let shadowTimer: ReturnType<typeof setTimeout> | undefined;
  const shadowBeat = async () => {
    const started = Date.now();
    try {
      if ((opts.canRun?.() ?? true) && shadowsRunning()) for (const line of await shadowTick()) opts.log?.(line);
    } catch (err) {
      opts.log?.(`Error en la vigilancia del gemelo: ${(err as Error).message}`);
    }
    if (!stopped) shadowTimer = setTimeout(shadowBeat, Math.max(MIN_GAP_MS, shadowMs - (Date.now() - started)));
  };
  shadowTimer = setTimeout(shadowBeat, shadowMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(shadowTimer);
  };
}

/** Esperas de `wait`: en una misión rápida, desde 15 s y mirando cada 5 s; en una larga, desde 1 min y cada 20 s. */
export const WAIT_MIN_MINUTES = 0.25;
const LONG_WAIT_MIN_MINUTES = 1;
const FAST_WAIT_POLL_MS = 5_000;
const LONG_WAIT_POLL_MS = 20_000;

export function waitTiming(requestedMinutes: number, fast: boolean): { minutes: number; pollMs: number } {
  return fast
    ? { minutes: Math.max(WAIT_MIN_MINUTES, requestedMinutes), pollMs: FAST_WAIT_POLL_MS }
    : { minutes: Math.max(LONG_WAIT_MIN_MINUTES, requestedMinutes), pollMs: LONG_WAIT_POLL_MS };
}
