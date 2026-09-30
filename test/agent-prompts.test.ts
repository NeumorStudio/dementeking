// Los prompts con los que se lanza a cada agente son un contrato entre las skills, el README (modo sin interfaz) y la
// configuración de cada agente (plugin/agents/*.md): si uno cambia y el otro no, el agente recibe un prompt que no
// sabe atender. También fija el flujo de la misión rápida y lo que se quitó de los prompts al introducirla.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SIM_TOOLS } from "../src/tools/index.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const agent = (name: string) => read(`plugin/agents/${name}.md`);
const skills = readdirSync(path.join(root, "plugin/skills")).map((d) => ({ name: d, md: read(`plugin/skills/${d}/SKILL.md`) }));
const trading = read("plugin/skills/trading/SKILL.md");
const PREFIX = "mcp__plugin_dementeking_cryptosim__";

/** Los prompts exactos de cada agente, tal como los lanza /dementeking:trading (y el README, sin interfaz). */
const PROMPTS: Record<string, readonly string[]> = {
  planner: ["Prepara el plan."],
  executor: ["Ejecuta el plan vigente."],
  trader: ["Trabaja en tu misión."],
  reviewer: ["Prepara la misión.", "Vigila la misión.", "Revisa la misión."],
};

/** Lanzamientos de agentes en una skill: `subagent_type` `dementeking:<agente>` … `prompt` exactamente `<prompt>`. */
const launches = (md: string) =>
  [...md.matchAll(/`subagent_type` `dementeking:([a-z]+)`[^\n]*?`prompt` exactamente `([^`]+)`/g)].map((m) => ({ agent: m[1]!, prompt: m[2]! }));

/** El tramo de un documento desde un encabezado hasta el siguiente del mismo nivel o superior. */
function section(md: string, heading: string) {
  const start = md.indexOf(heading);
  assert.ok(start >= 0, `falta la sección ${heading}`);
  const level = heading.match(/^#+/)![0].length;
  const rest = md.slice(start + heading.length);
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

test("las skills lanzan cada agente con un prompt que su configuración sabe atender", () => {
  const all = skills.flatMap((s) => launches(s.md).map((l) => ({ ...l, skill: s.name })));
  for (const { skill, agent: name, prompt } of all) {
    assert.ok(existsSync(path.join(root, "plugin/agents", `${name}.md`)), `${skill}: no existe el agente ${name}`);
    assert.ok(PROMPTS[name]?.includes(prompt), `${skill}: ${name} no espera «${prompt}»`);
    // El trader tiene un solo modo de trabajo; los demás dicen qué hacer con cada prompt.
    if (name !== "trader") assert.ok(agent(name).includes(prompt), `plugin/agents/${name}.md no dice qué hacer con «${prompt}»`);
  }
  // /dementeking:trading usa todos los prompts de la tabla.
  const used = new Set(launches(trading).map((l) => `${l.agent}:${l.prompt}`));
  for (const [name, prompts] of Object.entries(PROMPTS)) {
    for (const prompt of prompts) assert.ok(used.has(`${name}:${prompt}`), `/dementeking:trading no lanza ${name} con «${prompt}»`);
  }
});

test("misión rápida: cerebro solo sin plan vigente, ejecutor en primer plano, sin vigía y revisión al terminar", () => {
  const setup = section(trading, "### 3R.");
  // Todo en Solana: con el reparto por defecto quedan unos 15 $ allí y la compra única es imposible.
  assert.match(setup, /`allocation` `\{"solana": 100\}`/);
  // La P medida junto a cada objetivo, sacada de strategy_fit.
  assert.match(setup, /`strategy_fit`/);
  assert.match(setup, /\+25 % ≈35 % · \+50 % ≈21 % · ×2 ≈9 %/);

  const launch = section(trading, "### 5R.");
  assert.ok(launch.indexOf("`get_plan`") < launch.indexOf("`dementeking:planner`"), "antes de lanzar al cerebro se mira si ya hay plan");
  assert.match(launch, /`dementeking:planner`[^\n]*`prompt` exactamente `Prepara el plan\.`/);
  assert.match(launch, /`dementeking:executor`[^\n]*`prompt` exactamente `Ejecuta el plan vigente\.`/);
  assert.doesNotMatch(launch, /`dementeking:executor`[^\n]*`run_in_background` `true`/, "el ejecutor va en primer plano");
  assert.doesNotMatch(launch, /`prompt` exactamente `Vigila la misión\.`/, "una misión de 15 min o menos no lleva vigía");
  assert.match(section(trading, "## 7R."), /`dementeking:reviewer`[^\n]*`prompt` exactamente `Revisa la misión\.`/);

  // La misión normal sigue con su flujo de siempre.
  const normal = section(trading, "### 5N.");
  for (const prompt of ["Prepara la misión.", "Trabaja en tu misión.", "Vigila la misión."]) assert.ok(normal.includes(`\`prompt\` exactamente \`${prompt}\``), prompt);
});

test("ninguna skill pasa model al lanzar un agente (pisaría el de su cabecera)", () => {
  for (const s of skills) assert.doesNotMatch(s.md, /`model` `/, s.name);
  assert.match(trading, /No pases `model` en ninguna llamada a Agent/);
});

test("/dementeking:trading tiene permitidas las herramientas del simulador que usa", () => {
  const mcpOnly = [...read("src/mcp.ts").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  const tools = new Set([...SIM_TOOLS.map((t) => t.name), ...mcpOnly]);
  const allowed = new Set(
    trading
      .match(/^allowed-tools:(.*)$/m)![1]!
      .split(",")
      .map((s) => s.trim().replace(PREFIX, "")),
  );
  const used = new Set([...trading.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!).filter((n) => tools.has(n)));
  assert.ok(used.has("get_plan") && used.has("strategy_fit"), "la misión rápida mira el plan y la P medida");
  assert.deepEqual([...used].filter((n) => !allowed.has(n)), []);
});

test("executor: carga sus herramientas antes del reloj, y solo las que tiene permitidas", () => {
  const md = agent("executor");
  const select = md.match(/`select:([^`]+)`/)?.[1];
  assert.ok(select, "el executor carga sus herramientas con una sola ToolSearch");
  const names = select.split(",").map((s) => s.replace(PREFIX, ""));
  const disallowed = md.match(/^disallowedTools:(.*)$/m)![1]!.split(",").map((s) => s.trim().replace(PREFIX, ""));
  const mcpOnly = [...read("src/mcp.ts").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  const tools = new Set([...SIM_TOOLS.map((t) => t.name), ...mcpOnly]);
  for (const name of names) {
    assert.ok(tools.has(name), `${name} no existe`);
    assert.ok(!disallowed.includes(name), `${name} la tiene prohibida`);
  }
  for (const name of ["mission_status", "get_plan", "wait_for_signal", "enter_with_exits", "wait", "end_session"]) assert.ok(names.includes(name), name);
  // El protocolo, en orden: cargar, leer el plan, esperar la señal, entrar, esperar el final.
  const order = ["`select:", "`get_plan`", "`wait_for_signal`", "`enter_with_exits` con `token`", "`wait` con", "`end_session`"].map((s) => md.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `faltan pasos: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(md, /Sin candidato no hay entrada: nunca arranques el reloj/);
});

test("el README documenta el modo sin interfaz con los prompts exactos", () => {
  const readme = read("README.md");
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [name, prompt] of [
    ["planner", "Prepara el plan."],
    ["executor", "Ejecuta el plan vigente."],
    ["reviewer", "Revisa la misión."],
  ] as const) {
    assert.match(readme, new RegExp(`claude -p "${escape(prompt)}" --agent dementeking:${name} `));
  }
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5"]) assert.ok(readme.includes(id), id);
});

test("lo que se quitó de los prompts con las misiones rápidas no vuelve", () => {
  const trader = agent("trader");
  const reviewer = agent("reviewer");
  for (const gone of [
    "con futuros a 20x basta",
    "perder no tiene coste real",
    "Perder no es un drama",
    "con el capital que haga falta",
    "suena a prudencia, esto pesa más",
    "investiga todo lo que el tiempo disponible te permita",
  ]) {
    assert.ok(!trader.includes(gone), `trader.md: «${gone}»`);
  }
  for (const gone of ["el x2 no es realista", "No le digas qué comprar"]) assert.ok(!reviewer.includes(gone), `reviewer.md: «${gone}»`);
  // Y lo que los sustituye.
  assert.match(trader, /Investiga a fondo antes de arrancar el reloj/);
  assert.match(reviewer, /Da siempre la P realista del objetivo pedido y la frontera/);
  assert.match(reviewer, /Con menos de 20 misiones por clase no se saca ninguna conclusión ni se cambian las reglas a mitad de bloque/);
});

test("executor: al reanudar mira las órdenes (portfolio no las enseña) y sus instrucciones de respaldo llevan chain", () => {
  const md = agent("executor");
  const select = md.match(/`select:([^`]+)`/)![1]!.split(",").map((s) => s.replace(PREFIX, ""));
  assert.ok(select.includes("list_orders"), "list_orders se carga antes del reloj");
  assert.match(md, /`portfolio` y `list_orders` en el mismo turno/);
  // place_swap_trigger_order y simulate_swap exigen chain (sin valor por defecto): sin ella, «Entrada no válida» con el reloj corriendo.
  for (const name of ["place_swap_trigger_order", "simulate_swap"]) {
    const def = SIM_TOOLS.find((t) => t.name === name)!;
    const shape = def.schema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    assert.equal(shape.chain!.safeParse(undefined).success, false, `${name}: chain es obligatoria`);
    const line = md.split("\n").find((l) => l.includes(`\`${name}\``) && l.includes("`sell_all` true"));
    assert.ok(line, `falta la instrucción de respaldo de ${name}`);
    assert.match(line, /`chain` solana/, name);
  }
  // Un error de enter_with_exits no arranca el reloj: se vuelve a esperar al siguiente candidato.
  assert.match(md, /\(el reloj no ha arrancado\)/);
});

test("rápida = simulada de 15 min o menos: los agentes y la skill deciden por missionKind, no por la duración", () => {
  assert.match(agent("executor"), /Si `missionKind` no es `rápida`/);
  assert.match(agent("planner"), /Si su `missionKind` no es `rápida`/);
  assert.match(agent("reviewer"), /`activeMission\.missionKind` en `review_queue`/);
  assert.match(section(trading, "## 2."), /`missionKind` `rápida`/);
  assert.doesNotMatch(section(trading, "## 2."), /lo dice su clase/);
  // Una simulada de 15 min o menos va siempre por el flujo rápido; una real, siempre por el trader.
  assert.match(section(trading, "### 3A."), /una misión simulada tan corta siempre es rápida/);
  assert.match(section(trading, "### 3B."), /Una misión real es siempre normal/);
  // En OpenCode solo hay trader: el ejemplo ya no es una misión de 5 min.
  const opencode = read("scripts/install-opencode.ts");
  assert.doesNotMatch(opencode, /"20 40 5"/);
  assert.match(opencode, /En OpenCode solo hay misiones normales/);
});

test("plan sin candidatos: la skill vuelve a lanzar al cerebro y el cerebro sabe sustituirlo", () => {
  const launch = section(trading, "### 5R.");
  assert.match(launch, /`withoutCandidate` con `lastMissionWithoutCandidate`/);
  assert.match(section(trading, "## 7R."), /`endReason` `prep_timeout`/);
  const planner = agent("planner");
  assert.match(planner, /Si `get_plan` trae `withoutCandidate`/);
  assert.match(planner, /sustitúyelo con `replace_reason`/);
  assert.match(planner, /write_plan` rechaza otro/, "el mercado del plan es el de su fuente");
});

test("trader: sabe que la preparación tiene un tope de 60 min (prepEndsAt)", () => {
  const md = agent("trader");
  assert.match(md, /si el reloj no arranca en 60 minutos desde que se creó la misión/);
  assert.match(md, /`prepEndsAt`/);
});

test("start_session no invita a arrancar el reloj antes de esperar el evento", () => {
  const mcp = read("src/mcp.ts");
  const desc = mcp.slice(mcp.indexOf('"start_session"'), mcp.indexOf("inputSchema", mcp.indexOf('"start_session"')));
  assert.doesNotMatch(desc, /antes que cualquier otra herramienta/);
  assert.match(desc, /llámala cuando " \+\s*"vayas a operar, no antes/);
  assert.match(desc, /enter_with_exits arranca el reloj/);
});
