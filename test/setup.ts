// Se carga antes de cada archivo de test (node --test --import): cada uno usa su propia base de datos
// temporal, nunca la de la simulación real.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "dementeking-test-"));
