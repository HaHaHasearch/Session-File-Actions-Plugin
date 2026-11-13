import { Context } from "@deepseek-ai/cordis";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection";
import { afterEach, expect, it, vi } from "vitest";
import { apply, inject } from "./index.ts";

const cleanup = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

async function fixture() {
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  const readEvent = vi.fn(async ({ sessionId, seq }) => {
    if (sessionId !== "viewed" || ![2, 5].includes(seq)) throw new Error("missing event");
    return {
      session: { id: sessionId, cwd: "/workspace" },
      target: { seq, type: "deliverables/presented", data: { turn: 1, callId: "call", files: [
        { path: seq === 2 ? "north/report.txt" : "south/report.txt" },
      ] } },
    };
  });
  ctx.provide("sessionQuery", { readEvent });
  const connection = new HostConnectionService(ctx, [], {});
  let fiber = ctx.plugin({ apply, inject });
  await fiber.await();
  const handler = connection.createSharedFetchHandler("/api");
  const copy = (body, peer = connection.browserPeer) => handler.fetch(new Request("http://localhost/api/session-file-actions.copy", { method: "POST", body: JSON.stringify(body) }), peer);
  const request = (query, peer = connection.browserPeer, signal) => handler.fetch(
    new Request(`http://localhost/api/session-file-actions.resolve?${query}`, { signal }), peer,
  );
  return {
    ctx, connection, readEvent, request, copy,
    reload: async () => { await fiber.dispose(); fiber = ctx.plugin({ apply, inject }); await fiber.await(); },
    unload: () => fiber.dispose(),
  };
}

it("resolves each declared occurrence through the viewed session without checking the source file", async () => {
  const { request } = await fixture();
  const firstResponse = await (await request("sessionId=viewed&seq=2&index=0")).json();
  const secondResponse = await (await request("sessionId=viewed&seq=5&index=0")).json();
  const first = firstResponse.location;
  const second = secondResponse.location;
  expect(first).toMatchObject({ host: "harness", sessionId: "viewed", messageId: 2, attachmentId: 0 });
  expect(second).toMatchObject({ host: "harness", sessionId: "viewed", messageId: 5, attachmentId: 0 });
  expect(first.hostInstanceId).toBe(second.hostInstanceId);
});

it("resolves a Host event even when no per-event persistence confirmation is available", async () => {
  const { request } = await fixture();
  const response = await request("sessionId=viewed&seq=2&index=0");
  expect(response.status).toBe(200);
  expect((await response.json()).location).toMatchObject({ sessionId: "viewed", messageId: 2, attachmentId: 0 });
});

it("refuses a query result with a different session or event coordinate", async () => {
  const { request, readEvent } = await fixture();
  readEvent.mockResolvedValueOnce({ session: { id: "other" }, target: { seq: 2 } });
  const inconsistent = await request("sessionId=viewed&seq=2&index=0");
  expect(inconsistent.status).toBe(500);
  expect(await inconsistent.text()).toBe("inconsistent_event");
  readEvent.mockResolvedValueOnce({ session: { id: "viewed" }, target: { seq: 5 } });
  expect((await request("sessionId=viewed&seq=2&index=0")).status).toBe(500);
});

it("resolves delivery metadata without requiring a file service", async () => {
  const { request } = await fixture();
  expect((await request("sessionId=viewed&seq=2&index=0")).status).toBe(200);
});

it("distinguishes permission failures and unexpected failures without exposing details", async () => {
  const { ctx, request, readEvent } = await fixture();
  const warn = vi.spyOn(ctx.logger, "warn");
  readEvent.mockRejectedValueOnce(Object.assign(new Error("C:/private/token"), { code: "EACCES" }));
  const denied = await request("sessionId=viewed&seq=2&index=0");
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("private");
  readEvent.mockRejectedValueOnce(new Error("C:/private/token"));
  const broken = await request("sessionId=viewed&seq=2&index=0");
  expect(broken.status).toBe(500);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  expect(JSON.stringify(warn.mock.calls)).toContain("permission_denied");
  expect(JSON.stringify(warn.mock.calls)).toContain("internal_failure");
});

it("classifies only the direct cause of a session-query persistence failure", async () => {
  const { ctx, request, readEvent } = await fixture();
  const warn = vi.spyOn(ctx.logger, "warn");
  for (const [outerCode, causeCode, status, reason] of [
    ["SESSION_QUERY_PERSISTENCE_FAILED", "EACCES", 403, "permission_denied"],
    ["SESSION_QUERY_PERSISTENCE_FAILED", "EPERM", 403, "permission_denied"],
    ["SESSION_QUERY_PERSISTENCE_FAILED", "EIO", 500, "persistence_failed"],
    ["SESSION_QUERY_CORRUPT_SESSION", "EACCES", 500, "session_corrupt"],
    ["UNRELATED", "EACCES", 500, "internal_failure"],
  ]) {
    const cause = Object.assign(new Error("C:/private/cause"), { code: causeCode });
    readEvent.mockRejectedValueOnce(Object.assign(new Error("C:/private/query", { cause }), { code: outerCode }));
    const response = await request("sessionId=viewed&seq=2&index=0");
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(reason);
  }
  expect(JSON.stringify(warn.mock.calls)).not.toContain("C:/private");
});

it.each([
  ["SESSION_QUERY_PERSISTENCE_FAILED", "persistence_failed"],
  ["SESSION_QUERY_CORRUPT_SESSION", "session_corrupt"],
  ["SESSION_QUERY_SOURCE_CONFLICT", "source_conflict"],
  ["workspace-file/not-regular-file", "not_regular_file"],
])("classifies %s without logging its error details", async (code, reason) => {
  const { ctx, request, readEvent } = await fixture();
  const warn = vi.spyOn(ctx.logger, "warn");
  readEvent.mockRejectedValueOnce(Object.assign(new Error("C:/private/token"), { code }));
  const response = await request("sessionId=viewed&seq=2&index=0");
  expect(await response.text()).toBe(reason);
  expect(JSON.stringify(warn.mock.calls)).toContain(reason);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
});

it("refuses guest callers, invalid coordinates and missing declarations", async () => {
  const { connection, request, readEvent } = await fixture();
  const guest = connection.createPeer({ principal: { kind: "test-guest" } });
  expect((await request("sessionId=viewed&seq=2&index=0", guest)).status).toBe(403);
  expect(readEvent).not.toHaveBeenCalled();
  for (const query of ["sessionId=viewed&seq=-1&index=0", "sessionId=viewed&seq=2&index=0.5", "sessionId=viewed&seq=2&seq=5&index=0"]) {
    expect((await request(query)).status).toBe(400);
  }
  expect((await request("sessionId=other&seq=2&index=0")).ok).toBe(false);
  expect((await request("sessionId=viewed&seq=2&index=2")).status).toBe(404);
  readEvent.mockResolvedValueOnce({ session: { id: "viewed", cwd: "/workspace" }, target: { seq: 2, type: "turn/start", data: {} } });
  expect((await request("sessionId=viewed&seq=2&index=0")).status).toBe(404);
});

it.each([
  { files: [{ path: "report.txt" }] },
  { turn: 1, callId: "", files: [{ path: "report.txt" }] },
  { turn: 1.5, callId: "call", files: [{ path: "report.txt" }] },
  { turn: 1, callId: "call", files: [{ path: "report.txt", description: 1 }] },
])("refuses malformed delivery declarations", async (data) => {
  const { request, readEvent } = await fixture();
  readEvent.mockResolvedValueOnce({ session: { id: "viewed", cwd: "/workspace" }, target: { seq: 2, type: "deliverables/presented", data } });
  expect((await request("sessionId=viewed&seq=2&index=0")).status).toBe(404);
});

it("withdraws the route on unload and keeps Host identity across plugin reload", async () => {
  const first = await fixture();
  const before = (await (await first.request("sessionId=viewed&seq=2&index=0")).json()).location;
  await first.unload();
  expect((await first.request("sessionId=viewed&seq=2&index=0")).status).toBe(404);
  await first.reload();
  const after = (await (await first.request("sessionId=viewed&seq=2&index=0")).json()).location;
  expect(after.hostInstanceId).toBe(before.hostInstanceId);
  const second = await fixture();
  const other = (await (await second.request("sessionId=viewed&seq=2&index=0")).json()).location;
  expect(other.hostInstanceId).not.toBe(before.hostInstanceId);
});

it("aborts an in-flight lookup and waits for it before unloading", async () => {
  const { ctx, request, readEvent, unload } = await fixture();
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const release = Promise.withResolvers();
  const warn = vi.spyOn(ctx.logger, "warn");
  readEvent.mockImplementationOnce(async (_request, signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    await release.promise;
    signal.throwIfAborted();
  });
  const pending = request("sessionId=viewed&seq=2&index=0").catch(error => error);
  await entered.promise;
  let finished = false;
  const disposal = unload().then(() => { finished = true; });
  await aborted.promise;
  expect(finished).toBe(false);
  release.resolve();
  await Promise.all([pending, disposal]);
  expect(warn).not.toHaveBeenCalled();
});

it("grants one bounded copy bound to host, operation and session and reads current authorized bytes", async () => {
  const { ctx, request, copy } = await fixture();
  ctx.provide("sandboxPolicy", { workspaceRoot: "/workspace" });
  let data = new Uint8Array([0, 255, 17]);
  const readBytes = vi.fn(async () => ({ data, bytes: data.length, offset: 0, eof: true }));
  ctx.provide("workspaceFiles", { readBytes });
  const operationId = crypto.randomUUID();
  const grant = await (await request(`sessionId=viewed&seq=2&index=0&authorize=copy&operationId=${operationId}`)).json();
  expect(readBytes).not.toHaveBeenCalled();
  data = new Uint8Array([9, 0, 127]);
  const body = { token: grant.token, hostInstanceId: grant.location.hostInstanceId, sessionId: "viewed", operationId };
  const result = await copy(body);
  expect(result.status).toBe(200);
  expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([9, 0, 127]);
  expect(readBytes.mock.calls[0][1]).toBe("north/report.txt");
  expect((await copy(body)).status).toBe(403);
});
it.each(["sessionId", "hostInstanceId", "operationId"])("rejects a grant with the wrong %s before reading", async field => {
  const { ctx, request, copy } = await fixture();
  const readBytes = vi.fn(); ctx.provide("workspaceFiles", { readBytes });
  const operationId = crypto.randomUUID();
  const grant = await (await request(`sessionId=viewed&seq=2&index=0&authorize=copy&operationId=${operationId}`)).json();
  const body = { token: grant.token, hostInstanceId: grant.location.hostInstanceId, sessionId: "viewed", operationId, [field]: "wrong" };
  expect((await copy(body)).status).toBe(403);
  expect(readBytes).not.toHaveBeenCalled();
});

it("denies guest grant creation and rejects expired grants before any file read", async () => {
  const { ctx, connection, request, copy } = await fixture();
  const operationId = crypto.randomUUID();
  const query = `sessionId=viewed&seq=2&index=0&authorize=copy&operationId=${operationId}`;
  const guest = connection.createPeer({ principal: { kind: "guest" } });
  expect((await request(query, guest)).status).toBe(403);
  const readBytes = vi.fn(); ctx.provide("workspaceFiles", { readBytes });
  const grant = await (await request(query)).json();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
  expect((await copy({ token: grant.token, operationId, sessionId: "viewed", hostInstanceId: grant.location.hostInstanceId })).status).toBe(403);
  expect(readBytes).not.toHaveBeenCalled();
});
it.each(["ENOENT", "EACCES"])("fails %s source reads without returning file bytes", async code => {
  const { ctx, request, copy } = await fixture();
  ctx.provide("sandboxPolicy", { workspaceRoot: "/workspace" });
  ctx.provide("workspaceFiles", { readBytes: vi.fn(async () => { throw Object.assign(new Error("private path"), { code }); }) });
  const operationId = crypto.randomUUID();
  const grant = await (await request(`sessionId=viewed&seq=2&index=0&authorize=copy&operationId=${operationId}`)).json();
  const result = await copy({ token: grant.token, operationId, sessionId: "viewed", hostInstanceId: grant.location.hostInstanceId });
  expect(result.status).toBe(code === "ENOENT" ? 404 : 403);
  expect(await result.text()).not.toContain("private path");
});

it("classifies the Host complete-file bound as too_large", async () => {
  const { ctx, request, copy } = await fixture();
  ctx.provide("sandboxPolicy", { workspaceRoot: "/workspace" });
  ctx.provide("workspaceFiles", { readBytes: vi.fn(async () => { throw Object.assign(new Error("private path"), { code: "workspace-file/too-large" }); }) });
  const operationId = crypto.randomUUID(); const grant = await (await request(`sessionId=viewed&seq=2&index=0&authorize=copy&operationId=${operationId}`)).json();
  const result = await copy({ token: grant.token, operationId, sessionId: "viewed", hostInstanceId: grant.location.hostInstanceId });
  expect(result.status).toBe(413); expect(await result.text()).toBe("too_large");
});
