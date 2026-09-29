import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { db } from "../src/db.js";
import { latestVersion, runMigrations, schemaVersion, type Migration } from "../src/migrations.js";

const tempDb = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dementeking-mig-"));
  const conn = new DatabaseSync(path.join(dir, "sim.db"));
  conn.exec("CREATE TABLE missions (id INTEGER PRIMARY KEY)");
  return { dir, conn };
};

test("la base de datos queda en la última versión del esquema", () => {
  assert.equal(schemaVersion(db), latestVersion());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'http_budget'").get());
});

test("las migraciones se aplican en orden y una sola vez", () => {
  const { dir, conn } = tempDb();
  const calls: number[] = [];
  const steps: Migration[] = [
    { version: 2, description: "b", up: () => calls.push(2) },
    {
      version: 1,
      description: "a",
      up: (d) => {
        calls.push(1);
        d.exec("CREATE TABLE t (x)");
      },
    },
  ];
  assert.deepEqual(runMigrations(conn, dir, steps), [1, 2]);
  assert.deepEqual(runMigrations(conn, dir, steps), []);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(schemaVersion(conn), 2);
});

test("una migración que falla no deja cambios a medias", () => {
  const { dir, conn } = tempDb();
  const steps: Migration[] = [
    {
      version: 1,
      description: "rota",
      up: (d) => {
        d.exec("CREATE TABLE a (x)");
        throw new Error("fallo");
      },
    },
  ];
  assert.throws(() => runMigrations(conn, dir, steps), /Falló la migración 1/);
  assert.equal(schemaVersion(conn), 0);
  assert.equal(conn.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get(), undefined);
});

test("se hace copia de seguridad solo si hay datos", () => {
  const { dir, conn } = tempDb();
  runMigrations(conn, dir, [{ version: 1, description: "a", up: () => {} }]);
  assert.equal(existsSync(path.join(dir, "backups")), false);

  conn.exec("INSERT INTO missions (id) VALUES (1)");
  runMigrations(conn, dir, [{ version: 2, description: "b", up: () => {} }]);
  const files = readdirSync(path.join(dir, "backups"));
  assert.equal(files.length, 1);
  const copy = new DatabaseSync(path.join(dir, "backups", files[0]!));
  assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM missions").get() as { n: number }).n, 1);
  assert.equal(schemaVersion(copy), 1);
});
