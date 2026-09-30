// "Qué habría pasado si…" de cada operación cerrada, con el precio real minuto a minuto (GeckoTerminal):
// cuánto llegó a subir mientras la tenía, cuánto habría ganado o perdido manteniéndola más tiempo, y el resultado
// de no haber entrado (0 %). Así el revisor separa una mala entrada de una mala salida y no juzga solo por el
// resultado (sesgo retrospectivo). Los plazos son proporcionales a la misión: 15 y 30 minutos más en una larga;
// 1, 3 y 5 en una rápida (en una misión de 10 min, "30 minutos más" no dice nada de la decisión).
import { db } from "../db.js";
import { fetchJson } from "../market/http.js";
import { isShortMission } from "./mission-kind.js";
import { listPositions } from "./positions.js";

/** Minutos después de la venta en los que se mira el precio: en una misión larga y en una rápida (15 min o menos). */
export const HOLD_HORIZONS = { long: [15, 30], fast: [1, 3, 5] } as const;

const NETWORK: Record<string, string> = { solana: "solana", base: "base", bsc: "bsc" };
type Pos = ReturnType<typeof listPositions>[number];

export interface Counterfactual {
  positionId: number;
  symbol: string;
  /** Resultado real de la operación (con comisiones y slippage). */
  actualPct: number | null;
  /** Movimiento del precio de mercado entre la entrada y la salida. */
  marketMovePct?: number;
  /** Lo más alto y lo más bajo que llegó mientras la tenía (cierres de cada minuto), sobre el precio de entrada. */
  bestWhileHeldPct?: number;
  worstWhileHeldPct?: number;
  /** Si la hubiera mantenido N minutos más (sobre el precio de entrada): ifHeld15Pct e ifHeld30Pct en una misión larga; ifHeld1Pct, ifHeld3Pct e ifHeld5Pct en una rápida. */
  [ifHeld: `ifHeld${number}Pct`]: number | undefined;
  reading?: string;
  unavailable?: string;
  /** El precio del pool se aleja mucho del resultado real: sus máximos y "habría dado" no eran vendibles. */
  unreliable?: string;
}

const cache = new Map<number, Counterfactual>();
const pct = (a: number, b: number, decimals = 1) => Number(((b / a - 1) * 100).toFixed(decimals));

async function candles(venue: string, token: string, fromSec: number, toSec: number): Promise<Array<[number, number, number, number, number]>> {
  const net = NETWORK[venue];
  if (!net) throw new Error("cadena sin datos de velas");
  const pools = await fetchJson<{ data: Array<{ attributes: { address: string; reserve_in_usd?: string } }> }>(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${token}/pools?page=1`, {
    ttlMs: 3_600_000,
  });
  // El pool con más liquidez: el primero de la lista puede ser uno pequeño (o manipulado) que no es donde se opera.
  const pool = [...pools.data].sort((a, b) => Number(b.attributes.reserve_in_usd ?? 0) - Number(a.attributes.reserve_in_usd ?? 0))[0]?.attributes.address;
  if (!pool) throw new Error("sin pool en GeckoTerminal");
  const limit = Math.min(1000, Math.ceil((toSec - fromSec) / 60) + 3);
  const res = await fetchJson<{ data: { attributes: { ohlcv_list: Array<[number, number, number, number, number]> } } }>(
    `https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pool}/ohlcv/minute?aggregate=1&limit=${limit}&before_timestamp=${toSec}&currency=usd&token=${token}`,
    { ttlMs: 600_000 },
  );
  return [...res.data.attributes.ohlcv_list].sort((a, b) => a[0] - b[0]);
}

/** Velas de 1 min del subyacente de un futuro en Binance (SOL, ETH, BNB…), en segundos como las de GeckoTerminal. */
async function perpCandles(coin: string, fromSec: number, toSec: number): Promise<Array<[number, number, number, number, number]>> {
  const limit = Math.min(1000, Math.ceil((toSec - fromSec) / 60) + 3);
  const raw = await fetchJson<Array<[number, string, string, string, string]>>(
    `https://api.binance.com/api/v3/klines?symbol=${coin.toUpperCase()}USDT&interval=1m&startTime=${fromSec * 1000}&endTime=${toSec * 1000}&limit=${limit}`,
    { ttlMs: 600_000 },
  );
  return raw.map((k) => [Math.floor(k[0] / 1000), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4])]);
}

/** Precio de cierre de la última vela en o antes de `sec`. */
const priceAt = (cs: Array<[number, number, number, number, number]>, sec: number) => {
  let p: number | undefined;
  for (const c of cs) if (c[0] <= sec) p = c[4];
  return p;
};

async function one(p: Pos, horizons: readonly number[]): Promise<Counterfactual> {
  const base: Counterfactual = { positionId: p.id, symbol: p.symbol, actualPct: p.pnlPct ?? null };
  // Futuros: el símbolo es "SOL-PERP largo 20x". Los porcentajes van en el sentido de la posición (en un corto,
  // que baje el precio es a favor) y sobre el precio, sin apalancar.
  const perp = p.venue === "hyperliquid" ? p.symbol.match(/^(\w+)-PERP (largo|corto) (\d+)x/) : null;
  if (!p.closedAt || (!NETWORK[p.venue] && !perp)) return { ...base, unavailable: "sin datos de precio para esta cadena" };
  const open = Math.floor(new Date(p.openedAt).getTime() / 1000);
  const close = Math.floor(new Date(p.closedAt).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  const last = horizons.at(-1)!;
  const end = Math.min(now, close + last * 60);
  const raw = perp ? await perpCandles(perp[1]!, open - 120, end) : await candles(p.venue, p.asset, open - 120, end);
  // En un corto se invierten las velas (1/precio): así "subir" siempre es a favor y el resto no cambia.
  const cs = perp?.[2] === "corto" ? raw.map(([t, o, h, l, c]) => [t, 1 / o, 1 / l, 1 / h, 1 / c] as [number, number, number, number, number]) : raw;
  const entry = priceAt(cs, open) ?? cs[0]?.[4];
  const exit = priceAt(cs, close);
  if (!entry || !exit) return { ...base, unavailable: "sin velas en ese intervalo" };
  const held = cs.filter((c) => c[0] >= open - 60 && c[0] <= close);
  const d = perp ? 2 : 1;
  // Precio a cada plazo tras la venta, en cuanto ha pasado.
  const after = horizons.map((h) => {
    const price = close + h * 60 <= now ? priceAt(cs, close + h * 60) : undefined;
    return { h, pct: price ? pct(entry, price, d) : undefined };
  });
  const out: Counterfactual = {
    ...base,
    marketMovePct: pct(entry, exit, d),
    // Con los cierres de cada minuto, no con los máximos y mínimos: en pools pequeños las mechas son picos de un
    // segundo que no se podían vender (en la M28, p/acc "llegó a +66 %" justo antes de un rug del -95 %).
    bestWhileHeldPct: held.length ? pct(entry, Math.max(...held.map((c) => c[4])), d) : undefined,
    worstWhileHeldPct: held.length ? pct(entry, Math.min(...held.map((c) => c[4])), d) : undefined,
  };
  for (const a of after) out[`ifHeld${a.h}Pct`] = a.pct;
  const notes: string[] = [];
  if (out.bestWhileHeldPct !== undefined && out.marketMovePct !== undefined && out.bestWhileHeldPct >= 3 && out.bestWhileHeldPct - out.marketMovePct >= 20) {
    notes.push(`llegó a +${out.bestWhileHeldPct} % mientras la tenía y salió en ${out.marketMovePct} %: la salida dejó dinero en la mesa`);
  }
  const first = after[0]!;
  const final = after.at(-1)!;
  if (first.pct !== undefined && out.marketMovePct !== undefined && first.pct > out.marketMovePct + 30) {
    notes.push(`a los ${first.h} min de vender iba ${first.pct} %`);
  }
  if (final.pct !== undefined && out.marketMovePct !== undefined) {
    if (final.pct < out.marketMovePct - 15) notes.push(`mantenerla ${final.h} min más habría dado ${final.pct} %: la salida fue buena`);
    else if (final.pct > out.marketMovePct + 15) notes.push(`mantenerla ${final.h} min más habría dado ${final.pct} %: salió demasiado pronto`);
  }
  if (out.bestWhileHeldPct !== undefined && out.bestWhileHeldPct < (perp ? 0.1 : 3) && (p.pnlPct ?? 0) < 0) notes.push("nunca llegó a ir en positivo: el problema fue la entrada, no la salida");
  if (perp) notes.push(`futuro a ${perp[3]}x: los % son del precio en el sentido de la posición; sobre el margen, por ${perp[3]}`);
  // Si el precio del pool no cuadra con lo que dio la venta real (rug, pool distinto o mucho impacto), sus
  // "llegó a" y "habría dado" no eran precios a los que se pudiera vender: se avisa para no juzgar la salida con ellos.
  if (out.marketMovePct !== undefined && base.actualPct !== null && Math.abs(out.marketMovePct - base.actualPct) > 15) {
    out.unreliable = `el precio del pool (${out.marketMovePct} %) no cuadra con la venta real (${base.actualPct} %): no eran precios de venta`;
    notes.unshift("lectura poco fiable, ver unreliable");
  }
  out.reading = notes.join("; ") || "sin nada destacable";
  if (final.pct !== undefined) cache.set(p.id, out); // completa: ya no cambia
  return out;
}

/** Contrafactuales de las operaciones cerradas de una misión (como mucho `limit`, las más recientes). */
export async function missionCounterfactuals(missionId: number, limit = 8): Promise<Counterfactual[]> {
  const m = db.prepare("SELECT created_at, deadline FROM missions WHERE id = ?").get(missionId) as { created_at: string; deadline: string } | undefined;
  const horizons = m && isShortMission(m) ? HOLD_HORIZONS.fast : HOLD_HORIZONS.long;
  const closed = listPositions(missionId)
    .filter((p) => p.status === "closed")
    .slice(-limit);
  const out: Counterfactual[] = [];
  for (const p of closed) {
    const cached = cache.get(p.id);
    if (cached) {
      out.push(cached);
      continue;
    }
    out.push(await one(p, horizons).catch((err) => ({ positionId: p.id, symbol: p.symbol, actualPct: p.pnlPct ?? null, unavailable: (err as Error).message.slice(0, 120) })));
  }
  return out;
}
