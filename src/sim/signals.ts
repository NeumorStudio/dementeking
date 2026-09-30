// Señal de entrada de las misiones rápidas, sin gastar turnos del LLM: wait_for_signal sondea la fuente de eventos del
// plan cada 5 s y devuelve el primer token que pasa sus filtros mecánicos y tiene cotización de compra y de venta en
// Jupiter. Esperar antes de arrancar el reloj es legítimo (operar no): por eso funciona sin reloj.
//
// Fuente graduado: tokens de pump.fun recién migrados a su pool de PumpSwap, vistos en new_pools de GeckoTerminal (la
// fuente del estudio). Medido en vivo el 30-sep-2026:
// - GeckoTerminal sirve new_pools desde su CDN, que se renueva cada ~60 s (s-maxage=60): un pool aparece con 12-70 s
//   de vida. La página 1 (20 pools) abarca solo 25-45 s, porque la llenan los lanzamientos de la curva de pump.fun; la 2
//   cubre el hueco entre dos renovaciones.
// - Limita por IP bastante por debajo de las 30 peticiones/min que anuncia: pidiendo cada 5 s, una de cada dos daba 429.
//   Por eso la página 1 se pide como mucho cada 15 s y la 2 cada 30 (la caché HTTP reparte lo último a las demás vueltas).
// - En PumpSwap también abren pool tokens de otros launchpads (se vio uno de Meteora DBC con sufijo "pump"): el
//   launchpad se comprueba con Jupiter, que además da los decimales y la hora de la graduación.
// - La API de pump.fun (coins con complete=true) respondió 429 a la primera: no sirve para sondear.
// - Jupiter cotizó compra y venta de un pool con 49 s de vida (ida y vuelta de 48,5 $: un 1,5 %).
import { fetchJson, HostBusyError } from "../market/http.js";
import { fromBaseUnits, getQuote, SOL_MINT, toBaseUnits, USDC_MINT } from "../market/jupiter.js";
import type { PlanFilters, SignalSource } from "./plans.js";

const GECKO_NEW_POOLS = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools";
const JUPITER_SEARCH = "https://lite-api.jup.ag/tokens/v2/search";

/** Edad máxima por defecto del pool: el estudio compra 1-2 min después de la migración (cada minuto de más, −3-4 puntos de P). */
export const DEFAULT_MAX_POOL_AGE_MINUTES = 2;

/**
 * Filtros mecánicos por defecto, también los del gemelo (shadow.ts); el plan puede cambiarlos. Sin ellos, el primer
 * candidato de una prueba en vivo fue un pool ya vaciado (5,71 $ de liquidez, ida y vuelta del 97 %: la misión perdió casi
 * todo al entrar). Un recién graduado de pump.fun migra con decenas de miles de dólares de liquidez, y su ida y vuelta
 * con 50 $ ronda el 1-3 %.
 */
export const DEFAULT_MIN_LIQUIDITY_USD = 1_000;
export const DEFAULT_MAX_ROUND_TRIP_COST_PCT = 10;
/** Con una ida y vuelta de más de esto el pool está vaciado: no se vuelve a mirar. */
const DEAD_POOL_ROUND_TRIP_PCT = 50;

export interface SignalTiming {
  /** Cada cuánto se revisa todo (fuentes, candidatos pendientes, estado de la misión). */
  pollMs: number;
  /** Validez de cada página de new_pools (1 y 2): no se piden más a menudo. */
  geckoPageTtlMs: [number, number];
  /** Cada cuánto se vuelve a preguntar a Jupiter por un token de la lista corta o por un candidato sin ruta todavía. */
  recheckMs: number;
  /** Candidatos que se cotizan como mucho en cada vuelta (3 peticiones a Jupiter cada uno, a 1,1 s). */
  maxChecksPerPoll: number;
}

export const SIGNAL_TIMING: SignalTiming = { pollMs: 5_000, geckoPageTtlMs: [15_000, 30_000], recheckMs: 10_000, maxChecksPerPoll: 3 };

export interface SignalCandidate {
  token: string;
  symbol?: string;
  name?: string;
  /** Dónde se vio: en new_pools de GeckoTerminal o graduándose en la lista corta del plan. */
  detectedBy: "geckoterminal" | "shortlist";
  inShortlist: boolean;
  pool?: string;
  poolAgeSeconds?: number;
  launchpad?: string;
  graduatedAgoSeconds?: number;
  liquidityUsd?: number;
  fdvUsd?: number;
  buys5m?: number;
  sells5m?: number;
  buyers5m?: number;
  volume5mUsd?: number;
  priceChange5mPct?: number;
  /** Comprar con usdIn y vender al momento lo recibido (cotizaciones de Jupiter). */
  quote?: { usdIn: number; tokensOut: number; backUsd: number; roundTripCostPct: number };
}

export interface SignalResult {
  found: boolean;
  candidate?: SignalCandidate;
  waitedSeconds: number;
  polls: number;
  /** Pools de PumpSwap frescos (o graduaciones de la lista corta) vistos durante la espera. */
  seen: number;
  /** Por qué se descartó cada token visto (el último motivo), contado por motivo. */
  rejected: Record<string, number>;
  /** Por qué volvió antes sin candidato (p. ej. la misión ya no está activa). */
  stopped?: string;
  /** Lecturas de la fuente que fallaron (GeckoTerminal con 429 o caído): sin esto, "no hubo eventos" y "no se pudo mirar" se confunden. */
  sourceErrors?: SourceErrors;
}

export interface SourceErrors {
  source: string;
  reads: number;
  failed: number;
  /** Por código HTTP (o "sin respuesta"). */
  byReason: Record<string, number>;
}

/** Motivo corto de un fallo de la fuente: el código HTTP si lo hay. */
function failureReason(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  const code = msg.match(/HTTP (\d{3})/)?.[1];
  return code ?? (/timeout|timed out|aborted/i.test(msg) ? "sin respuesta" : "error de red");
}

/** Resumen de una línea de los fallos de la fuente, o "" si no hubo. */
export function describeSourceErrors(e: SourceErrors | undefined): string {
  if (!e?.failed) return "";
  const why = Object.entries(e.byReason)
    .map(([r, n]) => `${r} ×${n}`)
    .join(", ");
  return e.failed >= e.reads
    ? `⚠ ${e.source} no ha respondido en toda la espera (${why}): no se sabe si hubo eventos.`
    : `${e.source} falló ${e.failed} de ${e.reads} veces (${why}).`;
}

interface PoolInfo {
  pool: string;
  token: string;
  name?: string;
  createdMs: number;
  liquidityUsd?: number;
  fdvUsd?: number;
  buys5m?: number;
  sells5m?: number;
  buyers5m?: number;
  volume5mUsd?: number;
  priceChange5mPct?: number;
}

const num = (v: unknown): number | undefined => {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
};
const stripNetwork = (id: unknown) => String(id ?? "").replace(/^solana_/, "");

/** Los pools de PumpSwap de una página de new_pools, con el token (el lado que no es SOL). */
export function pumpSwapPools(data: unknown): PoolInfo[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((p: any): PoolInfo[] => {
    if (p?.relationships?.dex?.data?.id !== "pumpswap") return [];
    const base = stripNetwork(p.relationships?.base_token?.data?.id);
    const quote = stripNetwork(p.relationships?.quote_token?.data?.id);
    const token = quote === SOL_MINT ? base : base === SOL_MINT ? quote : "";
    const a = p.attributes ?? {};
    const createdMs = Date.parse(a.pool_created_at);
    if (!token || !Number.isFinite(createdMs)) return [];
    return [
      {
        pool: String(a.address ?? p.id),
        token,
        name: a.name,
        createdMs,
        liquidityUsd: num(a.reserve_in_usd),
        fdvUsd: num(a.fdv_usd),
        buys5m: num(a.transactions?.m5?.buys),
        sells5m: num(a.transactions?.m5?.sells),
        buyers5m: num(a.transactions?.m5?.buyers),
        volume5mUsd: num(a.volume_usd?.m5),
        priceChange5mPct: num(a.price_change_percentage?.m5),
      },
    ];
  });
}

/**
 * Filtros del plan que se ven en los datos del pool (sin pedir nada). Devuelve el motivo del descarte o null.
 * Lo que falta en los datos no descarta: es desconocido, no cero.
 */
export function poolRejection(p: PoolInfo, f: PlanFilters, nowMs: number): string | null {
  const maxAge = f.max_pool_age_minutes ?? DEFAULT_MAX_POOL_AGE_MINUTES;
  if (nowMs - p.createdMs > maxAge * 60_000) return `pool de más de ${maxAge} min`;
  const below = (v: number | undefined, min: number | undefined) => min !== undefined && v !== undefined && v < min;
  const above = (v: number | undefined, max: number | undefined) => max !== undefined && v !== undefined && v > max;
  if (below(p.liquidityUsd, f.min_liquidity_usd)) return "liquidez por debajo del mínimo";
  if (above(p.liquidityUsd, f.max_liquidity_usd)) return "liquidez por encima del máximo";
  if (below(p.fdvUsd, f.min_fdv_usd)) return "FDV por debajo del mínimo";
  if (above(p.fdvUsd, f.max_fdv_usd)) return "FDV por encima del máximo";
  if (below(p.buys5m, f.min_buys_5m)) return "pocas compras en 5 min";
  if (below(p.buyers5m, f.min_buyers_5m)) return "pocos compradores en 5 min";
  if (f.min_buy_sell_ratio_5m !== undefined && p.buys5m !== undefined && p.sells5m !== undefined && p.buys5m < f.min_buy_sell_ratio_5m * Math.max(1, p.sells5m)) {
    return "proporción compras/ventas por debajo del mínimo";
  }
  if (below(p.volume5mUsd, f.min_volume_5m_usd)) return "poco volumen en 5 min";
  if (below(p.priceChange5mPct, f.min_price_change_5m_pct)) return "variación de 5 min por debajo del mínimo";
  if (above(p.priceChange5mPct, f.max_price_change_5m_pct)) return "variación de 5 min por encima del máximo";
  return null;
}

interface TokenMeta {
  symbol?: string;
  name?: string;
  decimals?: number;
  launchpad?: string;
  graduatedAtMs?: number;
}

/** Datos del token en Jupiter (la misma búsqueda que usa el simulador para resolverlo). */
async function tokenMeta(mint: string, ttlMs: number, lowPriority?: boolean): Promise<TokenMeta | null> {
  const list = await fetchJson<Array<Record<string, any>>>(`${JUPITER_SEARCH}?query=${encodeURIComponent(mint)}`, { timeoutMs: 15_000, ttlMs, lowPriority });
  const t = list.find((x) => x.id === mint);
  if (!t) return null;
  const graduatedAtMs = t.graduatedAt ? Date.parse(t.graduatedAt) : NaN;
  return {
    symbol: t.symbol,
    name: t.name,
    decimals: typeof t.decimals === "number" ? t.decimals : undefined,
    launchpad: typeof t.launchpad === "string" ? t.launchpad : undefined,
    graduatedAtMs: Number.isFinite(graduatedAtMs) ? graduatedAtMs : undefined,
  };
}

/** Un fallo que no es un dato: Jupiter ocupado con peticiones del agente (carril de baja prioridad). Se repite en la siguiente vuelta. */
const rethrowBusy = (err: unknown) => {
  if (err instanceof HostBusyError) throw err;
  return null;
};

/** Qué pasa con un token que se comprueba: pasa, se descarta para siempre o se vuelve a mirar más tarde. */
type Check = { ok: true; candidate: SignalCandidate; decimals: number; tokensOutRaw: string } | { ok: false; reason: string; retry: boolean };

/** Un candidato que pasa los filtros, con lo que hace falta para seguir su precio (el gemelo mecánico, shadow.ts). */
export interface ScannerHit {
  candidate: SignalCandidate;
  decimals: number;
  /** Tokens que da la compra cotizada, en unidades base (lo que se vende después). */
  tokensOutRaw: string;
}

/**
 * El detector de la señal, vuelta a vuelta. Lo usan wait_for_signal, que espera en bucle, y el gemelo mecánico
 * (shadow.ts), que da una vuelta en cada tick de la vigilancia de fondo con las peticiones a Jupiter que le quepan.
 * Recuerda entre vueltas los pools vistos, lo descartado y cuándo se miró cada token.
 */
export class SignalScanner {
  readonly timing: SignalTiming;
  private readonly filters: PlanFilters;
  private readonly maxAgeMs: number;
  private readonly shortlist: Set<string>;
  private readonly excluded: Set<string>;
  private readonly pools = new Map<string, PoolInfo>(); // por token: el pool más reciente
  private readonly graduated = new Map<string, TokenMeta>(); // tokens de la lista corta ya graduados
  private readonly lastChecked = new Map<string, number>();
  private readonly verdicts = new Map<string, string>(); // token → último motivo de descarte
  private readonly dropped = new Set<string>(); // descartados para siempre
  private readonly seen = new Set<string>();
  private readonly pageRetryAt: number[] = []; // tras un fallo, cada página no se vuelve a pedir hasta que tocaría renovarla
  private readonly sourceErrors: SourceErrors = { source: "GeckoTerminal", reads: 0, failed: 0, byReason: {} };

  constructor(
    private readonly opts: {
      source: SignalSource;
      filters: PlanFilters;
      shortlist?: string[];
      usdAmount: number;
      exclude?: string[];
      timing?: Partial<SignalTiming>;
      /** Solo turnos libres de las APIs, sin hacer cola delante del agente (el gemelo mecánico). */
      lowPriority?: boolean;
      /** Última palabra sobre un candidato que pasa los filtros: devuelve el motivo para descartarlo, o null. */
      accept?: (c: SignalCandidate) => Promise<string | null>;
    },
  ) {
    this.timing = { ...SIGNAL_TIMING, ...opts.timing };
    const own = Object.fromEntries(Object.entries(opts.filters).filter(([, v]) => v !== undefined)) as PlanFilters;
    // En graduado, por defecto solo lo que viene de pump.fun (el mercado medido); el plan puede ampliarlo con launchpads: [].
    this.filters = {
      launchpads: opts.source === "graduado" ? ["pump.fun"] : undefined,
      min_liquidity_usd: DEFAULT_MIN_LIQUIDITY_USD,
      max_round_trip_cost_pct: DEFAULT_MAX_ROUND_TRIP_COST_PCT,
      ...own,
    };
    this.maxAgeMs = (this.filters.max_pool_age_minutes ?? DEFAULT_MAX_POOL_AGE_MINUTES) * 60_000;
    this.shortlist = new Set(opts.shortlist ?? []);
    this.excluded = new Set(opts.exclude ?? []);
  }

  /** Tokens que ya no se devuelven (p. ej. los que ha comprado el agente o ya tiene el gemelo). */
  exclude(tokens: Iterable<string>) {
    for (const t of tokens) this.excluded.add(t);
  }

  /** Tokens frescos vistos y por qué se descartó cada uno (el último motivo), contado por motivo. */
  summary(except?: string): { seen: number; rejected: Record<string, number>; sourceErrors?: SourceErrors } {
    const rejected: Record<string, number> = {};
    for (const [token, reason] of this.verdicts) if (token !== except) rejected[reason] = (rejected[reason] ?? 0) + 1;
    const e = this.sourceErrors;
    return { seen: this.seen.size, rejected, ...(e.failed ? { sourceErrors: { ...e, byReason: { ...e.byReason } } } : {}) };
  }

  /** Pide a Jupiter los datos del token y cotiza comprarlo y venderlo al momento con el capital de la misión. */
  private async check(token: string, pool: PoolInfo | undefined, meta0: TokenMeta | undefined): Promise<Check> {
    const { filters, opts } = this;
    const meta = meta0 ?? (await tokenMeta(token, this.timing.recheckMs, opts.lowPriority).catch(rethrowBusy));
    if (!meta || meta.decimals === undefined) return { ok: false, reason: "Jupiter aún no conoce el token", retry: true };
    if (filters.launchpads?.length) {
      if (!meta.launchpad) return { ok: false, reason: "launchpad desconocido todavía", retry: true };
      if (!filters.launchpads.includes(meta.launchpad)) return { ok: false, reason: `launchpad ${meta.launchpad}`, retry: false };
    }
    let tokensOut: number, backUsd: number, tokensOutRaw: string;
    try {
      const buy = await getQuote(USDC_MINT, token, toBaseUnits(opts.usdAmount, 6), 300, 1, { lowPriority: opts.lowPriority });
      tokensOut = fromBaseUnits(buy.outAmount, meta.decimals);
      tokensOutRaw = String(buy.outAmount);
      if (!(tokensOut > 0)) return { ok: false, reason: "sin ruta de compra en Jupiter", retry: true };
      const sell = await getQuote(token, USDC_MINT, BigInt(buy.outAmount), 300, 1, { lowPriority: opts.lowPriority });
      backUsd = fromBaseUnits(sell.outAmount, 6);
    } catch (err) {
      rethrowBusy(err);
      // Jupiter tarda a veces en indexar un pool recién creado: se vuelve a probar mientras siga fresco.
      return { ok: false, reason: "sin cotización de compra y venta en Jupiter todavía", retry: true };
    }
    const roundTripCostPct = Number(((1 - backUsd / opts.usdAmount) * 100).toFixed(2));
    if (filters.max_round_trip_cost_pct !== undefined && roundTripCostPct > filters.max_round_trip_cost_pct) {
      return roundTripCostPct >= DEAD_POOL_ROUND_TRIP_PCT
        ? { ok: false, reason: `pool vaciado (ida y vuelta de más del ${DEAD_POOL_ROUND_TRIP_PCT} %)`, retry: false }
        : { ok: false, reason: `ida y vuelta de más del ${filters.max_round_trip_cost_pct} %`, retry: true };
    }
    const nowMs = Date.now();
    return {
      ok: true,
      decimals: meta.decimals,
      tokensOutRaw,
      candidate: {
        token,
        symbol: meta.symbol,
        name: meta.name,
        detectedBy: pool ? "geckoterminal" : "shortlist",
        inShortlist: this.shortlist.has(token),
        ...(pool
          ? {
              pool: pool.pool,
              poolAgeSeconds: Math.round((nowMs - pool.createdMs) / 1000),
              liquidityUsd: pool.liquidityUsd,
              fdvUsd: pool.fdvUsd,
              buys5m: pool.buys5m,
              sells5m: pool.sells5m,
              buyers5m: pool.buyers5m,
              volume5mUsd: pool.volume5mUsd,
              priceChange5mPct: pool.priceChange5mPct,
            }
          : {}),
        launchpad: meta.launchpad,
        ...(meta.graduatedAtMs ? { graduatedAgoSeconds: Math.round((nowMs - meta.graduatedAtMs) / 1000) } : {}),
        quote: { usdIn: opts.usdAmount, tokensOut, backUsd, roundTripCostPct },
      },
    };
  }

  /**
   * Una vuelta: lee las fuentes, arma la cola de candidatos y cotiza en Jupiter como mucho maxChecks (3 peticiones
   * cada uno; con 0, solo pone al día lo visto). Devuelve el primero que pasa, o null.
   */
  async poll(maxChecks = this.timing.maxChecksPerPoll): Promise<ScannerHit | null> {
    const { opts, timing, filters, maxAgeMs, shortlist, pools, graduated, lastChecked, verdicts, dropped, seen } = this;
    const exclude = this.excluded;
    const nowMs = Date.now();

    // 1. Fuentes. new_pools solo en graduado (en shortlist bastan las graduaciones que da Jupiter).
    if (opts.source === "graduado") {
      for (const [i, ttl] of timing.geckoPageTtlMs.entries()) {
        if (nowMs < (this.pageRetryAt[i] ?? 0)) continue;
        this.sourceErrors.reads++;
        const url = `${GECKO_NEW_POOLS}?page=${i + 1}`;
        const page = await fetchJson<{ data?: unknown }>(url, { timeoutMs: 15_000, ttlMs: ttl, lowPriority: opts.lowPriority }).catch((err) => {
          if (err instanceof HostBusyError) {
            this.sourceErrors.reads--;
            return null;
          }
          // Se cuenta (el resumen lo dice) y no se insiste hasta que tocaría renovarla: con un 429, insistir lo alarga.
          const why = failureReason(err);
          this.sourceErrors.failed++;
          this.sourceErrors.byReason[why] = (this.sourceErrors.byReason[why] ?? 0) + 1;
          this.pageRetryAt[i] = Date.now() + ttl;
          return null;
        });
        for (const p of pumpSwapPools(page?.data)) {
          const prev = pools.get(p.token);
          if (!prev || p.createdMs >= prev.createdMs) pools.set(p.token, p);
        }
      }
    }
    for (const mint of shortlist) {
      if (graduated.has(mint) || exclude.has(mint) || dropped.has(mint) || nowMs - (lastChecked.get(`lista:${mint}`) ?? 0) < timing.recheckMs) continue;
      lastChecked.set(`lista:${mint}`, nowMs);
      const meta = await tokenMeta(mint, timing.recheckMs, opts.lowPriority).catch((err) => (err instanceof HostBusyError ? undefined : null));
      if (meta === undefined) {
        lastChecked.delete(`lista:${mint}`);
        break;
      }
      if (!meta?.graduatedAtMs) continue;
      if (Date.now() - meta.graduatedAtMs > maxAgeMs) {
        verdicts.set(mint, `se graduó hace más de ${maxAgeMs / 60_000} min`);
        dropped.add(mint);
        continue;
      }
      graduated.set(mint, meta);
    }

    // 2. Candidatos: primero la lista corta, después los pools más recientes.
    const queue: Array<{ token: string; pool?: PoolInfo; meta?: TokenMeta }> = [];
    for (const [token, meta] of graduated) {
      if (exclude.has(token) || dropped.has(token)) continue;
      if (Date.now() - meta.graduatedAtMs! > maxAgeMs) {
        verdicts.set(token, verdicts.get(token) ?? `se graduó hace más de ${maxAgeMs / 60_000} min`);
        dropped.add(token);
        continue;
      }
      queue.push({ token, pool: pools.get(token), meta });
    }
    const fresh = [...pools.values()].filter((p) => !exclude.has(p.token) && !dropped.has(p.token) && !graduated.has(p.token));
    fresh.sort((a, b) => Number(shortlist.has(b.token)) - Number(shortlist.has(a.token)) || b.createdMs - a.createdMs);
    for (const p of fresh) {
      if (opts.source === "shortlist" && !shortlist.has(p.token)) continue;
      if (Date.now() - p.createdMs <= maxAgeMs) seen.add(p.token);
      const reason = poolRejection(p, filters, Date.now());
      if (reason) {
        // Si solo se ha hecho viejo, no se cuenta como descarte (nunca llegó a mirarse).
        if (seen.has(p.token)) verdicts.set(p.token, reason);
        if (Date.now() - p.createdMs > maxAgeMs) dropped.add(p.token);
        continue;
      }
      queue.push({ token: p.token, pool: p });
    }
    for (const q of queue) seen.add(q.token);

    // 3. Jupiter: datos del token y cotizaciones, como mucho maxChecks por vuelta.
    let checks = 0;
    for (const q of queue) {
      if (checks >= maxChecks) break;
      if (Date.now() - (lastChecked.get(q.token) ?? 0) < timing.recheckMs) continue;
      lastChecked.set(q.token, Date.now());
      checks++;
      let r: Check;
      try {
        r = await this.check(q.token, q.pool, q.meta);
        if (r.ok && opts.accept) {
          const veto = await opts.accept(r.candidate);
          if (veto) r = { ok: false, reason: veto, retry: false };
        }
      } catch (err) {
        // Jupiter ocupado (baja prioridad): este token se mira en la siguiente vuelta.
        if (!(err instanceof HostBusyError)) throw err;
        lastChecked.delete(q.token);
        return null;
      }
      if (r.ok) return { candidate: r.candidate, decimals: r.decimals, tokensOutRaw: r.tokensOutRaw };
      verdicts.set(q.token, r.reason);
      if (!r.retry) dropped.add(q.token);
    }
    return null;
  }
}

/**
 * Espera a la señal. Vuelve con el primer candidato que pase los filtros, al acabarse maxMinutes o cuando
 * shouldStop devuelva un motivo (la misión ya no está activa).
 */
export async function waitForSignal(opts: {
  source: SignalSource;
  filters: PlanFilters;
  shortlist?: string[];
  usdAmount: number;
  maxMinutes: number;
  exclude?: string[];
  shouldStop?: () => string | null;
  timing?: Partial<SignalTiming>;
  accept?: (c: SignalCandidate) => Promise<string | null>;
}): Promise<SignalResult> {
  const scanner = new SignalScanner(opts);
  const started = Date.now();
  const until = started + opts.maxMinutes * 60_000;
  let polls = 0;
  const done = (extra: Partial<SignalResult>): SignalResult => ({
    found: false,
    waitedSeconds: Math.round((Date.now() - started) / 1000),
    polls,
    ...scanner.summary(extra.candidate?.token),
    ...extra,
  });
  for (;;) {
    polls++;
    const stop = opts.shouldStop?.();
    if (stop) return done({ stopped: stop });
    const hit = await scanner.poll();
    if (hit) return { ...done({ candidate: hit.candidate }), found: true };
    const left = until - Date.now();
    if (left <= 0) return done({});
    await new Promise((r) => setTimeout(r, Math.min(scanner.timing.pollMs, left)));
  }
}
