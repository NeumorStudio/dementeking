// Panel web local para seguir al agente en directo. Lo arranca la herramienta `start_dashboard`
// del servidor MCP, o a mano con `npm run dashboard` (ver cli.ts).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { asset } from "../paths.js";
import { db } from "../db.js";
import { listCapabilityRequests, recall, recentLearning } from "../sim/memory.js";
import { getActiveMission, getLastMission, missionHistory, type Mission } from "../sim/mission.js";
import { listOrders } from "../sim/orders.js";
import { valuation } from "../sim/portfolio.js";
import { listPositions } from "../sim/positions.js";
import { timeline } from "./timeline.js";
import { walletBalances } from "../live/chain.js";
import { signerStatus, walletUrl } from "../live/client.js";
import { readWalletPublic } from "../live/keystore.js";
import { liveDir } from "../live/paths.js";

const INDEX_HTML = asset("index.html", "src/dashboard/index.html");

type Valuation = Awaited<ReturnType<typeof valuation>>;
let cached: { at: string; value: Valuation } | null = null;
let lastSnapshot = 0;
let running: { url: string; server?: http.Server; timers?: NodeJS.Timeout[] } | null = null;

// La valoración consulta precios reales, así que se refresca en segundo plano y no en cada petición.
async function refreshValuation(log: (msg: string) => void) {
  try {
    const mission = getActiveMission() ?? getLastMission();
    if (!mission) {
      cached = null;
      return;
    }
    const record = mission.status === "active" && Date.now() - lastSnapshot >= 60_000;
    cached = { at: new Date().toISOString(), value: await valuation(mission.id, record) };
    if (record) lastSnapshot = Date.now();
  } catch (err) {
    log(`Error valorando la cartera: ${(err as Error).message}`);
  }
}

// Cartera real de la IA (si existe): saldos leídos de la cadena, como mucho cada minuto.
let walletCache: { at: number; value: unknown } | null = null;

async function refreshWallet(log: (msg: string) => void) {
  try {
    const running = await signerStatus();
    const pub = running?.status.wallet ?? readWalletPublic(liveDir());
    if (!pub) {
      walletCache = { at: Date.now(), value: null };
      return;
    }
    const b = await walletBalances(pub);
    walletCache = {
      at: Date.now(),
      value: {
        signer: running ? (running.status.stopped ? "parado" : running.status.unlocked ? "desbloqueado" : "bloqueado") : "apagado",
        walletUrl: running ? walletUrl(running.info) : null,
        pendingApprovals: (running?.status as { pendingApprovals?: number } | undefined)?.pendingApprovals ?? 0,
        addresses: { solana: pub.solana, evm: pub.evm },
        totalUsd: b.totalUsd,
        byChain: b.byChain,
      },
    };
  } catch (err) {
    log(`Error leyendo la cartera real: ${(err as Error).message}`);
  }
}

// La memoria se recalcula como mucho cada 30 s: la evidencia de las creencias se calcula con todas las posiciones.
let memoryCache: { at: number; missionId: number | null; value: ReturnType<typeof buildMemory> } | null = null;

function buildMemory(missionId: number | null) {
  const mem = recall(missionId, 12);
  return {
    howtos: mem.howtos.map((h) => ({ id: h.id, scope: h.scope, topic: h.topic, title: h.title })),
    beliefs: mem.beliefs.map((b) => ({ id: b.id, statement: b.statement, verdict: b.evidence.verdict })),
    latest: recentLearning(5),
    requests: listCapabilityRequests("open").map((r) => ({ id: r.id, capability: r.capability, why: r.why, times_requested: r.times_requested })),
  };
}

function memorySummary(missionId: number | null) {
  if (!memoryCache || memoryCache.missionId !== missionId || Date.now() - memoryCache.at > 30_000) {
    memoryCache = { at: Date.now(), missionId, value: buildMemory(missionId) };
  }
  return memoryCache.value;
}

function state() {
  const mission: Mission | undefined = getActiveMission() ?? getLastMission();
  const snapshots = mission
    ? (db.prepare("SELECT ts, total_usd FROM snapshots WHERE mission_id = ? ORDER BY ts").all(mission.id) as Array<{ ts: string; total_usd: number }>)
    : [];
  return {
    now: new Date().toISOString(),
    mission: mission ?? null,
    // La valoración en caché puede ser de la misión anterior justo después de crear otra.
    valuation: cached && mission && cached.value.missionId === mission.id ? cached.value : null,
    valuedAt: cached?.at ?? null,
    orders: mission ? listOrders(mission.id, "open") : [],
    snapshots,
    history: missionHistory(),
    memory: memorySummary(mission?.id ?? null),
    realWallet: walletCache?.value ?? null,
    ...(mission ? missionDetail(mission.id) : { trades: [], positions: [], lastNote: null, lastReview: null }),
  };
}

/** Lo que el panel dibuja sobre la carrera: operaciones (banderas), posiciones abiertas y lo último de cada agente. */
function missionDetail(missionId: number) {
  const trades = (
    db
      .prepare(
        `SELECT id, ts, kind, summary, details FROM journal
         WHERE mission_id = ? AND kind IN ('swap', 'cex_order', 'transfer', 'failed_tx', 'order_failed', 'perp') ORDER BY id`,
      )
      .all(missionId) as Array<{ id: number; ts: string; kind: string; summary: string; details: string | null }>
  ).map((j) => {
    const d = j.details ? (JSON.parse(j.details) as Record<string, unknown>) : {};
    // Dónde ocurrió: la cadena del swap, Binance, o el origen de una transferencia.
    const venue = j.kind === "cex_order" ? "binance" : String(d.chain ?? d.from ?? "solana");
    return { id: j.id, ts: j.ts, kind: j.kind, summary: j.summary, venue, ...(d.explorer ? { explorer: String(d.explorer) } : {}) };
  });
  // Todas las compras de la misión (abiertas y cerradas), de la más reciente a la más antigua.
  const positions = listPositions(missionId)
    .filter((p) => p.status !== "moved")
    .map((p) => ({ venue: p.venue, asset: p.asset, symbol: p.symbol, status: p.status, openCostUsd: p.openCostUsd, costUsd: p.costUsd, pnlUsd: p.pnlUsd, pnlPct: p.pnlPct, openedAt: p.openedAt }));
  const lastNote = db.prepare("SELECT ts, title FROM activity WHERE mission_id = ? AND kind = 'thought' ORDER BY id DESC LIMIT 1").get(missionId) ?? null;
  const lastReview = db.prepare("SELECT ts, title, body FROM activity WHERE mission_id = ? AND kind = 'review' ORDER BY id DESC LIMIT 1").get(missionId) ?? null;
  return { trades, positions, lastNote, lastReview };
}

function send(res: http.ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function handler(port: number) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    try {
      if (url.pathname === "/") {
        // Se lee en cada petición para que los cambios en el HTML se vean al recargar.
        return send(res, 200, "text/html; charset=utf-8", readFileSync(INDEX_HTML, "utf8"));
      }
      if (url.pathname === "/api/state") return send(res, 200, "application/json", JSON.stringify(state()));
      // Cerrar el panel (lo pide stop_dashboard, también desde otro proceso). Solo POST.
      if (url.pathname === "/api/shutdown" && req.method === "POST") {
        send(res, 200, "application/json", JSON.stringify({ ok: true }));
        setTimeout(() => closeLocal(), 50);
        return;
      }
      if (url.pathname === "/api/events") {
        const mission = getActiveMission() ?? getLastMission();
        const since = url.searchParams.get("all") ? "1970" : (mission?.created_at ?? "1970");
        return send(res, 200, "application/json", JSON.stringify(timeline(since, mission?.id ?? null)));
      }
      send(res, 404, "text/plain", "No encontrado");
    } catch (err) {
      send(res, 500, "text/plain", (err as Error).message);
    }
  };
}

/** ¿Hay ya un panel de este proyecto respondiendo en ese puerto (p. ej. de otra sesión)? */
async function isOurDashboard(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(2000) });
    return res.ok && "mission" in ((await res.json()) as object);
  } catch {
    return false;
  }
}

/**
 * Arranca el panel en 127.0.0.1 (solo accesible desde este ordenador). Si ya está en marcha,
 * en este proceso o en otro, devuelve su URL sin arrancar otro.
 */
export async function startDashboard(opts: { port?: number; log?: (msg: string) => void } = {}): Promise<{ url: string; alreadyRunning: boolean }> {
  const port = opts.port ?? Number(process.env.DASHBOARD_PORT || 4331);
  const log = opts.log ?? console.error;
  const url = `http://localhost:${port}`;
  if (running) return { url: running.url, alreadyRunning: true };
  if (await isOurDashboard(url)) return { url, alreadyRunning: true };

  const server = http.createServer(handler(port));
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new Error(`El puerto ${port} está ocupado por otro programa. Usa otro con DASHBOARD_PORT.`) : err),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  const timers = [
    // Cada 30 s: la valoración cotiza en Jupiter y comparte su límite de peticiones con el agente.
    setInterval(() => refreshValuation(log), 30_000),
    // Con una misión real, más a menudo (para avisar de aprobaciones pendientes).
    setInterval(() => {
      const live = (getActiveMission() as { mode?: string } | undefined)?.mode === "live";
      if (live || !walletCache || Date.now() - walletCache.at > 60_000) void refreshWallet(log);
    }, 10_000),
  ];
  for (const t of timers) t.unref();
  running = { url, server, timers };
  await refreshValuation(log);
  void refreshWallet(log);
  return { url, alreadyRunning: false };
}

function closeLocal(): boolean {
  if (!running?.server) return false;
  for (const t of running.timers ?? []) clearInterval(t);
  running.server.close();
  running.server.closeAllConnections?.();
  running = null;
  return true;
}

/** Cierra el panel, esté en este proceso o en otro (de otra sesión). Devuelve si había uno abierto. */
export async function stopDashboard(opts: { port?: number } = {}): Promise<boolean> {
  if (closeLocal()) return true;
  const url = `http://localhost:${opts.port ?? Number(process.env.DASHBOARD_PORT || 4331)}`;
  if (!(await isOurDashboard(url))) return false;
  await fetch(`${url}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  return true;
}

/** Abre una URL en el navegador por defecto del sistema. */
export function openInBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
