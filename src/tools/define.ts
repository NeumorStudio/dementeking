import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ClockStart } from "../sim/mission.js";

export type ToolOutput = string | Anthropic.Beta.BetaToolResultBlockParam["content"];

/** Contexto de cada llamada: la sesión de trabajo y la misión sobre la que actúa (null si no hay ninguna). */
export interface ToolCtx {
  sessionId: number;
  missionId: number | null;
  /**
   * Arranca el reloj de la misión indicada (la de esta llamada: nunca «la activa», que puede ser otra si la han sustituido
   * mientras tanto) exactamente como start_session (sin el briefing) y devuelve la sesión de trabajo nueva. Lo pone el
   * servidor MCP; sin él, runTool arranca solo el reloj. Ver ToolDef.startsClock. Con una entrada (ToolDef.entry), runTool
   * ya lo ha arrancado a la hora de la compra: aquí solo se abre la sesión.
   */
  startClock?: (missionId: number) => Promise<number>;
}

/**
 * trade: cambia la cartera (solo con misión activa y la retrospectiva hecha).
 * research: investigación. memory: memoria del agente. misc: el resto.
 */
export type ToolKind = "trade" | "research" | "memory" | "misc";

/**
 * Los agentes del plugin (plugin/agents/<nombre>.md):
 * - planner: el cerebro. Escribe el plan de reglas antes del reloj; lee mercado y memoria, pero no opera.
 * - executor: el albañil de las misiones rápidas (15 min o menos): ejecuta el plan vigente.
 * - trader: el que opera las misiones largas.
 * - reviewer: el revisor, que escribe la memoria y las retrospectivas.
 */
export const AGENTS = ["planner", "executor", "trader", "reviewer"] as const;
export type AgentName = (typeof AGENTS)[number];

/**
 * Quién puede usarla: uno o varios agentes, o "user" (la sesión del usuario: comandos). Sin rol, los que operan
 * (OPERATORS). Los agentes comparten el servidor MCP: el reparto se aplica en su configuración (disallowedTools),
 * y un test comprueba que coincide con este campo.
 */
export type ToolRole = AgentName | "user";

/** Los que operan: el trader (misiones largas) y el executor (rápidas). Es el rol por defecto. */
export const OPERATORS = ["trader", "executor"] as const satisfies readonly AgentName[];
/** Mirar el mercado y la cartera sin operar: los que operan y el planner. */
export const MARKET_READERS = [...OPERATORS, "planner"] as const satisfies readonly AgentName[];

/** Roles de una herramienta, con el valor por defecto aplicado. */
export function toolRoles(t: { role?: ToolRole | readonly ToolRole[] }): readonly ToolRole[] {
  return t.role === undefined ? OPERATORS : typeof t.role === "string" ? [t.role] : t.role;
}

/** Lo que devuelve la entrada de una herramienta con startsClock (ToolDef.entry): con qué arranca el reloj. */
export interface EntryResult {
  clock: ClockStart;
}

export interface ToolDef<S extends z.ZodObject, P = undefined, E extends EntryResult | undefined = undefined> {
  name: string;
  kind: ToolKind;
  role?: ToolRole | readonly ToolRole[];
  /**
   * Solo en las de operar (kind 'trade'). Antes de arrancar el reloj, runTool rechaza cualquier operación; una
   * herramienta con startsClock lo arranca ella misma (con ctx.startClock, lo mismo que start_session), pero solo
   * después de pasar su preflight y, si tiene entry, solo cuando esa operación se ha hecho. Es para enter_with_exits:
   * compra, reloj y toma de beneficio en una sola llamada.
   */
  startsClock?: boolean;
  /**
   * Comprobaciones que van antes de arrancar el reloj: runTool la llama antes que nada (misión, tesis, efectivo, token,
   * memoria, cotización) y, si lanza un error, la herramienta falla sin haberlo arrancado. Lo que devuelve le llega a
   * entry y a run como tercer argumento, para no repetirlo. Es para las de startsClock: un error de validación no debe
   * comerse el reloj sin posición.
   */
  preflight?: (input: z.infer<S>, ctx: ToolCtx) => Promise<P>;
  /**
   * La operación que arranca el reloj (la compra de enter_with_exits): la única que se admite antes de él, y solo aquí.
   * runTool la ejecuta tras el preflight y, si el reloj no corría, lo arranca solo cuando ha salido bien, con lo que
   * devuelve (la hora de la compra y la cartera de antes, para el gemelo); después abre la sesión de trabajo, pasa a ella
   * lo que la operación dejó en el diario y llama a run con el resultado como cuarto argumento. Si lanza un error, no
   * queda nada: ni reloj, ni sesión, ni gemelo, ni plan asignado, y el error dice «el reloj no ha arrancado».
   */
  entry?: (input: z.infer<S>, ctx: ToolCtx, prepared: P) => Promise<E>;
  /**
   * Al responder, añade el briefing del revisor si ha cambiado desde la última vez que lo vio el agente.
   * Solo en herramientas del agente que opera (el revisor no debe "consumir" sus propias novedades).
   */
  deliversNews?: boolean;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolCtx, prepared: P, entered: E) => Promise<ToolOutput>;
  /**
   * Si la llamada cuenta como investigación previa a una operación (registro de posiciones),
   * devuelve lo investigado (token, URL…) o undefined si no hay un objetivo concreto.
   */
  researchTarget?: (input: z.infer<S>) => string | string[] | undefined;
  /** Su efecto ya queda en el diario, la bitácora o la memoria: el panel no la repite como llamada. */
  journaled?: boolean;
}

export function tool<S extends z.ZodObject, P = undefined, E extends EntryResult | undefined = undefined>(def: ToolDef<S, P, E>) {
  return def;
}

export { json } from "./format.js";
