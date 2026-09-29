// Empaqueta el servidor MCP en un único archivo para el plugin (plugin/dist/cryptosim.mjs),
// con todas sus dependencias dentro: el usuario no necesita ejecutar npm install.
//   npm run build:plugin
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

const out = "plugin/dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Dos programas: el servidor MCP y el firmante de la cartera real (un proceso aparte, el único que
// descifra la clave).
for (const [entry, file] of [["src/mcp.ts", "cryptosim.mjs"], ["src/live/signer/main.ts", "signer.mjs"]]) await build({
  entryPoints: [entry],
  outfile: `${out}/${file}`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Hace que paths.ts sepa que está empaquetado (datos en la carpeta persistente del plugin).
  define: {
    "process.env.CRYPTOAGENT_BUNDLED": '"1"',
    // Versión del plugin: el servidor la usa para retirarse si arranca otro más nuevo.
    "process.env.CRYPTOAGENT_VERSION": JSON.stringify(JSON.parse(readFileSync("plugin/.claude-plugin/plugin.json", "utf8")).version),
  },
  // Algunas dependencias son CommonJS y usan require(): se lo proporcionamos en ESM.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
});

// Archivos que el servidor lee en tiempo de ejecución.
copyFileSync("src/dashboard/index.html", `${out}/index.html`);
copyFileSync("knowledge/guia-del-terreno.md", `${out}/guia-del-terreno.md`);

const kb = (f) => (statSync(f).size / 1024).toFixed(0);
console.log(`Plugin empaquetado: ${out}/cryptosim.mjs (${kb(`${out}/cryptosim.mjs`)} KB), signer.mjs (${kb(`${out}/signer.mjs`)} KB), index.html, guia-del-terreno.md`);

// Este repositorio es también su propio marketplace (.claude-plugin/marketplace.json apunta a ./plugin):
// se sincroniza la versión en el catálogo y basta con hacer commit y push para publicarla.
const catalogPath = ".claude-plugin/marketplace.json";
const version = JSON.parse(readFileSync("plugin/.claude-plugin/plugin.json", "utf8")).version;
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
for (const p of catalog.plugins) if (p.name === "dementeking") p.version = version;
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
console.log(`Versión ${version} sincronizada en ${catalogPath}. Haz commit y push para publicarla.`);
