import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export type ToolOutput = string | Anthropic.Beta.BetaToolResultBlockParam["content"];

/** Contexto de cada llamada: la sesión de trabajo y la misión sobre la que actúa (null si no hay ninguna). */
export interface ToolCtx {
  sessionId: number;
  missionId: number | null;
  /**
   * Arranca el reloj de la misión exactamente como start_session (sin el briefing) y devuelve la sesión de trabajo
   * nueva. Lo pone el servidor MCP; sin él, runTool arranca solo el reloj. Ver ToolDef.startsClock.
   */
  startClock?: () => Promise<number>;
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

export interface ToolDef<S extends z.ZodObject, P = undefined> {
  name: string;
  kind: ToolKind;
  role?: ToolRole | readonly ToolRole[];
  /**
   * Solo en las de operar (kind 'trade'). Antes de arrancar el reloj, runTool rechaza cualquier operación; una
   * herramienta con startsClock lo arranca ella misma (con ctx.startClock, lo mismo que start_session), pero solo
   * después de pasar su preflight, y opera a continuación. Es para enter_with_exits: reloj, compra y toma de
   * beneficio en una sola llamada.
   */
  startsClock?: boolean;
  /**
   * Comprobaciones que van antes de arrancar el reloj: runTool la llama antes que nada (misión, tesis, efectivo, token,
   * memoria, cotización) y, si lanza un error, la herramienta falla sin haberlo arrancado. Lo que devuelve le llega a
   * run como tercer argumento, para no repetirlo. Es para las de startsClock: un error de validación no debe comerse
   * el reloj sin posición.
   */
  preflight?: (input: z.infer<S>, ctx: ToolCtx) => Promise<P>;
  /**
   * Al responder, añade el briefing del revisor si ha cambiado desde la última vez que lo vio el agente.
   * Solo en herramientas del agente que opera (el revisor no debe "consumir" sus propias novedades).
   */
  deliversNews?: boolean;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolCtx, prepared: P) => Promise<ToolOutput>;
  /**
   * Si la llamada cuenta como investigación previa a una operación (registro de posiciones),
   * devuelve lo investigado (token, URL…) o undefined si no hay un objetivo concreto.
   */
  researchTarget?: (input: z.infer<S>) => string | string[] | undefined;
  /** Su efecto ya queda en el diario, la bitácora o la memoria: el panel no la repite como llamada. */
  journaled?: boolean;
}

export function tool<S extends z.ZodObject, P = undefined>(def: ToolDef<S, P>) {
  return def;
}

export { json } from "./format.js";
