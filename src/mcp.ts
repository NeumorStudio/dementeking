// Servidor MCP del simulador para usar el agente desde Claude Code (con la suscripción).
// Expone la cartera simulada, el diario y las notas. La navegación la hace Claude Code
// con su propio navegador. stdout es el canal del protocolo: no usar console.log.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { slimToolList } from "./tools/schema-slim.js";
import { z } from "zod";
import { checkOrders } from "./sim/orders.js";
import { openInBrowser, startDashboard, stopDashboard } from "./dashboard/server.js";
import { checkMission, createLiveMission, createMission, getActiveMission, getLastMission, startMissionClock, stopMission } from "./sim/mission.js";
import { liveWalletSnapshot } from "./live/sync.js";
import { db, holdsTickLease, supersededBy } from "./db.js";
import { keepAwake } from "./keep-awake.js";
import { endSession, sessionBriefing, startSession } from "./sim/session.js";
import { DEFAULT_ALLOCATION, VENUES } from "./sim/types.js";
import { statusReport } from "./sim/status.js";
import { SIM_TOOLS, runTool } from "./tools/index.js";
import { startWatchLoop } from "./sim/watch.js";
import { shadowsRunning } from "./sim/shadow.js";
import { walletBalances } from "./live/chain.js";
import { ensureSigner, signerStatus, walletUrl } from "./live/client.js";
import { readWalletPublic } from "./live/keystore.js";
import { liveDir } from "./live/paths.js";

const server = new McpServer({ name: "cryptosim", version: "0.1.0" });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// Si arranca una versión más nueva del plugin, todas las herramientas de este proceso se niegan a actuar.
const register = server.registerTool.bind(server);
(server as unknown as { registerTool: unknown }).registerTool = (name: string, cfg: unknown, handler: (...a: unknown[]) => unknown) =>
  (register as (...a: unknown[]) => unknown)(name, cfg, async (...args: unknown[]) => {
    const superseded = supersededBy();
    return superseded ? { ...text(superseded), isError: true } : handler(...args);
  });

/** Misión sobre la que trabaja el agente: la activa o, si no hay, la última. */
const currentMission = (): number | null => (getActiveMission() ?? getLastMission())?.id ?? null;

// Una sesión de trabajo abierta por misión. Las llamadas sin sesión abierta (p. ej. del revisor, que
// comparte este servidor) se anotan en la última sesión de la misión en vez de abrir una vacía.
const sessions = new Map<number | null, number>();
const sessionFor = (missionId: number | null) => {
  if (!sessions.has(missionId)) {
    const last = (db.prepare("SELECT MAX(id) AS id FROM sessions WHERE mission_id IS ?").get(missionId) as { id: number | null }).id;
    sessions.set(missionId, last ?? startSession(missionId));
  }
  return sessions.get(missionId)!;
};

/**
 * Lo que hace start_session salvo el briefing: pone al día órdenes y misión, arranca el reloj de la misión (solo
 * la primera vez) y abre una sesión de trabajo. Lo reutilizan las herramientas que arrancan el reloj ellas mismas
 * (ToolDef.startsClock, p. ej. enter_with_exits).
 */
async function openWorkSession(): Promise<{ missionId: number | null; sessionId: number }> {
  await checkOrders().catch(() => []);
  await checkMission().catch(() => []);
  const missionId = currentMission();
  startMissionClock(missionId);
  const sessionId = startSession(missionId);
  sessions.set(missionId, sessionId);
  return { missionId, sessionId };
}

server.registerTool(
  "start_session",
  {
    description:
      "Arranca el reloj de la misión (solo la primera vez) y abre una sesión de trabajo; devuelve el briefing: la hora, la misión, tu cartera, " +
      "tus notas y el diario reciente. Antes del reloj no se puede operar, pero sí investigar y esperar sin que cuente el tiempo: llámala cuando " +
      "vayas a operar, no antes. En una misión rápida no hace falta: enter_with_exits arranca el reloj con la compra. Si el reloj no arranca en " +
      "60 min desde que se creó la misión, esta se cancela.",
    inputSchema: {},
  },
  async () => {
    try {
      const { missionId, sessionId } = await openWorkSession();
      return text(await sessionBriefing(sessionId, missionId));
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  },
);

server.registerTool(
  "end_session",
  {
    description: "Cierra la sesión con un resumen de lo que hiciste. Devuelve el estado final de la cartera.",
    inputSchema: { summary: z.string() },
  },
  async ({ summary }) => {
    try {
      const missionId = currentMission();
      const sessionId = sessions.get(missionId);
      if (sessionId === undefined) return { ...text("No hay ninguna sesión abierta."), isError: true };
      const end = await endSession(sessionId, missionId, summary);
      sessions.delete(missionId);
      return text(JSON.stringify(end));
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  },
);

// ─── Herramientas de configuración: las usa la sesión del usuario (comando /trading), ─────
// no el agente. El subagente `trader` las tiene prohibidas en .claude/agents/trader.md.

server.registerTool(
  "create_mission",
  {
    description:
      "[Solo para el usuario, no para el agente trader] Crea una misión nueva. Si ya hay una misión activa, falla salvo que replace = true. " +
      "mode 'sim' (por defecto): reinicia la cartera simulada con capital_usd y fija target_usd. " +
      "mode 'live': dinero REAL de la cartera de la IA (debe existir y estar desbloqueada); el capital es lo que vale la cartera ahora " +
      "y el objetivo se da con target_pct; hay que indicar approval, max_trade_usd y max_loss_pct.",
    inputSchema: {
      mode: z.enum(["sim", "live"]).default("sim"),
      capital_usd: z.number().positive().optional().describe("Solo sim: capital ficticio"),
      target_usd: z.number().positive().optional().describe("Solo sim: objetivo en USD"),
      target_pct: z.number().positive().optional().describe("Objetivo como % de subida (obligatorio en live; en sim sustituye a target_usd)"),
      duration_minutes: z.number().positive(),
      approval: z.enum(["manual", "auto"]).optional().describe("Solo live: manual = el usuario aprueba cada operación; auto = dentro de los límites"),
      max_trade_usd: z.number().positive().optional().describe("Solo live: máximo en USD por operación"),
      max_loss_pct: z.number().positive().max(100).optional().describe("Solo live: pérdida máxima de la misión en %; por debajo, solo se puede vender a estables"),
      replace: z.boolean().default(false).describe("Cancelar la misión activa si la hay"),
      instructions: z.string().optional().describe("Instrucciones del usuario para esta misión. Vacío = modo libre"),
      allocation: z
        .object(Object.fromEntries(VENUES.map((v) => [v, z.number().min(0).max(100).optional()])))
        .optional()
        .describe(`Reparto del capital en porcentaje por cadena o exchange (suma 100). Por defecto: ${JSON.stringify(DEFAULT_ALLOCATION)}`),
    },
  },
  async ({ mode, capital_usd, target_usd, target_pct, duration_minutes, approval, max_trade_usd, max_loss_pct, replace, instructions, allocation }) => {
    const active = getActiveMission();
    if (active && !replace) {
      return {
        ...text(`Ya hay una misión activa (#${active.id}, objetivo ${active.target_usd} USD, plazo ${active.deadline}). Pregunta al usuario si quiere reemplazarla.`),
        isError: true,
      };
    }
    try {
      if (mode === "live") {
        if (!target_pct || !approval || !max_trade_usd || !max_loss_pct) throw new Error("En una misión real hacen falta target_pct, approval, max_trade_usd y max_loss_pct");
        const running = await signerStatus();
        if (!running?.status.unlocked || running.status.stopped) throw new Error("La cartera real no está desbloqueada: usa start_wallet y pide al usuario que la desbloquee en su página");
        const snap = await liveWalletSnapshot();
        const mission = createLiveMission({
          holdings: snap.holdings,
          totalUsd: snap.totalUsd,
          byChain: snap.byChain,
          targetPct: target_pct,
          durationMinutes: duration_minutes,
          instructions,
          approval,
          limits: { maxTradeUsd: max_trade_usd, maxLossPct: max_loss_pct },
        });
        return text(JSON.stringify(mission));
      }
      if (!capital_usd) throw new Error("Falta capital_usd");
      const target = target_usd ?? (target_pct ? capital_usd * (1 + target_pct / 100) : undefined);
      if (!target) throw new Error("Falta target_usd o target_pct");
      const mission = await createMission(capital_usd, target, duration_minutes, instructions, allocation ?? DEFAULT_ALLOCATION);
      return text(JSON.stringify(mission));
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  },
);

server.registerTool(
  "stop_mission",
  {
    description:
      "[Solo para el usuario, no para el agente trader] Detiene la misión activa antes de tiempo y cancela sus órdenes. " +
      "Con close_positions = true vende todas las posiciones a mercado; si no, la cartera queda como está.",
    inputSchema: { close_positions: z.boolean() },
  },
  async ({ close_positions }) => {
    try {
      const r = await stopMission(close_positions);
      return text(
        `Misión #${r.missionId} detenida. Valor final: ${r.finalUsd.toFixed(2)} USD.` +
          (r.problems.length ? `\nNo se pudo vender: ${r.problems.join("; ")}` : ""),
      );
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  },
);

server.registerTool(
  "status_report",
  {
    description:
      "Resumen en texto de la misión actual (o la última): progreso, valor, tiempo restante, posiciones con su resultado, órdenes, " +
      "operaciones cerradas, últimos movimientos con su motivo y la última nota del agente. Pensado para enseñárselo al usuario en el chat.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await statusReport());
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  },
);

server.registerTool(
  "start_dashboard",
  {
    description:
      "[Solo para el usuario, no para el agente trader] Arranca en local (127.0.0.1) el panel web que muestra la misión y lo que hace " +
      "el agente en directo, y devuelve su URL. Con open_in_system_browser = true, además lo abre en el navegador por defecto.",
    inputSchema: { open_in_system_browser: z.boolean().default(false) },
  },
  async ({ open_in_system_browser }) => {
    try {
      const { url, alreadyRunning } = await startDashboard({ log: (m) => console.error(m) });
      if (open_in_system_browser) openInBrowser(url);
      return text(`${alreadyRunning ? "El panel ya estaba en marcha" : "Panel arrancado"} en ${url}${open_in_system_browser ? " (abierto en el navegador)" : ""}`);
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  },
);

server.registerTool(
  "stop_dashboard",
  {
    description: "[Solo para el usuario, no para el agente trader] Cierra el panel web local (deja de escuchar en localhost). Se puede volver a abrir con start_dashboard.",
    inputSchema: {},
  },
  async () => {
    try {
      return text((await stopDashboard()) ? "Panel cerrado." : "No había ningún panel abierto.");
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  },
);

// ─── Cartera real: el firmante es un proceso aparte que guarda la clave. Aquí solo se arranca y se
// consulta; la frase y las claves no pasan nunca por este proceso ni por el modelo.

server.registerTool(
  "start_wallet",
  {
    description:
      "[Solo para el usuario, no para el agente trader] Arranca el firmante de la cartera real de la IA (si no está en marcha) y abre " +
      "su página en el navegador del usuario, donde se crea la cartera, se desbloquea con la contraseña y se para todo. " +
      "Nunca pidas al usuario la frase ni la contraseña en el chat: se escriben solo en esa página.",
    inputSchema: {},
  },
  async () => {
    try {
      const { info, status, started } = await ensureSigner();
      openInBrowser(walletUrl(info));
      const state = !status.exists ? "todavía no hay cartera: el usuario debe crearla en la página" : status.unlocked ? "cartera desbloqueada" : "cartera bloqueada: el usuario debe desbloquearla en la página";
      return text(`${started ? "Firmante arrancado" : "El firmante ya estaba en marcha"}; página abierta en el navegador (${walletUrl(info)}). Estado: ${state}.`);
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  },
);

server.registerTool(
  "wallet_status",
  {
    description:
      "[Solo para el usuario, no para el agente trader] Estado de la cartera real de la IA: si existe, si el firmante está en marcha y " +
      "desbloqueado, sus direcciones y los saldos reales por cadena (Solana, Base, BNB Chain) en USD.",
    inputSchema: {},
  },
  async () => {
    try {
      const running = await signerStatus();
      const pub = running?.status.wallet ?? readWalletPublic(liveDir());
      if (!pub) return text(JSON.stringify({ wallet: null, message: "No hay cartera real. Usa start_wallet para crearla." }));
      const b = await walletBalances(pub);
      return text(
        JSON.stringify({
          signer: running ? (running.status.stopped ? "parado" : running.status.unlocked ? "desbloqueado" : "bloqueado") : "no está en marcha",
          addresses: { solana: pub.solana, evm: pub.evm },
          totalUsd: Number(b.totalUsd.toFixed(2)),
          byChain: Object.fromEntries(Object.entries(b.byChain).map(([c, v]) => [c, Number(v.toFixed(2))])),
          balances: b.balances.map((x) => ({ chain: x.venue, symbol: x.symbol, amount: Number(x.amount.toPrecision(8)), usd: Number(x.usd.toFixed(2)) })),
          ...(Object.keys(b.errors).length ? { unreadable: b.errors } : {}),
        }),
      );
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  },
);

server.registerTool(
  "export_taxes",
  {
    description:
      "[Solo para el usuario, no para el agente trader] Exporta a CSV (para Excel) todas las operaciones con dinero real (swaps y " +
      "puentes, con hash, cantidades, valor en USD y EUR y comisión de red) y los resultados por posición cerrada. Devuelve las rutas de los archivos.",
    inputSchema: { year: z.number().int().min(2020).max(2100).optional().describe("Solo ese año (por defecto, todo)") },
  },
  async ({ year }) => {
    try {
      const { exportTaxes } = await import("./live/taxes.js");
      return text(JSON.stringify(await exportTaxes({ year })));
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  },
);

for (const tool of SIM_TOOLS) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema.shape as z.ZodRawShape }, async (input: Record<string, unknown>) => {
    try {
      const missionId = currentMission();
      const startClock = async () => (await openWorkSession()).sessionId;
      const { content, isError } = await runTool(tool.name, input, { sessionId: sessionFor(missionId), missionId, startClock });
      return { ...text(typeof content === "string" ? content : JSON.stringify(content)), isError };
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
    }
  });
}

// La lista de herramientas sale sin el relleno que añade la conversión desde zod (ver schema-slim.ts).
const transport = new StdioServerTransport();
const send = transport.send.bind(transport);
transport.send = (message) => send(slimToolList(message));
await server.connect(transport);

// Mientras Claude Code está abierto, este proceso también vigila las órdenes condicionales, los futuros y la
// misión (el reclamo atómico evita ejecutar dos veces si además corre `npm run watcher`). Cada cuánto, en
// sim/watch.ts: cada minuto; las órdenes por precio cada 15 s; todo cada 5 s en una misión rápida.
startWatchLoop({
  canRun: () => !supersededBy() && holdsTickLease(),
  log: (line) => {
    if (line.startsWith("Error")) console.error(line);
  },
});

// Con una misión en marcha, el equipo no se duerme (keep-awake.ts). Lo pide cada servidor abierto: si hay
// varios, da igual; al acabar la misión todos lo sueltan. También mientras quede un gemelo mecánico en marcha: puede
// seguir unos minutos después de la misión, y dormido no se le seguiría el precio.
const missionRunning = () => !!db.prepare("SELECT 1 FROM missions WHERE status IN ('active', 'closing') LIMIT 1").get() || shadowsRunning();
setInterval(() => {
  if (supersededBy()) return keepAwake(false);
  keepAwake(missionRunning());
}, 20_000);
