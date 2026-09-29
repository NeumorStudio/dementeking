// Prueba las migraciones sobre una copia de una base de datos real, sin tocar el original.
//   npx tsx scripts/migrate-dry.ts [--db ~/.dementeking/sim.db]
// Muestra la versión del esquema y el número de filas de cada tabla antes y después.
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const arg = process.argv.indexOf("--db");
const source = path.resolve(arg >= 0 ? process.argv[arg + 1]! : path.join(os.homedir(), ".dementeking", "sim.db"));
if (!existsSync(source)) throw new Error(`No existe ${source}`);

const dir = mkdtempSync(path.join(os.tmpdir(), "dementeking-dry-"));
const copy = path.join(dir, "sim.db");
new DatabaseSync(source, { readOnly: true }).exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);

function snapshot(conn: DatabaseSync) {
  const version = (conn.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  const counts = Object.fromEntries(tables.map((t) => [t, (conn.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
  return { version, counts };
}

const before = snapshot(new DatabaseSync(copy));
process.env.DATA_DIR = dir;
const { db } = await import("../src/db.js");
const after = snapshot(db);

console.log(`Copia: ${copy}`);
console.log(`Versión del esquema: ${before.version} → ${after.version}`);
const names = [...new Set([...Object.keys(before.counts), ...Object.keys(after.counts)])].sort();
for (const t of names) {
  const a = before.counts[t];
  const b = after.counts[t];
  const mark = a === undefined ? "  (nueva)" : b === undefined ? "  (eliminada)" : a !== b ? "  (cambia)" : "";
  console.log(`  ${t.padEnd(18)} ${String(a ?? "-").padStart(6)} → ${String(b ?? "-").padStart(6)}${mark}`);
}
