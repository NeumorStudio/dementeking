// Herramientas del runner por API: las del simulador más el navegador propio (Playwright).
// El servidor MCP no importa este módulo, así que no depende de Playwright.
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { BROWSER_TOOLS, closeBrowser } from "./browser-tools.js";
import { toolRoles, type ToolCtx } from "./define.js";
import { runTool as runSimTool, SIM_TOOLS } from "./index.js";

export type AgentRole = "trader" | "reviewer";

// Cada agente ve solo las herramientas de su rol (en el plugin lo decide disallowedTools). El runner por API solo
// lanza el trader y el revisor: el planner y el executor son de las misiones rápidas del plugin.
const forRole = (role: AgentRole) => SIM_TOOLS.filter((t) => toolRoles(t).includes(role));

const TOOLS: Record<AgentRole, ReadonlyArray<{ name: string; description: string; schema: z.ZodObject }>> = {
  trader: [...BROWSER_TOOLS, ...forRole("trader")],
  reviewer: forRole("reviewer"),
};

export function toolDefinitions(role: AgentRole): Anthropic.Beta.BetaToolUnion[] {
  return [
    ...(role === "trader" ? [{ type: "web_search_20260209", name: "web_search" } as Anthropic.Beta.BetaToolUnion] : []),
    ...TOOLS[role].map(
      (t): Anthropic.Beta.BetaTool => ({
        name: t.name,
        description: t.description,
        input_schema: z.toJSONSchema(t.schema, { io: "input" }) as Anthropic.Beta.BetaTool.InputSchema,
      }),
    ),
  ];
}

export const runTool = (role: AgentRole, name: string, rawInput: unknown, ctx: ToolCtx) => runSimTool(name, rawInput, ctx, TOOLS[role] as never);

export const closeTools = closeBrowser;
