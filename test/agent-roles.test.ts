// Los dos agentes (trader y revisor) comparten el servidor MCP: qué herramientas puede usar cada uno se
// decide en su configuración (disallowedTools). Este test comprueba que coincide con el campo `role`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SIM_TOOLS } from "../src/tools/index.js";

const root = path.resolve(import.meta.dirname, "..");
const PREFIX = "mcp__plugin_dementeking_cryptosim__";

function disallowed(agent: string) {
  const md = readFileSync(path.join(root, "plugin/agents", `${agent}.md`), "utf8");
  const line = md.match(/^disallowedTools:(.*)$/m)?.[1] ?? "";
  return new Set(
    line
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(PREFIX, "")),
  );
}

// Herramientas definidas directamente en mcp.ts: las de la sesión del trader y las del usuario.
const MCP_ROLES: Record<string, "trader" | "user"> = {
  start_session: "trader",
  end_session: "trader",
  create_mission: "user",
  stop_mission: "user",
  status_report: "user",
  start_dashboard: "user",
  stop_dashboard: "user",
  start_wallet: "user",
  wallet_status: "user",
  export_taxes: "user",
};

const roles = new Map<string, string>([...SIM_TOOLS.map((t) => [t.name, t.role ?? "trader"] as [string, string]), ...Object.entries(MCP_ROLES)]);

test("mcp.ts no define herramientas sin rol conocido", () => {
  const src = readFileSync(path.join(root, "src/mcp.ts"), "utf8");
  const names = [...src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(names.sort(), Object.keys(MCP_ROLES).sort());
});

for (const [agent, allowed] of [
  ["trader", new Set(["trader", "both"])],
  ["reviewer", new Set(["reviewer", "both"])],
] as const) {
  test(`${agent}: puede usar justo las herramientas de su rol`, () => {
    const blocked = disallowed(agent);
    const wrong: string[] = [];
    for (const [name, role] of roles) {
      const shouldBlock = !allowed.has(role);
      if (shouldBlock !== blocked.has(name)) wrong.push(`${name} (rol ${role}): ${shouldBlock ? "debería estar bloqueada" : "no debería estar bloqueada"}`);
    }
    for (const name of blocked) if (!roles.has(name)) wrong.push(`${name}: bloqueada pero no existe`);
    assert.deepEqual(wrong, []);
  });
}
