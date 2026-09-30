import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchJson, fetchText, HostBusyError, setFetchImpl, takeBudget } from "../src/market/http.js";

function fakeFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  setFetchImpl((async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ n: calls.length }), { status: 200 });
  }) as typeof fetch);
  return calls;
}

test("GET: peticiones repetidas salen de la caché", async () => {
  const calls = fakeFetch();
  const a = await fetchJson<{ n: number }>("https://example.test/a");
  const b = await fetchJson<{ n: number }>("https://example.test/a");
  assert.equal(a.n, 1);
  assert.equal(b.n, 1);
  assert.equal(calls.length, 1);
});

test("POST: envía JSON y la caché distingue por cuerpo", async () => {
  const calls = fakeFetch();
  await fetchJson("https://example.test/rpc", { method: "POST", body: { id: 1 } });
  await fetchJson("https://example.test/rpc", { method: "POST", body: { id: 1 } });
  await fetchJson("https://example.test/rpc", { method: "POST", body: { id: 2 } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(calls[0]!.init?.body, JSON.stringify({ id: 1 }));
  assert.equal((calls[0]!.init?.headers as Record<string, string>)["content-type"], "application/json");
});

test("los errores HTTP no se guardan en caché", async () => {
  let n = 0;
  setFetchImpl((async () => new Response("no", { status: ++n === 1 ? 500 : 200 })) as unknown as typeof fetch);
  assert.equal((await fetchText("https://example.test/err")).status, 500);
  assert.equal((await fetchText("https://example.test/err")).status, 200);
});

test("cupo por ventana: se agota y se renueva", () => {
  assert.equal(takeBudget("budget.test", 2, 60_000), true);
  assert.equal(takeBudget("budget.test", 2, 60_000), true);
  assert.equal(takeBudget("budget.test", 2, 60_000), false);
  // Con una ventana ya vencida, vuelve a empezar.
  assert.equal(takeBudget("budget.test", 2, 0), true);
});

test("carril de baja prioridad: nunca hace cola delante de una petición normal, y se rinde si no hay turno libre pronto", async () => {
  const order: string[] = [];
  setFetchImpl((async (url: string) => {
    order.push(new URL(url).searchParams.get("q")!);
    return new Response("{}", { status: 200 });
  }) as typeof fetch);
  // Jupiter admite una petición cada 1,1 s entre todos. A sale ya; la de baja prioridad (L) llega cuando el turno siguiente
  // está ocupado y espera sin reservarlo; B, normal, llega después y reserva ese turno: pasa por delante de L.
  const url = (q: string) => `https://lite-api.jup.ag/test?q=${q}`;
  const a = fetchText(url("A"));
  await new Promise((r) => setTimeout(r, 30));
  const l = fetchText(url("L"), { lowPriority: true });
  await new Promise((r) => setTimeout(r, 30));
  const b = fetchText(url("B"));
  await Promise.all([a, l, b]);
  assert.deepEqual(order, ["A", "B", "L"]);

  // Con la cola llena más allá de LOW_PRIORITY_MAX_WAIT_MS (3 s), la de baja prioridad no espera: HostBusyError.
  const queued = [1, 2, 3, 4].map((i) => fetchText(url(`N${i}`)));
  await assert.rejects(fetchText(url("L2"), { lowPriority: true }), (err: unknown) => err instanceof HostBusyError);
  await Promise.all(queued);
  assert.ok(!order.includes("L2"), "no llegó a salir");
});
