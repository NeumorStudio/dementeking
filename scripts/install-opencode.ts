// Instala dementeking en OpenCode (escritorio o terminal):   npm run install:opencode
// - Copia el simulador empaquetado a ~/.dementeking/opencode (una copia estable, no depende de este repositorio).
// - Añade el servidor MCP `cryptosim` al opencode.json global, sin tocar el resto de la configuración.
// - Genera los agentes `trader` y `reviewer` a partir de los mismos prompts del plugin de Claude Code, y los
//   comandos /dementeking-*. No fija ningún modelo: usan el que tengas seleccionado en OpenCode.
// Usa su propia base de datos (~/.dementeking/opencode-data) y su propio panel (puerto 4332), separados de Claude Code.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Importar las herramientas abre la base de datos: que sea una temporal, no la de desarrollo ni la real.
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "dementeking-install-"));
const { buildPrompt, REVIEWER_PROMPT_PATH, TRADER_PROMPT_PATH } = await import("../src/prompt.js");
const { SIM_TOOLS } = await import("../src/tools/index.js");
const { toolRoles } = await import("../src/tools/define.js");

const root = path.resolve(import.meta.dirname, "..");
const home = os.homedir();
const serverDir = path.join(home, ".dementeking", "opencode");
const configDir = path.join(home, ".config", "opencode");
const MCP = "cryptosim";

// ── 1. Simulador ────────────────────────────────────────────────────────────
const dist = path.join(root, "plugin", "dist");
if (!existsSync(path.join(dist, "cryptosim.mjs"))) throw new Error("Falta plugin/dist: ejecuta antes npm run build:plugin");
mkdirSync(serverDir, { recursive: true });
for (const f of ["cryptosim.mjs", "signer.mjs", "index.html", "guia-del-terreno.md"]) copyFileSync(path.join(dist, f), path.join(serverDir, f));
const serverFile = path.join(serverDir, "cryptosim.mjs");

// ── 2. opencode.json ────────────────────────────────────────────────────────
mkdirSync(configDir, { recursive: true });
if (existsSync(path.join(configDir, "opencode.jsonc"))) {
  throw new Error(`Tienes ${path.join(configDir, "opencode.jsonc")}: añade a mano el servidor MCP "${MCP}" (ver README) para no perder sus comentarios`);
}
const configFile = path.join(configDir, "opencode.json");
const config = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as Record<string, any>) : { $schema: "https://opencode.ai/config.json" };
// Base de datos y panel propios: las misiones y la memoria de OpenCode no se mezclan con las de Claude Code
// (así se puede comparar cómo aprende con cada modelo), y el panel no choca con el de Claude Code (4331).
const dataDir = path.join(home, ".dementeking", "opencode-data");
const DASHBOARD_PORT = "4332";
const server = { type: "local", command: [process.execPath, serverFile], environment: { DATA_DIR: dataDir, DASHBOARD_PORT, CRYPTOAGENT_HOST: "opencode" } };
// OpenCode 2 entiende los dos formatos: el clásico (mcp.<nombre> con enabled) y el nuevo (mcp.servers.<nombre> con
// disabled). Se respeta el que ya tenga el archivo.
if (config.mcp?.servers) config.mcp.servers = { ...config.mcp.servers, [MCP]: { ...server, disabled: false } };
else config.mcp = { ...(config.mcp ?? {}), [MCP]: { ...server, enabled: true } };
writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");

// ── 3. Agentes ──────────────────────────────────────────────────────────────
// Herramientas definidas en mcp.ts (fuera de SIM_TOOLS) y de quién son. En OpenCode solo hay trader y revisor.
const MCP_ONLY: Record<string, readonly string[]> = {
  start_session: ["trader", "executor"],
  end_session: ["trader", "executor"],
  create_mission: ["user"],
  stop_mission: ["user"],
  status_report: ["user"],
  start_dashboard: ["user"],
};
const roles = new Map<string, readonly string[]>([...SIM_TOOLS.map((t) => [t.name, toolRoles(t)] as const), ...Object.entries(MCP_ONLY)]);
const deniedFor = (agent: "trader" | "reviewer") => [...roles].filter(([, r]) => !r.includes(agent)).map(([name]) => `${MCP}_${name}`);

const ENV = (agent: "trader" | "reviewer") =>
  [
    "Estás en OpenCode. Tus herramientas del simulador vienen del servidor MCP `cryptosim`: cuando este texto nombra una herramienta (por ejemplo",
    "`mission_status`), es la de ese servidor (según tu entorno, `cryptosim_mission_status` o `tools.cryptosim.mission_status(...)` dentro de `execute`).",
    "No escribas archivos ni ejecutes comandos del sistema: trabajas solo con esas herramientas.",
    agent === "trader"
      ? "Empieza llamando a `cryptosim_start_session`. Trabaja en bucle hasta que `cryptosim_mission_status` diga que la misión ya no está activa: investiga, opera, anota, y usa `cryptosim_wait` solo cuando no te quede nada útil por hacer. No termines antes. Al acabar la misión, llama a `cryptosim_end_session` y responde con un resumen breve."
      : "Haz exactamente lo que te pida el mensaje (\"Prepara la misión.\" o \"Vigila la misión.\") y termina con un resumen breve.",
    "",
  ].join("\n");

function agentFile(agent: "trader" | "reviewer", description: string, source: string) {
  const body = buildPrompt(readFileSync(source, "utf8"), "api");
  const permission = ["  edit: deny", "  bash: deny", "  task: deny", ...deniedFor(agent).map((t) => `  ${t}: deny`)].join("\n");
  // Entre comillas: un ":" en la descripción rompería el YAML de la cabecera.
  return `---\ndescription: ${JSON.stringify(description)}\nmode: subagent\npermission:\n${permission}\n---\n\n${ENV(agent)}\n${body}\n`;
}

const agentsDir = path.join(configDir, "agents");
mkdirSync(agentsDir, { recursive: true });
writeFileSync(
  path.join(agentsDir, "trader.md"),
  agentFile("trader", "Agente de dementeking que intenta cumplir una misión de trading simulado (capital, objetivo y plazo). Lo lanza /dementeking-trading.", TRADER_PROMPT_PATH),
);
writeFileSync(
  path.join(agentsDir, "reviewer.md"),
  agentFile("reviewer", "Revisor de dementeking: analiza lo que hace el trader, escribe su memoria y le prepara cada misión. Lo lanza /dementeking-trading.", REVIEWER_PROMPT_PATH),
);

// ── 4. Comandos ─────────────────────────────────────────────────────────────
const ASK =
  "Para preguntar al usuario, usa la herramienta de preguntas si la tienes (con opciones); si no, pregunta en el chat y espera su respuesta.";

const commands: Record<string, string> = {
  "dementeking-trading": `---
description: Lanza una misión de dementeking (trading simulado con precios reales) con su agente y su revisor
---
Vas a lanzar una misión de dementeking. Habla en español. Tú no operas ni escribes memoria: preparas la misión y lanzas a los agentes. ${ASK}

Argumentos del usuario: $ARGUMENTS
(Formato orientativo: capital, objetivo y minutos, p. ej. "20 40 60" = 20 $ de capital, llegar a 40 $, en 60 minutos. Un objetivo en % se aplica sobre el capital.)
En OpenCode solo hay misiones normales, las que opera el trader. Una simulada de 15 minutos o menos es una misión rápida, y esas solo existen en Claude Code (las prepara un cerebro y las ejecuta otro agente): si el usuario pide 15 minutos o menos en simulado, díselo y pídele un plazo mayor. Una real puede durar lo que quiera.

1. Llama a \`cryptosim_mission_status\`. Si hay una misión activa, pregunta si continuarla (salta al paso 5 sin crearla), reemplazarla (crea la nueva con \`replace: true\`) o detenerla (\`cryptosim_stop_mission\`, preguntando si cerrar posiciones, y termina).
2. Primero pregunta el modo: simulado (dinero ficticio, por defecto) o real (dinero de verdad de la cartera de la IA).
3. Simulado: completa lo que falte en los argumentos preguntando al usuario: capital (por defecto 1000 $), objetivo (por defecto +5 %), minutos (por defecto 60; más de 15), instrucciones (por defecto ninguna: modo libre) y reparto:
   - con menos de 100 $ de capital, por defecto todo en Solana: {"solana":100};
   - si no, repartido: {"solana":30,"base":25,"bsc":25,"binance":20}.
   Crea la misión con \`cryptosim_create_mission\` (capital_usd, target_usd en valor absoluto, duration_minutes, allocation e instructions si las hay).
   Real: llama a \`cryptosim_wallet_status\`. Si no hay cartera o no está desbloqueada, llama a \`cryptosim_start_wallet\` y pide al usuario que la cree o desbloquee en la página que se abre (nunca pidas ni aceptes en el chat la frase ni la contraseña); espera a que te diga que está lista. Enseña el saldo y pregunta: objetivo en % (por defecto +10 %), minutos (por defecto 60), aprobación (manual: aprueba cada operación en la página de la cartera, por defecto; o autónoma con límites), máximo por operación (por defecto 25 % del saldo, en USD), pérdida máxima (por defecto 30 %) e instrucciones. Crea la misión con \`cryptosim_create_mission\` (mode: "live", target_pct, duration_minutes, approval, max_trade_usd, max_loss_pct, instructions).
4. Pregunta si quiere el panel en directo; si sí, \`cryptosim_start_dashboard\` con open_in_system_browser: true.
5. Lanza el subagente \`reviewer\` con el mensaje exacto "Prepara la misión." y espera a que termine (si falla, sigue: el trader puede trabajar sin briefing).
6. Lanza el subagente \`trader\` con el mensaje exacto "Trabaja en tu misión." y espera a que termine. Si después \`cryptosim_mission_status\` dice que la misión sigue activa, vuelve a lanzarlo con el mismo mensaje.
7. Cuando la misión haya terminado, lanza el subagente \`reviewer\` con el mensaje exacto "Vigila la misión." (hará la retrospectiva) y espera.
8. Llama a \`cryptosim_status_report\` y resume el resultado en pocas líneas.

No añadas nada a los mensajes de los subagentes: todo lo que necesitan está en su configuración y en el simulador.
`,
  "dementeking-estado": `---
description: Cómo va la misión de dementeking
---
Llama a \`cryptosim_status_report\` y muestra su contenido tal cual, en español, sin tablas ni análisis propio.
`,
  "dementeking-parar": `---
description: Detiene la misión activa de dementeking
---
Habla en español. ${ASK}
1. Llama a \`cryptosim_mission_status\`. Si no hay misión activa, dilo y termina.
2. Pregunta qué hacer con la cartera: cerrar posiciones (vender todo a mercado), dejarla como está o no detenerla.
3. Llama a \`cryptosim_stop_mission\` con close_positions según la respuesta.
4. Cierra el panel con \`cryptosim_stop_dashboard\` y resume en una línea el valor final y que el panel se ha cerrado.
`,
  "dementeking-peticiones": `---
description: Lo que el agente de dementeking ha pedido y no tiene (cuentas, herramientas, mercados)
---
Habla en español. ${ASK}
1. Llama a \`cryptosim_capability_requests\`. Si no hay ninguna abierta, dilo y termina.
2. Muéstralas de la más pedida a la menos: qué pide, cuántas veces, por qué y qué haría con ello.
3. Pregunta si quiere responder a alguna (aceptada, rechazada o hecha, con una nota) y regístralo con \`cryptosim_resolve_capability_request\`.
`,
  "dementeking-panel": `---
description: Abre el panel en directo de dementeking
---
Llama a \`cryptosim_start_dashboard\` con open_in_system_browser: true y di en una línea dónde está el panel.
`,
  "dementeking-cartera": `---
description: Abre la cartera real de la IA de dementeking (crearla, desbloquearla, ver saldos o pararla)
---
Llama a \`cryptosim_start_wallet\`: abre en el navegador la página de la cartera real de la IA. Explica en pocas líneas, en español, según el estado:
- sin cartera: que la cree en la página; verá la frase de recuperación una sola vez y debe apuntarla en papel (puede importarla en MetaMask y Phantom para verla);
- bloqueada: que escriba su contraseña en la página;
- desbloqueada: llama a \`cryptosim_wallet_status\` y enseña el total, el saldo por cadena y las direcciones.
Nunca pidas ni repitas en el chat la frase ni la contraseña. Para que el agente opere con ella, se crea una misión en modo real con /dementeking-trading.
`,
  "dementeking-impuestos": `---
description: Exporta a CSV las operaciones con dinero real de dementeking (apoyo para la declaración)
---
Llama a \`cryptosim_export_taxes\` (con year si el usuario indica un año: $ARGUMENTS) y enseña en pocas líneas, en español: cuántas operaciones y posiciones, el resultado realizado en USD y EUR y las rutas de los archivos. Recuerda que es un registro de apoyo, no asesoramiento fiscal (en España cada permuta es ganancia o pérdida patrimonial y Hacienda exige FIFO).
`,
};
const commandsDir = path.join(configDir, "commands");
mkdirSync(commandsDir, { recursive: true });
for (const [name, content] of Object.entries(commands)) writeFileSync(path.join(commandsDir, `${name}.md`), content);

console.log(`Simulador:   ${serverFile}`);
console.log(`Servidor MCP "${MCP}" en ${configFile}`);
console.log(`Datos:       ${dataDir} (separados de Claude Code) · panel en http://localhost:${DASHBOARD_PORT}`);
console.log(`Agentes:     ${path.join(agentsDir, "trader.md")}, reviewer.md`);
console.log(`Comandos:    /${Object.keys(commands).join(", /")}`);
console.log("Abre (o reinicia) OpenCode y escribe /dementeking-trading.");
