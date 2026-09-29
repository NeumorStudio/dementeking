// El firmante: el único proceso que descifra la clave de la cartera real. Lo arranca `start_wallet`
// (o `npm run signer`) y escucha solo en 127.0.0.1.
//
// - La página /wallet es para el usuario: crear la cartera (ve la frase una sola vez), desbloquearla con
//   su contraseña, ver saldos y parar todo. Sus acciones exigen la cookie de sesión que da la contraseña
//   y un Origin de la propia página: ni el modelo ni su navegador pueden aprobar nada sin la contraseña.
// - La API /api/* es para el servidor MCP, con un token aleatorio que se guarda en signer.json.
// La frase y las claves privadas no salen nunca de este proceso (salvo la frase, una vez, a la página).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createWallet, readWalletPublic, unlockWallet, walletExists, type Accounts } from "../keystore.js";
import { walletBalances } from "../chain.js";
import { liveDir, signerInfoFile, type SignerInfo } from "../paths.js";
import { WALLET_PAGE } from "./page.js";
import { getMission, type Mission, type MissionLimits } from "../../sim/mission.js";
import type { ChainId } from "../../sim/types.js";
import { checkLimits, type EvmTxLimits, type EvmTxRequest, type SolanaSpendBudget } from "../policy.js";
import { PolicyError, sendEvm, sendSolana, type SendResult, type SolanaSendOptions } from "./send.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SignerState {
  accounts: Accounts | null;
  /** "Parar todo": no se firma nada hasta volver a desbloquear. */
  stopped: boolean;
  sessions: Set<string>;
  failedUnlocks: number;
  lockedUntil: number;
  /** Operaciones esperando la aprobación del usuario. */
  pending: Map<string, PendingIntent>;
  /** Intenciones aprobadas (por el usuario o por estar dentro de los límites en modo autónomo). */
  tickets: Map<string, Ticket>;
}

export interface Intent {
  missionId: number;
  chain: ChainId;
  /** buy: se compra un token; sell: se vende a estables; move: puente de estables o nativo entre cadenas propias. */
  side: "buy" | "sell" | "move";
  usd: number;
  summary: string;
}
interface PendingIntent extends Intent {
  id: string;
  createdAt: number;
  decide: (approved: boolean) => void;
}
interface Ticket extends Intent {
  id: string;
  expiresAt: number;
}

/** Cuánto espera una operación la aprobación del usuario. */
export const APPROVAL_TIMEOUT_MS = 90_000;
/** Ritmo máximo de operaciones por misión: frena un bucle del agente (sobre todo en modo autónomo). */
export const MAX_OPS_PER_MINUTE = 6;
export const MAX_OPS_PER_HOUR = 60;
const TICKET_TTL_MS = 3 * 60_000;

export interface SignerDeps {
  getMission: (id: number) => Mission | undefined;
  walletValueUsd: () => Promise<number>;
  sendSolana: (accounts: Accounts, txBase64: string, opts: SolanaSendOptions) => Promise<SendResult>;
  sendEvm: (accounts: Accounts, tx: EvmTxRequest, kind: "swap" | "approve" | "bridge", limits?: EvmTxLimits) => Promise<SendResult>;
}

const MAX_BODY = 16 * 1024;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Petición demasiado grande"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("JSON no válido"));
      }
    });
  });
}

const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookieSid(req: IncomingMessage): string | null {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie ?? "");
  return m ? m[1]! : null;
}

export function createSignerServer(opts: { dir: string; token: string; deps?: Partial<SignerDeps> }) {
  const state: SignerState = {
    accounts: null,
    stopped: false,
    sessions: new Set(),
    failedUnlocks: 0,
    lockedUntil: 0,
    pending: new Map(),
    tickets: new Map(),
  };
  const deps: SignerDeps = {
    getMission,
    walletValueUsd: async () => {
      const pub = readWalletPublic(opts.dir);
      return pub ? (await walletBalances(pub)).totalUsd : 0;
    },
    sendSolana,
    sendEvm,
    ...opts.deps,
  };
  let origin = "";
  /** Momentos de las últimas operaciones concedidas, por misión. */
  const recentOps = new Map<number, number[]>();

  /** Rechaza todo lo pendiente (al bloquear o parar). */
  const rejectAllPending = () => {
    for (const p of state.pending.values()) p.decide(false);
    state.pending.clear();
    state.tickets.clear();
  };

  const ready = () => {
    if (state.stopped) throw new HttpError(423, "La cartera está parada: el usuario debe desbloquearla de nuevo en su página");
    if (!state.accounts) throw new HttpError(423, "La cartera está bloqueada: el usuario debe desbloquearla en su página (/dementeking:cartera)");
    return state.accounts;
  };

  /** Comprueba los límites y, si hace falta, espera la aprobación del usuario. Devuelve un ticket. */
  async function approveIntent(intent: Intent): Promise<Ticket> {
    ready();
    const mission = deps.getMission(intent.missionId);
    if (!mission || mission.mode !== "live" || !["active", "closing"].includes(mission.status)) {
      throw new HttpError(403, "La misión no es una misión real activa");
    }
    const limits = JSON.parse(mission.limits ?? "{}") as MissionLimits;
    if (!(intent.usd >= 0)) throw new HttpError(400, "Valor de la operación no válido");
    const problems = checkLimits({
      side: intent.side,
      usd: intent.usd,
      maxTradeUsd: limits.maxTradeUsd,
      maxLossPct: limits.maxLossPct,
      initialUsd: mission.initial_usd,
      currentUsd: intent.side === "buy" ? await deps.walletValueUsd() : Infinity,
    });
    if (problems.length) throw new HttpError(403, `Fuera de los límites de la misión: ${problems.join("; ")}`);
    // Ritmo: como mucho N operaciones por minuto y por hora en cada misión.
    const times = (recentOps.get(intent.missionId) ?? []).filter((t) => Date.now() - t < 3_600_000);
    recentOps.set(intent.missionId, times);
    if (times.filter((t) => Date.now() - t < 60_000).length >= MAX_OPS_PER_MINUTE || times.length >= MAX_OPS_PER_HOUR) {
      throw new HttpError(429, `Demasiadas operaciones seguidas (máximo ${MAX_OPS_PER_MINUTE} por minuto y ${MAX_OPS_PER_HOUR} por hora): espera un poco antes de la siguiente`);
    }
    const ticket = (): Ticket => {
      const t = { ...intent, id: randomBytes(16).toString("hex"), expiresAt: Date.now() + TICKET_TTL_MS };
      state.tickets.set(t.id, t);
      times.push(Date.now());
      return t;
    };
    if (mission.approval !== "manual") return ticket();
    const id = randomBytes(8).toString("hex");
    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      state.pending.set(id, {
        ...intent,
        id,
        createdAt: Date.now(),
        decide: (ok) => {
          clearTimeout(timer);
          state.pending.delete(id);
          resolve(ok);
        },
      });
    });
    if (!approved) throw new HttpError(403, "El usuario no ha aprobado la operación (la rechazó o no respondió a tiempo)");
    ready();
    return ticket();
  }

  async function sign(body: Record<string, unknown>): Promise<SendResult> {
    const accounts = ready();
    const t = state.tickets.get(String(body.ticket ?? ""));
    if (!t || t.expiresAt < Date.now()) throw new HttpError(403, "Operación no aprobada o aprobación caducada");
    const kind = body.kind === "approve" ? "approve" : body.kind === "bridge" ? "bridge" : "swap";
    if (body.chain !== t.chain) throw new HttpError(403, "La cadena no coincide con la operación aprobada");
    if ((kind === "bridge") !== (t.side === "move")) throw new HttpError(403, "El tipo de operación no coincide con la aprobada");
    // La transacción se construye tras la aprobación, con un precio nuevo: se admite algo de margen.
    if (kind !== "approve" && Number(body.usd) > t.usd * 1.2 + 1) throw new HttpError(403, "La operación es mayor que la aprobada");
    if (kind !== "approve") state.tickets.delete(t.id);
    try {
      if (t.chain === "solana") {
        const b = (body.budget ?? {}) as { lamports?: string; tokens?: Record<string, string> };
        const budget: SolanaSpendBudget = {
          lamports: BigInt(b.lamports ?? "0"),
          tokens: Object.fromEntries(Object.entries(b.tokens ?? {}).map(([k, v]) => [k, BigInt(v)])),
        };
        return await deps.sendSolana(accounts, String(body.solanaTx ?? ""), { bridge: kind === "bridge", budget });
      }
      const l = (body.evmLimits ?? {}) as { maxValue?: string; destEvm?: boolean };
      return await deps.sendEvm(accounts, body.evmTx as EvmTxRequest, kind, { maxValue: BigInt(l.maxValue ?? "0"), destEvm: l.destEvm === true });
    } catch (err) {
      if (err instanceof PolicyError) throw new HttpError(403, err.message);
      throw err;
    }
  }

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };

  const newSession = () => {
    const sid = randomBytes(32).toString("hex");
    state.sessions.add(sid);
    return { "set-cookie": `sid=${sid}; HttpOnly; SameSite=Strict; Path=/` };
  };

  const publicState = (authed: boolean) => ({
    exists: walletExists(opts.dir),
    unlocked: state.accounts !== null,
    stopped: state.stopped,
    authed,
    wallet: readWalletPublic(opts.dir),
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // Contra DNS rebinding: solo se atiende a 127.0.0.1 con el puerto propio.
      if (req.headers.host !== new URL(origin).host) return send(res, 403, { error: "Host no permitido" });

      // ── API del servidor MCP ──
      if (url.pathname.startsWith("/api/")) {
        const auth = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        if (!sameSecret(auth, opts.token)) return send(res, 401, { error: "Token no válido" });
        if (url.pathname === "/api/status" && req.method === "GET") {
          return send(res, 200, { ...publicState(false), pid: process.pid, pendingApprovals: state.pending.size });
        }
        if (url.pathname === "/api/intent" && req.method === "POST") {
          const b = await readBody(req);
          const t = await approveIntent({
            missionId: Number(b.missionId),
            chain: b.chain as ChainId,
            side: b.side === "sell" ? "sell" : b.side === "move" ? "move" : "buy",
            usd: Number(b.usd),
            summary: String(b.summary ?? "").slice(0, 300),
          });
          return send(res, 200, { ticket: t.id, expiresAt: t.expiresAt });
        }
        if (url.pathname === "/api/sign" && req.method === "POST") return send(res, 200, await sign(await readBody(req)));
        return send(res, 404, { error: "No existe" });
      }

      // ── Página de la cartera (para el usuario) ──
      if (url.pathname === "/" || url.pathname === "/wallet") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
        });
        return res.end(WALLET_PAGE);
      }
      const sid = cookieSid(req);
      const authed = sid !== null && state.sessions.has(sid);
      if (url.pathname === "/wallet/state" && req.method === "GET") return send(res, 200, { ...publicState(authed), pendingApprovals: state.pending.size });
      if (url.pathname === "/wallet/pending" && req.method === "GET") {
        if (!authed) return send(res, 401, { error: "Desbloquea la cartera con tu contraseña" });
        return send(res, 200, [...state.pending.values()].map(({ decide: _d, ...p }) => ({ ...p, expiresAt: p.createdAt + APPROVAL_TIMEOUT_MS })));
      }
      if (url.pathname === "/wallet/balances" && req.method === "GET") {
        const pub = readWalletPublic(opts.dir);
        return pub ? send(res, 200, await walletBalances(pub)) : send(res, 404, { error: "No hay cartera" });
      }

      if (req.method !== "POST") return send(res, 404, { error: "No existe" });
      // Las acciones solo desde la propia página.
      if (req.headers.origin !== origin) return send(res, 403, { error: "Origen no permitido" });
      const body = await readBody(req);

      if (url.pathname === "/wallet/create") {
        const { mnemonic, pub } = createWallet(opts.dir, String(body.password ?? ""));
        state.accounts = unlockWallet(opts.dir, String(body.password));
        state.stopped = false;
        return send(res, 200, { mnemonic, wallet: pub }, newSession());
      }
      if (url.pathname === "/wallet/unlock") {
        if (Date.now() < state.lockedUntil) return send(res, 429, { error: "Demasiados intentos. Espera un poco." });
        try {
          state.accounts = unlockWallet(opts.dir, String(body.password ?? ""));
        } catch (err) {
          if (++state.failedUnlocks >= 5) {
            state.lockedUntil = Date.now() + 60_000;
            state.failedUnlocks = 0;
          }
          return send(res, 400, { error: (err as Error).message });
        }
        state.failedUnlocks = 0;
        state.stopped = false;
        return send(res, 200, publicState(true), newSession());
      }
      if (!authed) return send(res, 401, { error: "Desbloquea la cartera con tu contraseña" });
      if (url.pathname === "/wallet/lock" || url.pathname === "/wallet/stop") {
        state.accounts = null;
        state.stopped = url.pathname === "/wallet/stop";
        state.sessions.clear();
        rejectAllPending();
        return send(res, 200, publicState(false));
      }
      if (url.pathname === "/wallet/decide") {
        const p = state.pending.get(String(body.id ?? ""));
        if (!p) return send(res, 404, { error: "Esa operación ya no está pendiente" });
        p.decide(body.approve === true);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "No existe" });
    } catch (err) {
      return send(res, err instanceof HttpError ? err.status : 400, { error: (err as Error).message });
    }
  });

  return {
    state,
    server,
    listen: (port = 0) =>
      new Promise<number>((resolve) =>
        server.listen(port, "127.0.0.1", () => {
          const p = (server.address() as { port: number }).port;
          origin = `http://127.0.0.1:${p}`;
          resolve(p);
        }),
      ),
  };
}

/** Arranque del proceso: puerto aleatorio y signer.json para que el servidor MCP lo encuentre. */
export async function runSigner() {
  const dir = liveDir();
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const signer = createSignerServer({ dir, token });
  const port = await signer.listen();
  const info: SignerInfo = { port, token, pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(signerInfoFile(), JSON.stringify(info), { mode: 0o600 });
  const cleanup = () => {
    rmSync(signerInfoFile(), { force: true });
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  console.error(`Firmante de dementeking en http://127.0.0.1:${port}/wallet`);
}
