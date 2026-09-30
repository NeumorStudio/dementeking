// Los cuatro agentes (planner, executor, trader y revisor) comparten el servidor MCP: qué herramientas puede usar cada
// uno se decide en su configuración (disallowedTools). Este test comprueba que coincide con el campo `role`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AGENTS, OPERATORS, toolRoles, type ToolRole } from "../src/tools/define.js";
import { SIM_TOOLS } from "../src/tools/index.js";

const root = path.resolve(import.meta.dirname, "..");
const PREFIX = "mcp__plugin_dementeking_cryptosim__";

function frontmatter(agent: string) {
  const md = readFileSync(path.join(root, "plugin/agents", `${agent}.md`), "utf8");
  return md.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
}

function disallowed(agent: string) {
  const line = frontmatter(agent).match(/^disallowedTools:(.*)$/m)?.[1] ?? "";
  return new Set(
    line
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(PREFIX, "")),
  );
}

// Herramientas definidas directamente en mcp.ts: las de la sesión de los que operan y las del usuario.
const MCP_ROLES: Record<string, readonly ToolRole[]> = {
  start_session: OPERATORS,
  end_session: OPERATORS,
  create_mission: ["user"],
  stop_mission: ["user"],
  status_report: ["user"],
  start_dashboard: ["user"],
  stop_dashboard: ["user"],
  start_wallet: ["user"],
  wallet_status: ["user"],
  export_taxes: ["user"],
};

const roles = new Map<string, readonly ToolRole[]>([...SIM_TOOLS.map((t) => [t.name, toolRoles(t)] as const), ...Object.entries(MCP_ROLES)]);

test("mcp.ts no define herramientas sin rol conocido", () => {
  const src = readFileSync(path.join(root, "src/mcp.ts"), "utf8");
  const names = [...src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(names.sort(), Object.keys(MCP_ROLES).sort());
});

for (const agent of AGENTS) {
  test(`${agent}: puede usar justo las herramientas de su rol`, () => {
    assert.match(frontmatter(agent), new RegExp(`^name: ${agent}$`, "m"));
    const blocked = disallowed(agent);
    const wrong: string[] = [];
    for (const [name, r] of roles) {
      const shouldBlock = !r.includes(agent);
      if (shouldBlock !== blocked.has(name)) wrong.push(`${name} (rol ${r.join("/")}): ${shouldBlock ? "debería estar bloqueada" : "no debería estar bloqueada"}`);
    }
    for (const name of blocked) if (!roles.has(name)) wrong.push(`${name}: bloqueada pero no existe`);
    assert.deepEqual(wrong, []);
  });
}

test("reparto: el planner no opera ni arranca el reloj, solo él escribe el plan y todos lo leen", () => {
  const can = (agent: string, name: string) => roles.get(name)!.includes(agent as ToolRole);
  const trading = SIM_TOOLS.filter((t) => t.kind === "trade").map((t) => t.name);
  for (const name of [...trading, "start_session", "create_mission", "stop_mission", "cancel_order", "wait_for_signal"]) assert.equal(can("planner", name), false, name);
  for (const name of ["scan_market", "token_report", "quote_swap", "http_get", "mission_status", "portfolio", "strategy_fit", "recall_memory", "write_plan", "get_plan"]) {
    assert.equal(can("planner", name), true, name);
  }
  for (const agent of AGENTS) assert.equal(can(agent, "get_plan"), true, `${agent} lee el plan`);
  assert.deepEqual(
    AGENTS.filter((a) => can(a, "write_plan")),
    ["planner"],
  );
  for (const name of ["enter_with_exits", "wait_for_signal", "start_session", "simulate_swap", "wait"]) assert.equal(can("executor", name), true, name);
  for (const name of ["write_belief", "write_mission_review", "write_plan"]) assert.equal(can("executor", name), false, name);
});

// El reparto de modelos: el cerebro piensa antes del reloj (Opus en max), el que ejecuta una misión rápida decide en
// ~17 s (Sonnet en medium), el trader de las largas va sin prisa (Sonnet en xhigh) y el revisor, después (Opus en
// xhigh). Con el identificador completo: con el CLI 2.1.272 los alias caen en la generación anterior.
const MODELS: Record<(typeof AGENTS)[number], { model: string; effort: string; maxTurns?: string; cacheTtl?: string }> = {
  planner: { model: "claude-opus-5-5", effort: "max", maxTurns: "10", cacheTtl: "1h" },
  executor: { model: "claude-sonnet-5-5", effort: "medium", maxTurns: "60" },
  trader: { model: "claude-sonnet-5-5", effort: "xhigh" },
  reviewer: { model: "claude-opus-5-5", effort: "xhigh", cacheTtl: "1h" },
};

for (const agent of AGENTS) {
  test(`${agent}: modelo con el identificador completo, esfuerzo y límites en la cabecera`, () => {
    const fm = frontmatter(agent);
    const field = (key: string) => fm.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1]?.trim();
    const want = MODELS[agent];
    assert.equal(field("model"), want.model);
    assert.equal(field("effort"), want.effort);
    assert.equal(field("maxTurns"), want.maxTurns);
    // experimental.cacheTtl: una clave anidada bajo `experimental:` (YAML con sangría).
    assert.equal(fm.match(/^experimental:\r?\n[ \t]+cacheTtl: (.*)$/m)?.[1]?.trim(), want.cacheTtl);
    assert.match(fm, /^omitClaudeMd: true$/m);
  });
}
