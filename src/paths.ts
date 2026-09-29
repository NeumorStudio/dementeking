// Rutas que cambian entre desarrollo (este repositorio) y el plugin empaquetado (un solo archivo en dist/).
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// esbuild sustituye esta variable por "1" al empaquetar el plugin.
export const BUNDLED = process.env.CRYPTOAGENT_BUNDLED === "1";

const here = path.dirname(fileURLToPath(import.meta.url));
// En desarrollo: la raíz del repositorio. Empaquetado: la raíz del plugin (dist/..).
export const projectRoot = path.resolve(here, "..");

/** Busca un archivo junto al código empaquetado (dist/) o en su ruta del repositorio. */
export function asset(fileName: string, devPath: string): string {
  const candidates = [path.join(here, fileName), path.join(projectRoot, devPath)];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`No se encuentra ${fileName} (buscado en ${candidates.join(", ")})`);
  return found;
}

const usable = (dir: string | undefined) => (dir && !dir.includes("${") ? path.resolve(dir) : undefined);

/**
 * Dónde se guarda la base de datos. En el plugin, siempre ~/.dementeking: fuera de la carpeta
 * del plugin (sobrevive a las actualizaciones) y la misma se instale desde la app o desde la CLI,
 * para que la memoria del agente no quede repartida. DATA_DIR la sustituye (p. ej. en pruebas).
 */
export function resolveDataDir(): string {
  return usable(process.env.DATA_DIR) ?? (BUNDLED ? path.join(os.homedir(), ".dementeking") : path.join(projectRoot, "data"));
}
