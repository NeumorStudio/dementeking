// En una misión real, la tabla `holdings` es un espejo de la cadena: se sobrescribe con los saldos
// leídos. Así la valoración, las posiciones, el panel y la memoria funcionan igual que en simulación.
import { db } from "../db.js";
import type { EvmChainId } from "../market/evm.js";
import { getMission, isLive } from "../sim/mission.js";
import { resetPortfolio } from "../sim/portfolio.js";
import { readHoldings, walletBalances, type ExtraTokens } from "./chain.js";
import { readWalletPublic, type WalletPublic } from "./keystore.js";
import { liveDir } from "./paths.js";

export function livePub(): WalletPublic {
  const pub = readWalletPublic(liveDir());
  if (!pub) throw new Error("No hay cartera real. El usuario debe crearla con /dementeking:cartera");
  return pub;
}

/** Tokens EVM a vigilar en una misión: los que ha comprado (en EVM no se pueden listar todos los saldos). */
function missionTokens(missionId: number): ExtraTokens {
  const rows = db
    .prepare("SELECT DISTINCT p.venue, p.asset, p.symbol, t.decimals FROM positions p JOIN token_meta t ON t.chain = p.venue AND t.address = p.asset WHERE p.mission_id = ? AND p.venue IN ('base', 'bsc')")
    .all(missionId) as Array<{ venue: EvmChainId; asset: string; symbol: string; decimals: number }>;
  const out: ExtraTokens = {};
  for (const r of rows) (out[r.venue] ??= []).push({ address: r.asset, symbol: r.symbol, decimals: r.decimals });
  return out;
}

/**
 * Sobrescribe los saldos de la misión con los de la cadena. Si alguna cadena no se puede leer,
 * se conservan sus saldos anteriores (mejor un dato algo viejo que un cero falso).
 */
export async function syncHoldings(missionId: number, extra: ExtraTokens = {}) {
  const mission = getMission(missionId);
  if (!isLive(mission)) return;
  const tokens = missionTokens(missionId);
  for (const [c, list] of Object.entries(extra)) (tokens[c as EvmChainId] ??= []).push(...list);
  const { holdings, errors } = await readHoldings(livePub(), tokens);
  const keep = db
    .prepare("SELECT venue, asset, symbol, decimals, amount FROM holdings WHERE mission_id = ?")
    .all(missionId)
    .filter((h: any) => h.venue in errors) as any[];
  resetPortfolio(missionId, [...holdings.filter((h) => h.amount > 0), ...keep]);
  return { errors };
}

/** Valor actual de la cartera real (para crear la misión). */
export async function liveWalletSnapshot() {
  const pub = livePub();
  const b = await walletBalances(pub);
  if (Object.keys(b.errors).length) throw new Error(`No se pudieron leer los saldos de: ${Object.keys(b.errors).join(", ")}. Inténtalo de nuevo.`);
  return { pub, ...b, holdings: b.balances.filter((x) => x.amount > 0).map(({ usd: _u, valuedBy: _v, ...h }) => h) };
}
