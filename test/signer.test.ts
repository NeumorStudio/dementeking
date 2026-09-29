import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createSignerServer } from "../src/live/signer/server.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "dementeking-signer-"));
const token = "a".repeat(64);
const signer = createSignerServer({ dir, token });
const port = await signer.listen();
const origin = `http://127.0.0.1:${port}`;
after(() => signer.server.close());

const page = (p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(origin + p, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0]!;

let mnemonic = "";

test("la API del MCP exige el token y nunca devuelve la frase", async () => {
  assert.equal((await fetch(origin + "/api/status")).status, 401);
  assert.equal((await fetch(origin + "/api/status", { headers: { authorization: "Bearer " + "b".repeat(64) } })).status, 401);
  const ok = await (await fetch(origin + "/api/status", { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(ok.exists, false);
});

test("las acciones de la página exigen su propio origen", async () => {
  const r = await page("/wallet/create", { password: "una contraseña larga" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  const noOrigin = await fetch(origin + "/wallet/create", { method: "POST", body: JSON.stringify({ password: "una contraseña larga" }) });
  assert.equal(noOrigin.status, 403);
});

test("crear la cartera: la frase se entrega una vez a la página y queda desbloqueada", async () => {
  const r = await page("/wallet/create", { password: "una contraseña larga" });
  assert.equal(r.status, 200);
  const body = await r.json();
  mnemonic = body.mnemonic;
  assert.equal(mnemonic.split(" ").length, 12);
  assert.equal(signer.state.accounts?.evm.address, body.wallet.evm);
  // Ninguna otra respuesta contiene la frase.
  const cookie = cookieOf(r);
  for (const res of [
    await page("/wallet/state", undefined, { cookie }),
    await fetch(origin + "/api/status", { headers: { authorization: `Bearer ${token}` } }),
    await page("/wallet", undefined),
  ]) {
    const text = await res.text();
    assert.ok(!text.includes(mnemonic.split(" ").slice(0, 2).join(" ")), `${res.url} contiene la frase`);
  }
  // No se puede crear otra encima.
  assert.equal((await page("/wallet/create", { password: "una contraseña larga" })).status, 400);
});

test("bloquear, parar y desbloquear con la contraseña", async () => {
  // Sin cookie no se puede parar ni bloquear.
  assert.equal((await page("/wallet/stop", {})).status, 401);
  const r = await page("/wallet/unlock", { password: "otra contraseña larga" });
  assert.equal(r.status, 400);
  const ok = await page("/wallet/unlock", { password: "una contraseña larga" });
  assert.equal(ok.status, 200);
  const cookie = cookieOf(ok);
  const stopped = await (await page("/wallet/stop", {}, { cookie })).json();
  assert.deepEqual([stopped.unlocked, stopped.stopped], [false, true]);
  assert.equal(signer.state.accounts, null);
  // La cookie anterior ya no vale tras parar.
  assert.equal((await page("/wallet/lock", {}, { cookie })).status, 401);
});

test("demasiados intentos de contraseña bloquean un rato", async () => {
  for (let i = 0; i < 5; i++) await page("/wallet/unlock", { password: "mala contraseña " + i });
  assert.equal((await page("/wallet/unlock", { password: "una contraseña larga" })).status, 429);
});

test("un Host distinto se rechaza (DNS rebinding)", async () => {
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve) => {
    request({ host: "127.0.0.1", port, path: "/wallet/state", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode!)).end();
  });
  assert.equal(status, 403);
});
