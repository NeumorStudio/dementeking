// Acceso HTTP compartido a las APIs de mercado. Evita saturarlas (el agente, el panel y el
// vigilante consultan los mismos precios): caché de pocos segundos, peticiones idénticas simultáneas agrupadas en una sola,
// un máximo de peticiones en paralelo por servicio y reintentos si el servicio pide esperar.
// Los servicios con límite por minuto (Jupiter) además se reparten turnos entre todos los procesos
// que usan la base de datos: cada sesión de Claude Code tiene su propio servidor MCP y todos salen
// por la misma IP.
import { db } from "../db.js";

/** Validez por defecto de una respuesta en caché. Corta: los precios tienen que ser del momento. */
export const DEFAULT_TTL_MS = 5_000;
const MAX_PARALLEL_PER_HOST = 6;
const MAX_RETRIES = 5;

/** Separación mínima entre peticiones a cada servicio, contando todos los procesos. */
const MIN_INTERVAL_MS: Record<string, number> = {
  "lite-api.jup.ag": 1_100,
  // KyberSwap admite unas 30 peticiones cada 10 s.
  "aggregator-api.kyberswap.com": 350,
  // GoPlus no publica su límite: se va despacio (sus respuestas se guardan en caché más tiempo).
  "api.gopluslabs.io": 2_000,
  // GeckoTerminal gratis: unas 30 peticiones por minuto. La usan a la vez el escaneo del trader y los
  // contrafactuales del revisor; sin turnos, el revisor se quedaba sin velas (HTTP 429).
  "api.geckoterminal.com": 2_100,
  // Binance limita por "peso" (6000 por minuto e IP); si se pasa, bloquea la IP (HTTP 418).
  "api.binance.com": 100,
};
/** Duración del bloqueo si el servicio no dice hasta cuándo. */
const DEFAULT_BAN_MS = 2 * 60_000;
/** Pausa común para todos cuando el servicio responde 429. */
const COOLDOWN_MS = 6_000;

db.exec("CREATE TABLE IF NOT EXISTS http_pacing (host TEXT PRIMARY KEY, next_at INTEGER NOT NULL)");
const reserveStmt = db.prepare(
  `INSERT INTO http_pacing (host, next_at) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET next_at = max(next_at, ?) + ?
   RETURNING next_at`,
);
// Turno de baja prioridad: solo si el siguiente está libre ya (nadie lo ha reservado); si no, no se reserva nada.
const takeFreeStmt = db.prepare(
  `INSERT INTO http_pacing (host, next_at) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET next_at = excluded.next_at WHERE http_pacing.next_at <= ?
   RETURNING next_at`,
);
const nextAtStmt = db.prepare("SELECT next_at FROM http_pacing WHERE host = ?");
const cooldownStmt = db.prepare(
  "INSERT INTO http_pacing (host, next_at) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET next_at = max(next_at, excluded.next_at)",
);

// Servicios que han bloqueado la IP (compartido entre procesos): no se les llama hasta que termine,
// porque insistir durante un bloqueo lo alarga.
db.exec("CREATE TABLE IF NOT EXISTS http_blocked (host TEXT PRIMARY KEY, until INTEGER NOT NULL)");
const blockedStmt = db.prepare("SELECT until FROM http_blocked WHERE host = ?");
const blockStmt = db.prepare(
  "INSERT INTO http_blocked (host, until) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET until = max(until, excluded.until)",
);

function banUntil(res: Response, body: string): number {
  const stated = Number(body.match(/banned until (\d{12,})/)?.[1]);
  if (Number.isFinite(stated) && stated > Date.now()) return stated;
  const retryAfter = Number(res.headers.get("retry-after"));
  return Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_BAN_MS);
}

/** Reserva el siguiente turno del servicio y espera a que llegue. */
async function pace(host: string) {
  const interval = MIN_INTERVAL_MS[host];
  if (!interval) return;
  const nowMs = Date.now();
  const { next_at } = reserveStmt.get(host, nowMs + interval, nowMs, interval) as { next_at: number };
  const slot = next_at - interval;
  if (slot > nowMs) await sleep(slot - nowMs);
}

/** Lo más que espera una petición de baja prioridad a que quede libre un turno antes de rendirse (HostBusyError). */
export const LOW_PRIORITY_MAX_WAIT_MS = 3_000;

/** El servicio está ocupado con peticiones de otros: una de baja prioridad se rinde en vez de hacer cola. */
export class HostBusyError extends Error {}

/**
 * Carril de baja prioridad (el gemelo mecánico, shadow.ts): no reserva un turno futuro, espera a que el siguiente
 * esté libre y solo entonces lo toma. Quien reserva de la forma normal (el agente) pasa siempre por delante: la de
 * baja prioridad nunca hace cola delante de él. Si nadie más pide, va igual de rápido.
 */
async function paceLow(host: string, maxWaitMs: number) {
  const interval = MIN_INTERVAL_MS[host];
  if (!interval) return;
  const until = Date.now() + maxWaitMs;
  for (;;) {
    const nowMs = Date.now();
    if (takeFreeStmt.get(host, nowMs + interval, nowMs)) return;
    const next = (nextAtStmt.get(host) as { next_at: number } | undefined)?.next_at ?? nowMs;
    if (next > until) throw new HostBusyError(`${host} está ocupado con otras peticiones: la de baja prioridad se deja para la siguiente vuelta`);
    await sleep(Math.max(20, next - nowMs));
  }
}
const MAX_CACHE_ENTRIES = 2_000;

interface Cached {
  expires: number;
  value: Promise<HttpResult>;
}
const cache = new Map<string, Cached>();

/** Respuesta: el código HTTP, el cuerpo y cuándo llegó (atMs: una respuesta de la caché conserva la hora de la petición). */
export interface HttpResult {
  status: number;
  body: string;
  atMs: number;
}

// Limitador de concurrencia por servicio (host).
const active = new Map<string, number>();
const waiting = new Map<string, Array<() => void>>();

async function acquire(host: string) {
  if ((active.get(host) ?? 0) >= MAX_PARALLEL_PER_HOST) {
    await new Promise<void>((resolve) => {
      const queue = waiting.get(host) ?? [];
      queue.push(resolve);
      waiting.set(host, queue);
    });
  }
  active.set(host, (active.get(host) ?? 0) + 1);
}

function release(host: string) {
  active.set(host, (active.get(host) ?? 1) - 1);
  waiting.get(host)?.shift()?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Los tests sustituyen fetch por respuestas fijas.
let fetchImpl: typeof fetch = (...args) => fetch(...args);
export function setFetchImpl(impl: typeof fetch) {
  fetchImpl = impl;
  cache.clear();
}

export interface RequestOpts {
  timeoutMs?: number;
  /** Validez en caché de una respuesta correcta. */
  ttlMs?: number;
  method?: "GET" | "POST";
  /** Cuerpo de un POST: se envía como JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Baja prioridad (el gemelo mecánico): solo usa turnos libres del servicio, sin hacer cola delante de nadie
   * (HostBusyError si no hay ninguno en LOW_PRIORITY_MAX_WAIT_MS), y no reintenta si el servicio pide esperar.
   */
  lowPriority?: boolean;
  /**
   * Sin reutilizar la caché: una respuesta de hace un momento no vale (la cotización de después de la latencia de las
   * misiones con costes realistas). La nueva sí se guarda, con su ttlMs.
   */
  fresh?: boolean;
}

async function request(url: string, opts: RequestOpts & { timeoutMs: number }): Promise<HttpResult> {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const blocked = (blockedStmt.get(host) as { until: number } | undefined)?.until ?? 0;
    if (blocked > Date.now()) {
      const hora = new Date(blocked).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      throw new Error(`${host} ha bloqueado temporalmente esta IP por exceso de peticiones (hasta las ${hora}); no se le llama hasta entonces`);
    }
    if (opts.lowPriority) await paceLow(host, LOW_PRIORITY_MAX_WAIT_MS);
    else await pace(host);
    await acquire(host);
    let res: Response;
    let body: string;
    try {
      res = await fetchImpl(url, {
        method: opts.method ?? "GET",
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      body = await res.text();
    } finally {
      release(host);
    }
    // IP bloqueada: se anota para todos los procesos y no se reintenta.
    if (res.status === 418) {
      blockStmt.run(host, banUntil(res, body));
      return { status: res.status, body, atMs: Date.now() };
    }
    // Demasiadas peticiones o servicio saturado: esperar y reintentar (una de baja prioridad no reintenta: la pausa
    // queda para todos igual, y ella vuelve en la siguiente vuelta).
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 15) * 1000 : COOLDOWN_MS;
      // Los servicios con turnos pausan a todos los procesos; el resto solo reintenta esta petición.
      if (MIN_INTERVAL_MS[host]) cooldownStmt.run(host, Date.now() + wait);
      if (opts.lowPriority) return { status: res.status, body, atMs: Date.now() };
      if (!MIN_INTERVAL_MS[host]) await sleep(wait);
      continue;
    }
    return { status: res.status, body, atMs: Date.now() };
  }
}

/**
 * Petición HTTP con caché compartida (GET o POST; en un POST la caché distingue por cuerpo).
 * Devuelve el código HTTP y el cuerpo en texto. Solo se guardan en caché las respuestas correctas;
 * los errores se reintentan en la siguiente llamada.
 */
export function fetchText(url: string, opts: RequestOpts = {}): Promise<HttpResult> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const key = opts.body !== undefined || opts.method === "POST" ? `${opts.method ?? "GET"} ${url} ${JSON.stringify(opts.body ?? null)}` : url;
  const nowMs = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > nowMs && !opts.fresh) return hit.value;

  const value = request(url, { ...opts, timeoutMs: opts.timeoutMs ?? 15_000 });
  cache.set(key, { expires: nowMs + ttl, value });
  value.then(
    (r) => {
      if (r.status < 200 || r.status >= 300) cache.delete(key);
    },
    () => cache.delete(key),
  );
  if (cache.size > MAX_CACHE_ENTRIES) {
    for (const [k, v] of cache) if (v.expires <= nowMs) cache.delete(k);
  }
  return value;
}

/**
 * ¿El agregador ha contestado que no hay ruta (el token no se puede vender), o solo ha fallado la red?
 * Lo primero es un dato: el token vale 0 ahora mismo. Lo segundo es transitorio.
 */
/** Fallo de red o de límite de peticiones: vuelve a intentarlo más tarde y probablemente funcione. */
export function isTransientError(err: unknown): boolean {
  return /HTTP (408|429|5\d\d)|timeout|timed out|aborted|fetch failed|ECONN|ENOTFOUND|Rate limit/i.test(String((err as Error)?.message ?? err));
}

export function isNoRouteError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  if (/HTTP (408|429|5\d\d)|timeout|timed out|aborted|fetch failed|ECONN|ENOTFOUND/i.test(msg)) return false;
  return /HTTP 40[04]|COULD_NOT_FIND|NO_ROUTE|No routes|not tradable|TOKEN_NOT_TRADABLE/i.test(msg);
}

export async function fetchJson<T = unknown>(url: string, timeoutMs?: number, ttlMs?: number): Promise<T>;
export async function fetchJson<T = unknown>(url: string, opts: RequestOpts): Promise<T>;
export async function fetchJson<T = unknown>(url: string, a: number | RequestOpts = {}, ttlMs?: number): Promise<T> {
  const opts: RequestOpts = typeof a === "number" ? { timeoutMs: a, ttlMs } : a;
  return (await fetchJsonAt<T>(url, opts)).data;
}

/** Como fetchJson, y además cuándo se pidió de verdad (atMs): si viene de la caché, la hora de la petición que la llenó. */
export async function fetchJsonAt<T = unknown>(url: string, opts: RequestOpts = {}): Promise<{ data: T; atMs: number }> {
  const { status, body, atMs } = await fetchText(url, opts);
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status} en ${url}: ${body.slice(0, 300)}`);
  return { data: JSON.parse(body) as T, atMs };
}

// ─── Cupos por ventana de tiempo ────────────────────────────────────────────
// Algunos servicios gratuitos limitan las peticiones por IP en ventanas largas (p. ej. Li.Fi: 75 cada 2 h).
// El cupo se comparte entre todos los procesos a través de la base de datos.
const budgetStmt = db.prepare(
  `INSERT INTO http_budget (host, window_start, used) VALUES (?, ?, 1)
   ON CONFLICT(host) DO UPDATE SET
     window_start = CASE WHEN window_start + ? <= ? THEN excluded.window_start ELSE window_start END,
     used = CASE WHEN window_start + ? <= ? THEN 1 ELSE used + 1 END
   RETURNING used`,
);

/** Reserva una petición del cupo de un servicio. Devuelve false si el cupo de la ventana actual está agotado. */
export function takeBudget(host: string, limit: number, windowMs: number): boolean {
  const nowMs = Date.now();
  const { used } = budgetStmt.get(host, nowMs, windowMs, nowMs, windowMs, nowMs) as { used: number };
  return used <= limit;
}
