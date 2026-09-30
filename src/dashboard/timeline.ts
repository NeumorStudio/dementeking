// Línea de tiempo del agente para el panel. Une tres fuentes:
//  1. El registro de sesiones de Claude Code (~/.claude/projects/<proyecto>/…), en cualquier proyecto: búsquedas,
//     páginas que abre, peticiones y textos de los agentes de dementeking. Dos formas:
//      - subagente (…/<sesión>/subagents/*.jsonl, con su .meta.json): el trader de las misiones largas, o el ejecutor,
//        el cerebro y el revisor cuando los lanza /dementeking:trading dentro de una sesión.
//      - hilo principal (…/<sesión>.jsonl): las tandas de misiones rápidas lanzan cada paso en su propia sesión
//        (claude -p … --agent dementeking:executor); el agente va en la primera línea ({"type":"agent-setting"}) y la
//        sesión termina con {"type":"cost-state"}.
//     Es un formato interno de Claude Code; si cambia, esta parte puede dejar de leerse, pero el resto sigue.
//  2. La tabla `activity`: registro de trabajo (log_progress) y, con el runner por API, todo su razonamiento.
//  3. El diario del simulador y las notas: operaciones, órdenes, misiones.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { db } from "../db.js";
import { SIM_TOOLS } from "../tools/index.js";

export type EventKind =
  | "thought"
  | "thinking"
  | "text"
  | "search"
  | "browse"
  | "fetch"
  | "tool"
  | "signal"
  | "result"
  | "error"
  | "trade"
  | "order"
  | "hypothetical"
  | "mission"
  | "note"
  | "lesson"
  | "review"
  | "plan"
  | "request"
  | "session"
  | "step";

/** Los agentes de dementeking: el trader (misiones largas) y, en las rápidas, el ejecutor, el cerebro y el revisor. */
export type AgentName = "trader" | "executor" | "planner" | "reviewer";

export interface TimelineEvent {
  id: string;
  ts: string;
  kind: EventKind;
  title: string;
  /** Motivo o tesis de una operación: se muestra siempre visible. */
  note?: string;
  body?: string;
  /** Quién habla, si se sabe: el agente de la transcripción, o el revisor en lo que guarda en la memoria. */
  agent?: AgentName;
  /** Herramienta del simulador de la que sale (sin prefijo), p. ej. 'wait_for_signal'. */
  tool?: string;
  /** Cuándo llegó el resultado de esa herramienta (una espera puede durar minutos). */
  endTs?: string;
}

/** Una sesión de un agente de dementeking: lo que usa el panel para decir quién está trabajando ahora. */
export interface AgentSession {
  agent: AgentName;
  /** Hilo principal (una sesión lanzada con --agent) o subagente dentro de otra sesión. */
  main: boolean;
  startedAt: string;
  lastAt: string;
  /** La sesión ha terminado (solo se sabe en el hilo principal: su última línea es cost-state). */
  ended: boolean;
  prompt: string | null;
}

// CLAUDE_CONFIG_DIR es donde Claude Code guarda su configuración y sus sesiones si no es ~/.claude.
const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
// Los agentes se llaman `trader`, `executor`… en el proyecto y `dementeking:trader`… dentro del plugin.
const DK_AGENT = /^(?:dementeking:)?(trader|executor|planner|reviewer)$/;
export const agentName = (raw: unknown): AgentName | null => (typeof raw === "string" ? ((raw.match(DK_AGENT)?.[1] as AgentName | undefined) ?? null) : null);
const AGENT_LABEL: Record<AgentName, string> = { trader: "El agente", executor: "El ejecutor", planner: "El cerebro", reviewer: "El revisor" };
// Las herramientas se llaman mcp__cryptosim__* en el proyecto y mcp__plugin_dementeking_cryptosim__* en el plugin.
const normalizeTool = (name: string) => name.replace(/^mcp__plugin_dementeking_cryptosim__/, "mcp__cryptosim__");

// Herramientas del simulador cuyo efecto ya aparece en el diario o en la bitácora (se evitan duplicados). Salvo la
// entrada de las misiones rápidas y el plan del cerebro: son los pasos clave de la tanda y su resultado dice más.
const SHOWN_ANYWAY = new Set(["enter_with_exits", "write_plan"]);
const COVERED_BY_DB = new Set(SIM_TOOLS.filter((t) => t.journaled && !SHOWN_ANYWAY.has(t.name)).map((t) => `mcp__cryptosim__${t.name}`));

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[captura de pantalla]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const short = (s: unknown, n = 140) => {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
};
const shortMint = (s: string) => (s.length > 16 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
const firstSentence = (s: string) => (s.trim().split(/(?<=[.!?])\s/)[0] ?? s).trim();
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Lo que se va sabiendo al leer una transcripción: el nombre de los tokens que devuelve wait_for_signal. */
interface ParseCtx {
  symbols: Map<string, string>;
}

// Cómo se cuenta cada herramienta del simulador en la radio (las que no están, «Consulta <nombre>»).
const SIM_TITLES: Record<string, (input: any, ctx: ParseCtx) => string> = {
  wait_for_signal: (i) => `Espera la señal del plan${i.plan_ref ? ` #${i.plan_ref}` : ""}`,
  enter_with_exits: (i, ctx) => `Entra en ${ctx.symbols.get(String(i.token)) ?? shortMint(String(i.token ?? "el token"))} con su toma de beneficio`,
  get_plan: (i) => (i.plan_id ?? i.plan_ref ? `Lee el plan #${i.plan_id ?? i.plan_ref}` : "Lee el plan vigente"),
  write_plan: (i) => `Escribe un plan nuevo${i.event ? `: ${short(i.event, 90)}` : ""}`,
  entry_dataset: () => "Repasa las entradas medidas: su ficha y su resultado con velas",
  mission_status: () => "Mira cómo va la misión",
  portfolio: () => "Mira la cartera",
  strategy_fit: (i) => `Mira qué estrategia encaja${i.duration_minutes ? ` con ${i.duration_minutes} min` : ""}${i.target_pct ? ` y +${i.target_pct} %` : ""}`,
  trade_history: () => "Repasa sus operaciones anteriores",
  exploration_map: () => "Mira el mapa de lo que ya ha probado",
  journal_history: () => "Lee el diario de las misiones",
  review_queue: () => "Mira qué misiones faltan por revisar",
  mission_review_data: (i) => `Reúne los datos de la misión${i.mission_id ? ` #${i.mission_id}` : ""}`,
  memory_catalog: () => "Repasa lo que hay en la memoria",
  mark_mission_reviewed: (i) => `Da por revisada la misión${i.mission_id ? ` #${i.mission_id}` : ""}`,
  review_checkpoint: () => "Marca hasta dónde ha revisado",
  write_briefing: () => "Escribe el briefing de la misión",
  resolve_observation: () => "Resuelve una observación del agente",
  wait_for_activity: () => "Espera a que haya actividad",
  list_orders: () => "Mira sus órdenes",
  token_report: (i, ctx) =>
    i.token
      ? `Lee la ficha de ${ctx.symbols.get(String(i.token)) ?? shortMint(String(i.token))}`
      : `Lee la ficha de ${Array.isArray(i.tokens) ? i.tokens.length : "varios"} token${Array.isArray(i.tokens) && i.tokens.length === 1 ? "" : "s"}`,
  quote_swap: (i, ctx) => {
    const name = (x: unknown) => ctx.symbols.get(String(x)) ?? shortMint(String(x ?? "?"));
    return `Cotiza ${i.amount ?? ""} ${name(i.input)} → ${name(i.output)}`.replace(/\s+/g, " ");
  },
};

function describeToolUse(rawName: string, input: any, ctx: ParseCtx = { symbols: new Map() }): { kind: EventKind; title: string; tool?: string } | null {
  const name = normalizeTool(rawName);
  if (name === "ToolSearch" || name === "SubagentHandback" || COVERED_BY_DB.has(name)) return null;
  if (name === "WebSearch") return { kind: "search", title: input.query ? `Busca en internet: «${input.query}»` : "Busca en internet" };
  if (name === "WebFetch") return { kind: "fetch", title: input.url ? `Lee ${input.url}` : "Lee una página" };
  if (name === "mcp__cryptosim__http_get") return { kind: "fetch", title: input.url ? `Consulta ${input.url}` : "Consulta una API" };
  if (name === "mcp__cryptosim__start_session") return { kind: "session", title: "Empieza una sesión de trabajo" };
  if (name === "mcp__cryptosim__end_session") return { kind: "session", title: "Cierra la sesión" };
  if (name === "mcp__cryptosim__recall_memory") return { kind: "tool", title: "Repasa su memoria de misiones anteriores" };
  if (name === "mcp__cryptosim__wait") return { kind: "tool", title: input.minutes ? `Espera ${input.minutes} min` : "Espera", tool: "wait" };
  if (name.startsWith("mcp__cryptosim__")) {
    const tool = name.replace("mcp__cryptosim__", "");
    const describe = SIM_TITLES[tool];
    return { kind: "tool", title: describe ? describe(input, ctx) : `Consulta ${tool.replace(/_/g, " ")}`, tool };
  }

  const browser = name.match(/^mcp__Claude_Browser__(.+)$/)?.[1];
  if (browser) {
    switch (browser) {
      case "navigate":
        return { kind: "browse", title: `Abre ${input.url}` };
      case "get_page_text":
      case "read_page":
        return { kind: "browse", title: "Lee la página" };
      case "find":
        return { kind: "browse", title: `Busca en la página: «${input.query}»` };
      case "computer":
        return { kind: "browse", title: `Navegador: ${input.action}${input.text ? ` «${short(input.text, 60)}»` : ""}` };
      case "form_input":
        return { kind: "browse", title: "Rellena un campo de la página" };
      case "javascript_tool":
        return { kind: "browse", title: "Inspecciona la página con JavaScript" };
      case "browser_batch":
        return { kind: "browse", title: `Navegador: ${input.actions?.length ?? "varias"} acciones seguidas` };
      default:
        return { kind: "browse", title: `Navegador: ${browser.replace(/_/g, " ")}` };
    }
  }
  return { kind: "tool", title: name };
}

/**
 * Con el resultado, el título de los pasos clave de una misión rápida dice lo que pasó: la señal (o por qué no la hubo)
 * y la entrada.
 */
function refineWithResult(ev: TimelineEvent, text: string, isError: boolean, ctx: ParseCtx) {
  if (ev.tool === "wait_for_signal" && !isError) {
    const signal = text.match(/^signal: (.+)$/m)?.[1];
    if (signal) {
      const token = text.match(/^token: (\S+)/m)?.[1];
      const symbol = text.match(/^symbol: (.+)$/m)?.[1]?.trim();
      if (token && symbol) ctx.symbols.set(token, symbol);
      const age = text.match(/^poolAgeSeconds: (\d+)/m)?.[1];
      ev.kind = "signal";
      ev.title = `Señal: ${signal}${age ? ` (pool de ${age} s)` : ""}`;
    } else {
      const seen = text.match(/Tokens frescos vistos: (\d+)/)?.[1];
      ev.title = `Espera la señal: ${lowerFirst(firstSentence(text).replace(/\.$/, ""))}${seen ? ` · ${seen} token${seen === "1" ? "" : "s"} vistos` : ""}`;
    }
  } else if (ev.tool === "wait" && !isError) {
    // El motivo puede llevar paréntesis («JOKERINU (solana) se ha movido un -79.4 %»): llega hasta el «).» que cierra la
    // frase, antes de «Hora:». Con /m, también cuando va detrás del aviso de espera acortada.
    const m = text.match(/^Han pasado ([\d.]+) min(?: \(vuelvo antes: (.+)\)\.)?/m);
    // Si vuelve porque la posición se ha movido, el token y el movimiento van delante: la radio corta las líneas largas.
    const moved = m?.[2]?.match(/^(.+?)(?: \([^()]+\))? se ha movido un ([+-]?[\d.]+) %$/);
    if (moved) ev.title = `${ev.title}: ${moved[1]} ${moved[2]} % a los ${m![1]} min`;
    else if (m) ev.title = m[2] ? `${ev.title}: vuelve a los ${m[1]} min, ${m[2]}` : `${ev.title}: ${/^Novedades:/m.test(text) ? "hay novedades" : "sin novedades"}`;
  } else if (ev.tool === "enter_with_exits") {
    // Compró, pero no pudo poner la toma de beneficio: ya hay posición y el reloj corre. No es una entrada rechazada.
    const bought = isError ? text.match(/La compra de (.+?) SÍ se ha hecho/) : null;
    if (bought) {
      const why = text.match(/no se ha podido calcular ni poner \(([\s\S]+)\)\. Ponla/)?.[1];
      // Lo que importa, delante (la radio corta las líneas largas); las cantidades quedan en el detalle.
      ev.title = `Entra en ${bought[1]} sin toma de beneficio${why ? `: ${short(why, 140)}` : ""}`;
    } else if (isError) ev.title = `No entra: ${short(firstSentence(text.replace(/^Error:\s*/, "")), 160)}`;
    else {
      try {
        const r = JSON.parse(text) as { buy?: { received?: string } };
        const got = r.buy?.received?.match(/^[\d.]+\s+(.+)$/)?.[1];
        ev.title = `Entra${got ? ` en ${got}` : ""}: compra hecha, toma de beneficio puesta y reloj en marcha`;
      } catch {
        // Otro formato: se queda el título de la llamada.
      }
    }
  }
}

// Caché por archivo: solo se vuelve a leer si ha cambiado.
interface Parsed {
  events: TimelineEvent[];
  startedAt: string | null;
  lastAt: string | null;
  ended: boolean;
  prompt: string | null;
}
const fileCache = new Map<string, { mtimeMs: number; size: number; parsed: Parsed }>();

const durationText = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

function parseTranscript(file: string, agent: AgentName, main: boolean): Parsed {
  const events: TimelineEvent[] = [];
  const byToolId = new Map<string, TimelineEvent>();
  const ctx: ParseCtx = { symbols: new Map() };
  let startedAt: string | null = null;
  let lastAt: string | null = null;
  let prompt: string | null = null;
  let ended = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // línea a medio escribir
    }
    if (typeof entry.timestamp === "string") {
      startedAt ??= entry.timestamp;
      if (!lastAt || entry.timestamp > lastAt) lastAt = entry.timestamp;
    }
    // Una sesión lanzada con --agent: el encargo (su primer mensaje) y el final, como pasos del equipo.
    if (main && entry.type === "user" && prompt === null && typeof entry.message?.content === "string") {
      prompt = entry.message.content.trim();
      events.push({ id: `${entry.sessionId ?? file}:start`, ts: entry.timestamp, kind: "step", agent, title: `${AGENT_LABEL[agent]} empieza: «${short(prompt, 80)}»` });
      continue;
    }
    if (main && entry.type === "cost-state") {
      ended = true;
      const extra = [
        typeof entry.totalDuration === "number" ? durationText(entry.totalDuration) : null,
        typeof entry.totalCostUSD === "number" ? `${entry.totalCostUSD.toFixed(2).replace(".", ",")} $ de modelo` : null,
      ].filter(Boolean);
      // Un milisegundo después de lo último que escribió: el final va detrás de su último mensaje.
      if (lastAt) events.push({ id: `${entry.sessionId ?? file}:end`, ts: new Date(Date.parse(lastAt) + 1).toISOString(), kind: "step", agent, title: `${AGENT_LABEL[agent]} termina${extra.length ? ` · ${extra.join(" · ")}` : ""}` });
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const [i, block] of content.entries()) {
      if (entry.type === "assistant" && block.type === "text" && block.text?.trim()) {
        events.push({ id: `${entry.uuid}:${i}`, ts: entry.timestamp, kind: "text", agent, title: block.text.trim() });
      } else if (entry.type === "assistant" && block.type === "tool_use") {
        const d = describeToolUse(block.name, block.input ?? {}, ctx);
        if (!d) continue;
        const ev: TimelineEvent = { id: block.id, ts: entry.timestamp, agent, ...d };
        byToolId.set(block.id, ev);
        events.push(ev);
      } else if (block.type === "tool_result") {
        const ev = byToolId.get(block.tool_use_id);
        if (!ev) continue;
        const text = resultText(block.content).trim();
        if (text) ev.body = text.length > 3000 ? text.slice(0, 3000) + "\n…" : text;
        if (ev.tool) {
          ev.endTs = entry.timestamp;
          refineWithResult(ev, text, !!block.is_error, ctx);
        }
        if (block.is_error) ev.kind = "error";
      }
    }
  }
  return { events, startedAt, lastAt, ended, prompt };
}

// ── OpenCode ────────────────────────────────────────────────────────────────
// OpenCode guarda sus sesiones en SQLite (session_v2 con el agente de cada sesión, session_message con
// los mensajes). En OpenCode 2 los modelos llaman a las herramientas MCP escribiendo código en su
// herramienta `execute` (tools.cryptosim.scan_market({...})); el nombre real queda en metadata.toolCalls.
const OPENCODE_DB = process.env.OPENCODE_DB ?? path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
let opencodeDb: DatabaseSync | null = null;

/** Argumentos de una llamada escrita como código (best effort: objetos literales sencillos). */
function argsFromCode(code: string, tool: string): Record<string, unknown> {
  const m = code.match(new RegExp(`cryptosim\\.${tool}\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)`));
  if (!m) return {};
  try {
    return JSON.parse(m[1]!.replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/,\s*}/g, "}"));
  } catch {
    return {};
  }
}

function opencodeEvents(since: string): TimelineEvent[] {
  if (!existsSync(OPENCODE_DB)) return [];
  try {
    opencodeDb ??= new DatabaseSync(OPENCODE_DB, { readOnly: true });
    const rows = opencodeDb
      .prepare(
        `SELECT m.id, m.time_created, m.data FROM session_message m JOIN session_v2 s ON s.id = m.session_id
         WHERE s.agent = 'trader' AND m.type = 'assistant' AND m.time_created >= ? ORDER BY m.time_created, m.seq`,
      )
      .all(new Date(since).getTime()) as Array<{ id: string; time_created: number; data: string }>;
    const events: TimelineEvent[] = [];
    for (const row of rows) {
      const ts = new Date(row.time_created).toISOString();
      const content = (JSON.parse(row.data).content ?? []) as any[];
      content.forEach((part, i) => {
        const id = `oc:${row.id}:${i}`;
        if (part.type === "text" && part.text?.trim()) {
          events.push({ id, ts, kind: "text", title: part.text.trim() });
          return;
        }
        if (part.type !== "tool") return;
        const input = part.state?.input ?? {};
        const result = resultText(part.state?.content ?? "").trim();
        const body = result ? (result.length > 3000 ? result.slice(0, 3000) + "\n…" : result) : undefined;
        const failed = part.state?.status === "error";
        const calls: Array<{ name: string; input: Record<string, unknown> }> =
          part.name === "execute"
            ? ((part.state?.metadata?.toolCalls ?? []) as Array<{ tool: string }>).map((c) => {
                const tool = c.tool.replace(/^cryptosim\./, "");
                return { name: c.tool.startsWith("cryptosim.") ? `mcp__cryptosim__${tool}` : c.tool, input: argsFromCode(String(input.code ?? ""), tool) };
              })
            : [{ name: part.name === "webfetch" ? "WebFetch" : part.name === "websearch" ? "WebSearch" : part.name, input }];
        calls.forEach((c, j) => {
          const d = describeToolUse(c.name, c.input);
          if (!d) return;
          // El resultado de un execute es el de todo el bloque: se adjunta a su última llamada.
          events.push({ id: `${id}:${j}`, ts, ...d, ...(failed ? { kind: "error" as EventKind } : {}), ...(j === calls.length - 1 && body ? { body } : {}) });
        });
      });
    }
    return events;
  } catch {
    return []; // formato distinto u OpenCode ocupado: el resto del panel sigue funcionando
  }
}

const isOpencode = () => process.env.CRYPTOAGENT_HOST === "opencode";

/** Qué registro de sesiones leer: el del entorno en el que corre este servidor. */
const agentEvents = (since: string) => (isOpencode() ? opencodeEvents(since) : transcriptEvents(since));

// ── Sesiones de Claude Code ─────────────────────────────────────────────────
// El agente de una sesión del hilo principal no cambia: se lee una vez de su cabecera. Si no está en los primeros
// HEAD_BYTES (una sesión normal de Claude Code) se recuerda que no es de dementeking, salvo en un archivo todavía corto.
const HEAD_BYTES = 16_384;
const mainAgentCache = new Map<string, AgentName | null>();

function mainSessionAgent(file: string, size: number): AgentName | null {
  if (mainAgentCache.has(file)) return mainAgentCache.get(file)!;
  let head = "";
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let agent: AgentName | null = null;
  for (const line of head.split("\n")) {
    if (!line.includes('"agent-setting"')) continue;
    try {
      agent = agentName(JSON.parse(line).agentSetting);
    } catch {
      continue;
    }
    if (agent) break;
  }
  if (agent || size >= HEAD_BYTES) mainAgentCache.set(file, agent);
  return agent;
}

/** Transcripciones de agentes de dementeking con actividad desde `sinceMs`: las del hilo principal y las de subagentes. */
function agentTranscripts(sinceMs: number): Array<{ file: string; agent: AgentName; main: boolean; mtimeMs: number; size: number }> {
  const root = projectsDir();
  if (!existsSync(root)) return [];
  const found: Array<{ file: string; agent: AgentName; main: boolean; mtimeMs: number; size: number }> = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  for (const project of projects) {
    const dir = path.join(root, project);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      if (name.endsWith(".jsonl")) {
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.mtimeMs < sinceMs) continue; // sin actividad desde el inicio de la misión
        const agent = mainSessionAgent(full, st.size);
        if (agent) found.push({ file: full, agent, main: true, mtimeMs: st.mtimeMs, size: st.size });
        continue;
      }
      const subDir = path.join(full, "subagents");
      if (!existsSync(subDir)) continue;
      for (const f of readdirSync(subDir)) {
        if (!f.endsWith(".meta.json")) continue;
        const file = path.join(subDir, f.replace(".meta.json", ".jsonl"));
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (st.mtimeMs < sinceMs) continue;
        let agent: AgentName | null;
        try {
          agent = agentName(JSON.parse(readFileSync(path.join(subDir, f), "utf8")).agentType);
        } catch {
          continue;
        }
        if (agent) found.push({ file, agent, main: false, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }
  return found;
}

// El panel pide eventos, sesiones y nombres de tokens en cada vuelta: la carpeta se recorre una sola vez por vuelta.
let scanMemo: { sinceMs: number; at: number; found: ReturnType<typeof agentTranscripts> } | null = null;

function parsedTranscripts(since: string): Array<{ agent: AgentName; main: boolean; mtimeMs: number; parsed: Parsed }> {
  const parsedSince = new Date(since).getTime();
  const sinceMs = Number.isFinite(parsedSince) ? parsedSince : 0;
  if (!scanMemo || scanMemo.sinceMs !== sinceMs || Date.now() - scanMemo.at > 1500) scanMemo = { sinceMs, at: Date.now(), found: agentTranscripts(sinceMs) };
  return scanMemo.found.map(({ file, agent, main, mtimeMs, size }) => {
    const cached = fileCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return { agent, main, mtimeMs, parsed: cached.parsed };
    const parsed = parseTranscript(file, agent, main);
    fileCache.set(file, { mtimeMs, size, parsed });
    return { agent, main, mtimeMs, parsed };
  });
}

function transcriptEvents(since: string): TimelineEvent[] {
  return parsedTranscripts(since).flatMap((t) => t.parsed.events);
}

/**
 * Las sesiones de agentes de dementeking con actividad desde `since`, de la más reciente a la más antigua. En OpenCode,
 * ninguna (sus sesiones no dicen cuándo terminan).
 */
export function agentSessions(since: string): AgentSession[] {
  if (isOpencode()) return [];
  return parsedTranscripts(since)
    .filter((t) => t.parsed.startedAt)
    .map((t) => ({
      agent: t.agent,
      main: t.main,
      startedAt: t.parsed.startedAt!,
      // La hora del archivo cuenta también lo que se escribe sin hora (el final de la sesión).
      lastAt: [t.parsed.lastAt ?? t.parsed.startedAt!, new Date(t.mtimeMs).toISOString()].sort().at(-1)!,
      ended: t.parsed.ended,
      prompt: t.parsed.prompt,
    }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** Nombre de los tokens que ha devuelto wait_for_signal desde `since` (el diario solo guarda la dirección). */
export function signalSymbols(since: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (isOpencode()) return out;
  for (const t of parsedTranscripts(since)) {
    for (const e of t.parsed.events) {
      if (e.kind !== "signal" || !e.body) continue;
      const token = e.body.match(/^token: (\S+)/m)?.[1];
      const symbol = e.body.match(/^symbol: (.+)$/m)?.[1]?.trim();
      if (token && symbol) out[token] = symbol;
    }
  }
  return out;
}

const JOURNAL_KIND: Record<string, EventKind> = {
  swap: "trade",
  cex_order: "trade",
  transfer: "trade",
  order_placed: "order",
  order_cancelled: "order",
  order_expired: "order",
  order_failed: "error",
  transfer_arrived: "trade",
  failed_tx: "error",
  rejected: "error",
  hypothetical: "hypothetical",
  mission: "mission",
  // El gemelo mecánico de una misión rápida termina: un hito, como los de la misión.
  shadow: "mission",
  plan: "plan",
};

/**
 * Lo que el diario repite de la transcripción: la espera sin señal de antes del reloj (kind 'signal') y la entrada
 * rechazada ('rejected') salen ya de la llamada, con su resultado. Se quitan las del diario escritas a la vez que llegó
 * ese resultado (5 s de margen).
 */
const DUPLICATED_BY_TRANSCRIPT: Record<string, string> = { signal: "wait_for_signal", rejected: "enter_with_exits" };

function dbEvents(missionId: number | null, agent: TimelineEvent[]): TimelineEvent[] {
  if (missionId === null) return [];
  const ends = new Map<string, number[]>();
  for (const e of agent) if (e.tool && e.endTs) ends.set(e.tool, [...(ends.get(e.tool) ?? []), Date.parse(e.endTs)]);
  const duplicated = (kind: string, ts: string) => {
    const tool = DUPLICATED_BY_TRANSCRIPT[kind];
    const t = Date.parse(ts);
    return !!tool && (ends.get(tool) ?? []).some((end) => Math.abs(end - t) <= 5000);
  };
  const events: TimelineEvent[] = [];
  for (const a of db.prepare("SELECT id, ts, kind, title, body FROM activity WHERE mission_id = ?").all(missionId) as any[]) {
    events.push({ id: `a${a.id}`, ts: a.ts, kind: a.kind, title: a.title, body: a.body ?? undefined, ...(a.kind === "lesson" || a.kind === "review" ? { agent: "reviewer" as const } : {}) });
  }
  for (const j of db.prepare("SELECT id, ts, kind, summary, reasoning, details FROM journal WHERE mission_id = ?").all(missionId) as any[]) {
    if (duplicated(j.kind, j.ts)) continue;
    events.push({
      id: `j${j.id}`,
      ts: j.ts,
      kind: JOURNAL_KIND[j.kind] ?? "tool",
      title: j.summary,
      note: j.reasoning ?? undefined,
      body: j.details ? JSON.stringify(JSON.parse(j.details), null, 2) : undefined,
      ...(j.kind === "plan" ? { agent: "planner" as const } : {}),
    });
  }
  // Lo que el revisor guarda o corrige en la memoria llega por la tabla `activity` (kind "lesson").
  for (const n of db.prepare("SELECT id, ts, text FROM notes WHERE mission_id = ?").all(missionId) as any[]) {
    events.push({ id: `n${n.id}`, ts: n.ts, kind: "note", title: n.text });
  }
  return events;
}

/** Eventos desde `since` (ISO), ordenados del más antiguo al más reciente. */
export function timeline(since: string, missionId: number | null): TimelineEvent[] {
  // Lo de la base de datos ya va filtrado por misión: no se recorta por hora. El inicio de la misión se
  // mueve al arrancar el reloj, y el briefing que el revisor escribe justo antes quedaba fuera.
  const agent = agentEvents(since).filter((e) => e.ts && e.ts >= since);
  return [...agent, ...previousLessons(missionId), ...dbEvents(missionId, agent)].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
}

/**
 * Lo que aprendió el revisor al cerrar la misión anterior (retrospectiva y cambios en la memoria): es lo que
 * el trader aplica en esta, así que también sale en el panel. Se guarda con la misión anterior; sin esto,
 * la pestaña Aprende se quedaba vacía al empezar cada misión.
 */
function previousLessons(missionId: number | null): TimelineEvent[] {
  if (missionId === null) return [];
  const prev = db.prepare("SELECT id, ended_at FROM missions WHERE id < ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1").get(missionId) as
    | { id: number; ended_at: string }
    | undefined;
  if (!prev) return [];
  return (
    db
      .prepare("SELECT id, ts, kind, title, body FROM activity WHERE mission_id = ? AND kind IN ('lesson', 'review') AND ts >= ? ORDER BY id")
      .all(prev.id, prev.ended_at) as Array<{ id: number; ts: string; kind: EventKind; title: string; body: string | null }>
  ).map((a) => ({ id: `a${a.id}`, ts: a.ts, kind: a.kind, agent: "reviewer" as const, title: `Misión #${prev.id}: ${a.title}`, body: a.body ?? undefined }));
}
