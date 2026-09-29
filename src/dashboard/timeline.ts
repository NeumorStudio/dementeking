// Línea de tiempo del agente para el panel. Une tres fuentes:
//  1. El registro de sesiones de Claude Code (~/.claude/projects/*/*/subagents/*.jsonl), en cualquier
//     proyecto: búsquedas, páginas que abre, peticiones y textos del subagente `trader`. Es un formato
//     interno de Claude Code; si cambia, esta parte puede dejar de leerse, pero el resto sigue.
//  2. La tabla `activity`: registro de trabajo (log_progress) y, con el runner por API, todo su razonamiento.
//  3. El diario del simulador y las notas: operaciones, órdenes, misiones.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  | "result"
  | "error"
  | "trade"
  | "order"
  | "hypothetical"
  | "mission"
  | "note"
  | "lesson"
  | "review"
  | "request"
  | "session";

export interface TimelineEvent {
  id: string;
  ts: string;
  kind: EventKind;
  title: string;
  /** Motivo o tesis de una operación: se muestra siempre visible. */
  note?: string;
  body?: string;
}

const projectsDir = path.join(os.homedir(), ".claude", "projects");
// El agente se llama `trader` en el proyecto y `dementeking:trader` dentro del plugin.
const TRADER_AGENT = /^(dementeking:)?trader$/;
// Las herramientas se llaman mcp__cryptosim__* en el proyecto y mcp__plugin_dementeking_cryptosim__* en el plugin.
const normalizeTool = (name: string) => name.replace(/^mcp__plugin_dementeking_cryptosim__/, "mcp__cryptosim__");

// Herramientas del simulador cuyo efecto ya aparece en el diario o en la bitácora (se evitan duplicados).
const COVERED_BY_DB = new Set(SIM_TOOLS.filter((t) => t.journaled).map((t) => `mcp__cryptosim__${t.name}`));

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

function describeToolUse(rawName: string, input: any): { kind: EventKind; title: string } | null {
  const name = normalizeTool(rawName);
  if (name === "ToolSearch" || name === "SubagentHandback" || COVERED_BY_DB.has(name)) return null;
  if (name === "WebSearch") return { kind: "search", title: input.query ? `Busca en internet: «${input.query}»` : "Busca en internet" };
  if (name === "WebFetch") return { kind: "fetch", title: input.url ? `Lee ${input.url}` : "Lee una página" };
  if (name === "mcp__cryptosim__http_get") return { kind: "fetch", title: input.url ? `Consulta ${input.url}` : "Consulta una API" };
  if (name === "mcp__cryptosim__start_session") return { kind: "session", title: "Empieza una sesión de trabajo" };
  if (name === "mcp__cryptosim__end_session") return { kind: "session", title: "Cierra la sesión" };
  if (name === "mcp__cryptosim__recall_memory") return { kind: "tool", title: "Repasa su memoria de misiones anteriores" };
  if (name === "mcp__cryptosim__wait") return { kind: "tool", title: input.minutes ? `Espera ${input.minutes} min` : "Espera" };
  if (name.startsWith("mcp__cryptosim__")) return { kind: "tool", title: `Consulta ${name.replace("mcp__cryptosim__", "").replace(/_/g, " ")}` };

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

// Caché por archivo: solo se vuelve a leer si ha cambiado.
const fileCache = new Map<string, { mtimeMs: number; size: number; events: TimelineEvent[] }>();

function parseTranscript(file: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const byToolId = new Map<string, TimelineEvent>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // línea a medio escribir
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const [i, block] of content.entries()) {
      if (entry.type === "assistant" && block.type === "text" && block.text?.trim()) {
        events.push({ id: `${entry.uuid}:${i}`, ts: entry.timestamp, kind: "text", title: block.text.trim() });
      } else if (entry.type === "assistant" && block.type === "tool_use") {
        const d = describeToolUse(block.name, block.input ?? {});
        if (!d) continue;
        const ev: TimelineEvent = { id: block.id, ts: entry.timestamp, ...d };
        byToolId.set(block.id, ev);
        events.push(ev);
      } else if (block.type === "tool_result") {
        const ev = byToolId.get(block.tool_use_id);
        if (!ev) continue;
        const text = resultText(block.content).trim();
        if (text) ev.body = text.length > 3000 ? text.slice(0, 3000) + "\n…" : text;
        if (block.is_error) ev.kind = "error";
      }
    }
  }
  return events;
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

/** Qué registro de sesiones leer: el del entorno en el que corre este servidor. */
const agentEvents = (since: string) => (process.env.CRYPTOAGENT_HOST === "opencode" ? opencodeEvents(since) : transcriptEvents(since));

function transcriptEvents(since: string): TimelineEvent[] {
  if (!existsSync(projectsDir)) return [];
  const sinceMs = new Date(since).getTime();
  const events: TimelineEvent[] = [];
  const sessionDirs = readdirSync(projectsDir).flatMap((project) => {
    const dir = path.join(projectsDir, project);
    try {
      return readdirSync(dir).map((s) => path.join(dir, s, "subagents"));
    } catch {
      return [];
    }
  });
  for (const subDir of sessionDirs) {
    if (!existsSync(subDir)) continue;
    for (const f of readdirSync(subDir)) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        if (!TRADER_AGENT.test(JSON.parse(readFileSync(path.join(subDir, f), "utf8")).agentType ?? "")) continue;
      } catch {
        continue;
      }
      const file = path.join(subDir, f.replace(".meta.json", ".jsonl"));
      if (!existsSync(file)) continue;
      const st = statSync(file);
      if (st.mtimeMs < sinceMs) continue; // sin actividad desde el inicio de la misión
      const cached = fileCache.get(file);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        events.push(...cached.events);
        continue;
      }
      const parsed = parseTranscript(file);
      fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, events: parsed });
      events.push(...parsed);
    }
  }
  return events;
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
};

function dbEvents(missionId: number | null): TimelineEvent[] {
  if (missionId === null) return [];
  const events: TimelineEvent[] = [];
  for (const a of db.prepare("SELECT id, ts, kind, title, body FROM activity WHERE mission_id = ?").all(missionId) as any[]) {
    events.push({ id: `a${a.id}`, ts: a.ts, kind: a.kind, title: a.title, body: a.body ?? undefined });
  }
  for (const j of db.prepare("SELECT id, ts, kind, summary, reasoning, details FROM journal WHERE mission_id = ?").all(missionId) as any[]) {
    events.push({
      id: `j${j.id}`,
      ts: j.ts,
      kind: JOURNAL_KIND[j.kind] ?? "tool",
      title: j.summary,
      note: j.reasoning ?? undefined,
      body: j.details ? JSON.stringify(JSON.parse(j.details), null, 2) : undefined,
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
  return [...agentEvents(since).filter((e) => e.ts && e.ts >= since), ...previousLessons(missionId), ...dbEvents(missionId)].sort(
    (a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id),
  );
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
  ).map((a) => ({ id: `a${a.id}`, ts: a.ts, kind: a.kind, title: `Misión #${prev.id}: ${a.title}`, body: a.body ?? undefined }));
}
