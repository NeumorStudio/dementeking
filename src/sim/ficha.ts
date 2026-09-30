// Ficha de entrada de las misiones rápidas: lo que se sabía del token en el momento de entrar, del agente (enter_with_exits)
// y de cada gemelo mecánico, con los mismos campos para los dos. Con ella y el resultado medido con velas (candles.ts),
// el planner busca filtros con evidencia (entry_dataset): p. ej. si los que se gradúan con millones de mcap se quedan
// planos, o si los de pocos holders acaban en rug.
//
// Sale de lo que ya se ha pedido al detectar el evento (sin peticiones de más): la fila del pool en new_pools de
// GeckoTerminal y la búsqueda de tokens v2 de Jupiter (la que da el launchpad y los decimales). Si el agente entra en un
// token que no le dio wait_for_signal, solo lleva lo de Jupiter (una búsqueda que la compra suele dejar en caché).
// Lo que falta en los datos no sale (desconocido, no cero). Sin dependencias: la usan signals.ts, shadow.ts y entry.ts.
//
// Edad de los datos, por fuente, a la hora de entrar: geckoAgeS (desde que se pidió la página de new_pools de la que sale
// la fila; GeckoTerminal además la sirve de su CDN, renovada cada ~60 s, así que puede ser hasta un minuto más vieja) y
// jupAgeS (desde que se pidió a Jupiter, caché incluida). dataAgeS es la de lo más antiguo de la ficha: la fila de
// new_pools se conserva mientras Jupiter no conoce el token, aunque el pool ya no salga en las páginas, y sus compras y
// volumen de 5 min pueden ser de una lectura anterior.

export type FichaValue = number | string | boolean;
/** La ficha tal como se guarda: plana, con las edades calculadas a la hora de la entrada. */
export type Ficha = Record<string, FichaValue>;

/** Lo leído al detectar el evento, antes de entrar: las edades se calculan después, a la hora de la entrada (fichaAt). */
export interface EntrySnapshot {
  /** Cuándo se juntaron los datos (ms): la cotización de ida y vuelta es de este momento. */
  capturedAtMs: number;
  /** Cuándo se pidió la página de new_pools de la que sale lo de GeckoTerminal (ms). */
  geckoAtMs?: number;
  /** Cuándo se pidió a Jupiter lo del token (ms). */
  jupiterAtMs?: number;
  /** Pool de PumpSwap: el de new_pools o, si no, el graduatedPool de Jupiter. */
  pool?: string;
  poolCreatedMs?: number;
  graduatedAtMs?: number;
  tokenCreatedMs?: number;
  values: Ficha;
}

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const num = (v: unknown): number | undefined => {
  const x = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
};
const round = (v: number | undefined, d = 2) => (v === undefined ? undefined : Number(v.toFixed(d)));
const time = (v: unknown) => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

/** Quita lo que no se sabe: la ficha solo lleva lo que vino en los datos. */
function compact(o: Record<string, FichaValue | undefined>): Ficha {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as Ficha;
}

/** Lo del pool en new_pools de GeckoTerminal (sus `attributes`). */
export function geckoValues(a: Record<string, any> | undefined): Ficha {
  if (!a) return {};
  return compact({
    reserveUsd: round(num(a.reserve_in_usd), 0),
    fdvUsd: round(num(a.fdv_usd), 0),
    mcapUsd: round(num(a.market_cap_usd), 0),
    buys5m: num(a.transactions?.m5?.buys),
    sells5m: num(a.transactions?.m5?.sells),
    buyers5m: num(a.transactions?.m5?.buyers),
    sellers5m: num(a.transactions?.m5?.sellers),
    volume5mUsd: round(num(a.volume_usd?.m5), 0),
    priceChange5mPct: round(num(a.price_change_percentage?.m5), 1),
    lockedLiquidityPct: round(num(a.locked_liquidity_percentage), 1),
  });
}

/** Lo del token en la búsqueda v2 de Jupiter: tamaño, holders, auditoría, creador y actividad de 5 min. */
export function jupiterValues(t: Record<string, any> | undefined): { values: Ficha; graduatedAtMs?: number; tokenCreatedMs?: number; graduatedPool?: string } {
  if (!t) return { values: {} };
  const s5 = t.stats5m ?? {};
  const audit = t.audit ?? {};
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const curve = num(t.bondingCurve) ?? num(t.bondingCurvePercentage) ?? num(t.bondingCurve?.progress);
  return {
    values: compact({
      launchpad: typeof t.launchpad === "string" ? t.launchpad : undefined,
      holders: num(t.holderCount),
      jupMcapUsd: round(num(t.mcap), 0),
      jupFdvUsd: num(t.fdv) !== undefined && num(t.fdv) !== num(t.mcap) ? round(num(t.fdv), 0) : undefined,
      jupLiquidityUsd: round(num(t.liquidity), 0),
      organicScore: round(num(t.organicScore), 1),
      organicLabel: typeof t.organicScoreLabel === "string" ? t.organicScoreLabel : undefined,
      topHoldersPct: round(num(audit.topHoldersPercentage), 1),
      devBalancePct: round(num(audit.devBalancePercentage), 1),
      mintDisabled: bool(audit.mintAuthorityDisabled),
      freezeDisabled: bool(audit.freezeAuthorityDisabled),
      devMints: num(audit.devMints),
      devMigrations: num(audit.devMigrations),
      dev: typeof t.dev === "string" ? t.dev : undefined,
      bondingCurvePct: round(curve, 1),
      jupBuys5m: num(s5.numBuys),
      jupSells5m: num(s5.numSells),
      traders5m: num(s5.numTraders),
      netBuyers5m: num(s5.numNetBuyers),
      organicBuyers5m: num(s5.numOrganicBuyers),
      jupBuyVolume5mUsd: round(num(s5.buyVolume), 0),
      jupSellVolume5mUsd: round(num(s5.sellVolume), 0),
      jupPriceChange5mPct: round(num(s5.priceChange), 1),
      holderChange5mPct: round(num(s5.holderChange), 1),
      hasTwitter: typeof t.twitter === "string" ? t.twitter.length > 0 : undefined,
      hasWebsite: typeof t.website === "string" ? t.website.length > 0 : undefined,
      hasTelegram: typeof t.telegram === "string" ? t.telegram.length > 0 : undefined,
      token2022: typeof t.tokenProgram === "string" ? t.tokenProgram === TOKEN_2022 : undefined,
    }),
    graduatedAtMs: time(t.graduatedAt),
    tokenCreatedMs: time(t.createdAt) ?? time(t.firstPool?.createdAt),
    graduatedPool: typeof t.graduatedPool === "string" && t.graduatedPool ? t.graduatedPool : undefined,
  };
}

/** Junta lo de GeckoTerminal y lo de Jupiter (con la ida y vuelta cotizada, si la hay) en una lectura. */
export function snapshotFrom(a: {
  capturedAtMs: number;
  pool?: string;
  poolCreatedMs?: number;
  gecko?: Ficha;
  geckoAtMs?: number;
  jupiter?: ReturnType<typeof jupiterValues>;
  jupiterAtMs?: number;
  roundTripPct?: number;
}): EntrySnapshot {
  const hasGecko = !!a.gecko && Object.keys(a.gecko).length > 0;
  const hasJupiter = !!a.jupiter && Object.keys(a.jupiter.values).length > 0;
  return {
    capturedAtMs: a.capturedAtMs,
    ...(hasGecko && a.geckoAtMs !== undefined ? { geckoAtMs: a.geckoAtMs } : {}),
    ...(hasJupiter && a.jupiterAtMs !== undefined ? { jupiterAtMs: a.jupiterAtMs } : {}),
    ...(a.pool ?? a.jupiter?.graduatedPool ? { pool: a.pool ?? a.jupiter?.graduatedPool } : {}),
    ...(a.poolCreatedMs !== undefined ? { poolCreatedMs: a.poolCreatedMs } : {}),
    ...(a.jupiter?.graduatedAtMs !== undefined ? { graduatedAtMs: a.jupiter.graduatedAtMs } : {}),
    ...(a.jupiter?.tokenCreatedMs !== undefined ? { tokenCreatedMs: a.jupiter.tokenCreatedMs } : {}),
    values: { ...(a.gecko ?? {}), ...(a.jupiter?.values ?? {}), ...(a.roundTripPct !== undefined ? { roundTripPct: round(a.roundTripPct, 2)! } : {}) },
  };
}

/**
 * La ficha a la hora de la entrada: las edades (del pool, desde la graduación y del token) a ese momento, y cuántos
 * segundos tenían los datos: dataAgeS, los de lo más antiguo, y geckoAgeS y jupAgeS, los de cada fuente (ver la cabecera).
 * `from` dice de dónde salen ('señal': lo que leyó wait_for_signal o el detector del gemelo; 'jupiter': solo la búsqueda
 * de Jupiter, tras la compra).
 */
export function fichaAt(s: EntrySnapshot, entryMs: number, from: string): Ficha {
  const secs = (ms: number | undefined) => (ms === undefined ? undefined : Math.max(0, Math.round((entryMs - ms) / 1000)));
  const oldest = Math.min(s.capturedAtMs, s.geckoAtMs ?? Infinity, s.jupiterAtMs ?? Infinity);
  return compact({
    from,
    dataAgeS: secs(oldest),
    geckoAgeS: secs(s.geckoAtMs),
    jupAgeS: secs(s.jupiterAtMs),
    poolAgeS: secs(s.poolCreatedMs),
    graduatedAgoS: secs(s.graduatedAtMs),
    tokenAgeS: secs(s.tokenCreatedMs),
    ...s.values,
  });
}

/** Lee una lectura guardada (JSON); null si no se puede. */
export function parseSnapshot(raw: string | null | undefined): EntrySnapshot | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as EntrySnapshot;
    return typeof s?.capturedAtMs === "number" && s.values && typeof s.values === "object" ? s : null;
  } catch {
    return null;
  }
}
