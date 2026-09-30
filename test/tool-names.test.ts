// Cada nombre de herramienta citado entre comillas invertidas en los prompts, la guía, las skills y el README debe
// existir: evita instrucciones que apuntan a herramientas renombradas o eliminadas. Los parámetros de las herramientas
// del simulador (también los anidados, como los filtros de un plan) valen igual: así un parámetro mal escrito también salta.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SIM_TOOLS } from "../src/tools/index.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const mcpOnly = [...read("src/mcp.ts").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
const TOOLS = new Set([...SIM_TOOLS.map((t) => t.name), ...mcpOnly]);

/** Los nombres de parámetro de un esquema de zod, también los de objetos anidados, listas y uniones. */
function paramNames(schema: unknown, out = new Set<string>()): Set<string> {
  const def = (schema as { _zod?: { def?: Record<string, any> } } | undefined)?._zod?.def;
  if (!def) return out;
  // Objetos: sus claves; listas, uniones y envoltorios (optional, default, pipe…): lo que llevan dentro.
  if (def.type === "object") {
    for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) {
      out.add(key);
      paramNames(value, out);
    }
  }
  const inner = [def.element, def.innerType, def.in, def.out, ...(def.type === "union" ? (def.options as unknown[]) : [])];
  for (const s of inner) paramNames(s, out);
  return out;
}
const PARAMS = new Set(SIM_TOOLS.flatMap((t) => [...paramNames(t.schema)]));

// Identificadores en snake_case que no son herramientas ni parámetros del simulador: parámetros de las herramientas de
// mcp.ts, campos de APIs externas, herramientas de Claude Code y errores.
const NOT_TOOLS = new Set([
  "tabs_create",
  "capital_usd",
  "target_usd",
  "duration_minutes",
  "close_positions",
  "open_in_system_browser",
  "subagent_type",
  "run_in_background",
  "created_timestamp",
  "usd_market_cap",
  "ath_market_cap",
  "reply_count",
  "real_sol_reserves",
  "last_trade_timestamp",
  "volume_usd",
  "reserve_in_usd",
  "price_change_percentage",
  "pool_created_at",
  "beliefs_applied",
  "memory_note",
  "fixes_error_ids",
  "interval_due",
  "mission_ended",
  "slippage_bps",
  "target_pct",
  "max_trade_usd",
  "max_loss_pct",
  "howto_ids",
  "risks_checked",
  "wake_on_move_pct",
  "belief_ids",
  "superseded_by",
  "unrecognized_model",
  "prep_timeout",
]);

const docs = [
  ...readdirSync(path.join(root, "plugin/agents")).map((f) => `plugin/agents/${f}`),
  "knowledge/guia-del-terreno.md",
  "README.md",
  ...readdirSync(path.join(root, "plugin/skills")).map((d) => `plugin/skills/${d}/SKILL.md`),
];

const TOKEN = /`([a-z*]+(?:_[a-z*]+)+)`/g;

test("las herramientas y parámetros citados en los prompts, la guía, las skills y el README existen", () => {
  assert.ok(mcpOnly.includes("start_session"), "no se encontraron las herramientas de mcp.ts");
  assert.ok(PARAMS.has("max_round_trip_cost_pct") && PARAMS.has("plan_ref"), "no se leyeron los parámetros anidados de los esquemas");
  const missing: string[] = [];
  let checked = 0;
  for (const doc of docs) {
    for (const [, token] of read(doc).matchAll(TOKEN)) {
      checked++;
      if (NOT_TOOLS.has(token!) || PARAMS.has(token!)) continue;
      const ok = token!.includes("*")
        ? [...TOOLS].some((t) => new RegExp(`^${token!.replace(/\*/g, "[a-z_]+")}$`).test(t))
        : TOOLS.has(token!);
      if (!ok) missing.push(`${doc}: ${token}`);
    }
  }
  assert.ok(checked > 20, `solo se encontraron ${checked} nombres: ¿ha cambiado el formato de los documentos?`);
  assert.deepEqual(missing, []);
});
