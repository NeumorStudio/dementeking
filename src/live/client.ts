// Lado del servidor MCP: encontrar el firmante (o arrancarlo) y consultarlo. El MCP nunca ve la clave.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { asset } from "../paths.js";
import type { WalletPublic } from "./keystore.js";
import { signerInfoFile, type SignerInfo } from "./paths.js";

export interface SignerStatus {
  exists: boolean;
  unlocked: boolean;
  stopped: boolean;
  wallet: WalletPublic | null;
  pid: number;
}

function readInfo(): SignerInfo | null {
  try {
    return existsSync(signerInfoFile()) ? (JSON.parse(readFileSync(signerInfoFile(), "utf8")) as SignerInfo) : null;
  } catch {
    return null;
  }
}

export const walletUrl = (info: SignerInfo) => `http://127.0.0.1:${info.port}/wallet`;

async function api<T>(info: SignerInfo, path: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** Estado del firmante si está en marcha; null si no. */
export async function signerStatus(): Promise<{ info: SignerInfo; status: SignerStatus } | null> {
  const info = readInfo();
  if (!info) return null;
  try {
    return { info, status: await api<SignerStatus>(info, "/api/status") };
  } catch {
    return null;
  }
}

async function runningSigner() {
  const s = await signerStatus();
  if (!s) throw new Error("El firmante de la cartera no está en marcha: pide al usuario que la abra y desbloquee con /dementeking:cartera");
  return s.info;
}

/**
 * Pide permiso para una operación. En modo manual espera (hasta ~90 s) a que el usuario la apruebe en
 * la página de la cartera; en autónomo, solo comprueba los límites. Devuelve un ticket para firmar.
 */
export async function requestIntent(intent: { missionId: number; chain: string; side: "buy" | "sell" | "move"; usd: number; summary: string }): Promise<string> {
  const info = await runningSigner();
  const r = await api<{ ticket: string }>(info, "/api/intent", { method: "POST", body: JSON.stringify(intent) }, 100_000);
  return r.ticket;
}

export interface SignResult {
  hash: string;
  ok: boolean;
  error?: string;
}

/** Firma y envía una transacción ya aprobada (el firmante la valida con su política y la simula antes). */
export async function signTx(body: {
  ticket: string;
  chain: string;
  kind: "swap" | "approve" | "bridge";
  usd: number;
  solanaTx?: string;
  /** Solana: lo máximo que puede bajar en la cartera (unidades base, como texto). */
  budget?: { lamports: string; tokens: Record<string, string> };
  evmTx?: { chainId: number; to: string; data: string; value: string };
  /** EVM: nativo máximo de la transacción y si el destino (puente) es EVM. */
  evmLimits?: { maxValue: string; destEvm?: boolean };
}): Promise<SignResult> {
  const info = await runningSigner();
  return api<SignResult>(info, "/api/sign", { method: "POST", body: JSON.stringify(body) }, 180_000);
}

/** Arranca el firmante como proceso independiente (sobrevive a esta sesión) si no está ya en marcha. */
export async function ensureSigner(): Promise<{ info: SignerInfo; status: SignerStatus; started: boolean }> {
  const running = await signerStatus();
  if (running) return { ...running, started: false };
  const entry = asset("signer.mjs", "src/live/signer/main.ts");
  const args = entry.endsWith(".ts") ? ["--import", "tsx", entry] : [entry];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const s = await signerStatus();
    if (s && s.status.pid === child.pid) return { ...s, started: true };
  }
  throw new Error("El firmante no ha arrancado");
}
