import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createWallet, deriveAccounts, readWalletPublic, unlockWallet } from "../src/live/keystore.js";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("deriva las mismas direcciones que MetaMask y Phantom", () => {
  const a = deriveAccounts(ABANDON);
  assert.equal(a.evm.address, "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  assert.equal(a.solana.address, "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
  assert.equal(a.solana.secretKey.length, 64);
});

test("crear, descifrar, contraseña errónea y no sobrescribir", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dementeking-wallet-"));
  assert.throws(() => createWallet(dir, "corta"), /al menos/);
  const { mnemonic, pub } = createWallet(dir, "una contraseña larga");
  assert.equal(mnemonic.split(" ").length, 12);
  assert.deepEqual(readWalletPublic(dir), pub);
  // Ni la frase ni la clave aparecen en claro en los archivos.
  for (const f of ["wallet.enc", "wallet.json"]) {
    const content = readFileSync(path.join(dir, f), "utf8");
    assert.ok(!content.includes(mnemonic.split(" ").slice(0, 3).join(" ")), `${f} contiene la frase`);
  }
  const a = unlockWallet(dir, "una contraseña larga");
  assert.equal(a.evm.address, pub.evm);
  assert.equal(a.solana.address, pub.solana);
  assert.throws(() => unlockWallet(dir, "otra contraseña larga"), /Contraseña incorrecta/);
  assert.throws(() => createWallet(dir, "una contraseña larga"), /Ya existe/);
});
