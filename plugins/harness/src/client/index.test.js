import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { apply, inject } from "./index.ts";

const cleanup = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture({ coordinates = true, mentions = true } = {}) {
  const ctx = new Context();
  const providers = new Set();
  const notify = vi.fn();
  ctx.provide("contextMenus", {
    register(provider) { providers.add(provider); return () => providers.delete(provider); }, notify,
  });
  if (mentions) ctx.provide("chatFileMentions", { forClosing() {} });
  if (coordinates) ctx.provide("deliveryCardCoordinates", { version: 1 });
  let fiber = ctx.plugin({ apply, inject });
  await fiber.await();
  cleanup.push(() => ctx.fiber.dispose());
  return {
    ctx, providers, notify,
    reload: async () => { await fiber.dispose(); fiber = ctx.plugin({ apply, inject }); await fiber.await(); },
    unload: () => fiber.dispose(),
  };
}

it("reports missing delivery-card capability once when the host has the unpatched deliverables service", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const { providers, notify } = await fixture({ coordinates: false });
  const [provider] = providers;
  provider.resolve({ sessionId: "viewed", path: "report.txt" }, new AbortController().signal);
  provider.resolve({ sessionId: "viewed", path: "report.txt" }, new AbortController().signal);
  expect(notify).toHaveBeenCalledOnce();
  expect(notify.mock.calls[0][0]).toContain("delivery-card coordinates");
  expect(JSON.stringify(logged.mock.calls)).toContain("missing_delivery_coordinates");
});

it("does not report a missing patch while the deliverables service has not activated", async () => {
  const { ctx, providers, notify } = await fixture({ coordinates: false, mentions: false });
  const [provider] = providers;
  provider.resolve({ sessionId: "viewed", path: "report.txt" }, new AbortController().signal);
  expect(notify).not.toHaveBeenCalled();
  ctx.provide("deliveryCardCoordinates", { version: 1 });
  ctx.provide("chatFileMentions", { forClosing() {} });
  provider.resolve({ sessionId: "viewed", path: "report.txt" }, new AbortController().signal);
  expect(notify).not.toHaveBeenCalled();
});

it("does not delay the original menu while delivery metadata is pending", async () => {
  const { providers } = await fixture();
  const [provider] = providers;
  const reply = Promise.withResolvers();
  vi.stubGlobal("fetch", vi.fn(() => reply.promise));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const actions = provider.resolve({ sessionId: "viewed", path: "report.txt", delivery: { seq: 2, index: 0 } }, new AbortController().signal);
  expect(actions).toEqual([{ id: "copy-file", label: "复制文件（需要匹配的桌面补丁）", disabled: true }]);
  reply.resolve(new Response("failed", { status: 503 }));
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
});

it("resolves only explicit delivery-card targets and logs safe operation identifiers", async () => {
  const { providers } = await fixture();
  const fetcher = vi.fn(async (url) => {
    const query = new URL(url, "http://localhost/").searchParams;
    return Response.json({ location: { host: "harness", hostInstanceId: "host-1", sessionId: query.get("sessionId"),
      messageId: Number(query.get("seq")), attachmentId: Number(query.get("index")) } });
  });
  vi.stubGlobal("fetch", fetcher);
  const logged = vi.spyOn(console, "info").mockImplementation(() => {});
  const [provider] = providers;
  const signal = new AbortController().signal;
  expect(await provider.resolve({ sessionId: "viewed", path: "report.txt" }, signal)).toEqual([]);
  await provider.resolve({ sessionId: "viewed", path: "north/report.txt", delivery: { seq: 2, index: 0 } }, signal);
  await provider.resolve({ sessionId: "viewed", path: "south/report.txt", delivery: { seq: 5, index: 1 } }, signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(logged).toHaveBeenCalledTimes(2));
  const requests = fetcher.mock.calls.map(([url]) => new URL(url, "http://localhost/").searchParams);
  expect(requests.map(query => [query.get("sessionId"), query.get("seq"), query.get("index")]))
    .toEqual([["viewed", "2", "0"], ["viewed", "5", "1"]]);
  expect(logged.mock.calls.map(([text]) => JSON.parse(text).operationId))
    .toEqual(requests.map(query => query.get("operationId")));
  expect(JSON.stringify(logged.mock.calls)).not.toContain("report.txt");
});

it("does not expose a path-shaped session ID in resolution diagnostics", async () => {
  const { providers } = await fixture();
  const sessionId = "C:/private/customer/session";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ location: {
    host: "harness", hostInstanceId: "host-1", sessionId, messageId: 2, attachmentId: 0,
  } })));
  const logged = vi.spyOn(console, "info").mockImplementation(() => {});
  const [provider] = providers;
  provider.resolve({ sessionId, path: "report.txt", delivery: { seq: 2, index: 0 } }, new AbortController().signal);
  await vi.waitFor(() => expect(logged).toHaveBeenCalledOnce());
  const message = JSON.parse(logged.mock.calls[0][0]);
  expect(message).toMatchObject({ host: "harness", stage: "resolved" });
  expect(message.operationId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(JSON.stringify(logged.mock.calls)).not.toContain("C:/private");
  expect(message).not.toHaveProperty("location");
  expect(message).not.toHaveProperty("key");
});

it("withdraws the menu contribution on unload and registers it only once on reload", async () => {
  const { providers, unload, reload } = await fixture();
  expect(providers.size).toBe(1);
  await unload();
  expect(providers.size).toBe(0);
  await reload();
  expect(providers.size).toBe(1);
});

it("reports a failed or mismatched Host response and suppresses cancellation", async () => {
  const { providers } = await fixture();
  const [provider] = providers;
  const target = { sessionId: "viewed", path: "private/report.txt", delivery: { seq: 2, index: 0 } };
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("failure", { status: 503 }))
    .mockResolvedValueOnce(Response.json({ location: { host: "harness", hostInstanceId: "host-1", sessionId: "other", messageId: 2, attachmentId: 0 } })));
  expect(provider.resolve(target, new AbortController().signal)[0].disabled).toBe(true);
  expect(provider.resolve(target, new AbortController().signal)[0].disabled).toBe(true);
  await vi.waitFor(() => expect(logged).toHaveBeenCalledTimes(2));
  expect(JSON.stringify(logged.mock.calls)).not.toContain("private");
  const cancelled = new AbortController();
  cancelled.abort();
  expect(provider.resolve(target, cancelled.signal)).toEqual([]);
  expect(logged).toHaveBeenCalledTimes(2);
});

it("visibly reports lookup failures without exposing paths", async () => {
  const { providers, notify } = await fixture();
  const [provider] = providers;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response("delivery_not_found", { status: 404 }))
    .mockResolvedValueOnce(new Response("session_corrupt", { status: 500 })));
  const target = { sessionId: "viewed", path: "report.txt", delivery: { seq: 2, index: 0 } };
  expect(provider.resolve(target, new AbortController().signal)[0].disabled).toBe(true);
  expect(provider.resolve(target, new AbortController().signal)[0].disabled).toBe(true);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
  expect(notify.mock.calls[0][0]).toContain("Could not resolve");
  expect(notify.mock.calls[1][0]).toContain("Could not resolve");
});

it("copies the captured delivery using a Host grant and confirms only the desktop result", async () => {
  const { providers, notify } = await fixture();
  const copy = vi.fn(async () => ({ status: "copied" }));
  vi.stubGlobal("dshDesktop", { sessionFileActions: { begin: vi.fn(async () => true), copy, cancel: vi.fn() } });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "grant", location: {
    host: "harness", hostInstanceId: "host-1", sessionId: "viewed", messageId: 2, attachmentId: 0,
  } })));
  const actions = [...providers][0].resolve({ sessionId: "viewed", path: "ignored", delivery: { seq: 2, index: 0 } }, new AbortController().signal);
  expect(copy).not.toHaveBeenCalled();
  await actions[0].run();
  expect(copy).toHaveBeenCalledOnce();
  expect(copy.mock.calls[0][0]).toMatchObject({ token: "grant", sessionId: "viewed", hostInstanceId: "host-1" });
  expect(copy.mock.calls[0][0]).not.toHaveProperty("path");
  expect(notify).toHaveBeenCalledWith("已复制 1 个文件");
});

it.each(["pending", "failed"])("accepts B before its %s authorization and cancels A's publication eligibility", async mode => {
  const { providers } = await fixture();
  const gate = Promise.withResolvers(); const authorizingB = Promise.withResolvers();
  let eligible; const published = [];
  const begin = vi.fn(async id => { eligible = id; return true; });
  const copy = vi.fn(async request => { await gate.promise; if (eligible === request.operationId) published.push(request.operationId); return { status: "cancelled" }; });
  vi.stubGlobal("dshDesktop", { sessionFileActions: { begin, copy, cancel: vi.fn() } });
  let authorizations = 0;
  vi.stubGlobal("fetch", vi.fn(async url => {
    const query = new URL(url, "http://local/").searchParams;
    if (query.get("authorize") && ++authorizations === 2) { if (mode === "failed") return new Response("denied", { status: 403 }); return authorizingB.promise; }
    return Response.json({ token: "grant", location: { host: "harness", hostInstanceId: "host-1", sessionId: "viewed", messageId: 2, attachmentId: 0 } });
  }));
  const action = [...providers][0].resolve({ sessionId: "viewed", path: "report.bin", delivery: { seq: 2, index: 0 } }, new AbortController().signal)[0];
  const a = action.run(); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
  const b = action.run().catch(() => {}); await vi.waitFor(() => expect(begin).toHaveBeenCalledTimes(2));
  gate.resolve(); await a; expect(published).toEqual([]);
  authorizingB.resolve(new Response("denied", { status: 403 })); await b;
});
it("aborts an older pending authorization when a new copy is accepted, and unload cancels pending main copies", async () => {
  const { providers, unload } = await fixture(); const waiting = Promise.withResolvers();
  const signals = []; const cancel = vi.fn(); const copy = vi.fn(async () => { await waiting.promise; return { status: "cancelled" }; });
  vi.stubGlobal("dshDesktop", { sessionFileActions: { begin: vi.fn(async () => true), copy, cancel: async id => { cancel(id); waiting.resolve(); } } });
  let authorization = 0;
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (new URL(url, "http://local/").searchParams.get("authorize") && ++authorization === 1) {
      signals.push(options.signal);
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason)));
    }
    return Response.json({ token: "grant", location: { host: "harness", hostInstanceId: "host-1", sessionId: "viewed", messageId: 2, attachmentId: 0 } });
  }));
  const action = [...providers][0].resolve({ sessionId: "viewed", path: "report.bin", delivery: { seq: 2, index: 0 } }, new AbortController().signal)[0];
  const a = action.run(); await vi.waitFor(() => expect(signals).toHaveLength(1));
  const b = action.run(); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
  expect(signals[0].aborted).toBe(true); await a;
  await unload(); await b; expect(cancel).toHaveBeenCalledOnce();
});

it.each([
  ["disk_full", "磁盘空间不足"], ["permission_denied", "无读取权限"], ["too_large", "32 MiB"], ["io_error", "文件读写错误"],
])("shows the failed attachment and safe %s reason", async (reason, expected) => {
  const { providers, notify } = await fixture();
  vi.stubGlobal("dshDesktop", { sessionFileActions: { begin: vi.fn(async () => true), cancel: vi.fn(), copy: vi.fn(async () => ({ status: "failed", reason })) } });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "grant", location: {
    host: "harness", hostInstanceId: "host-1", sessionId: "viewed", messageId: 2, attachmentId: 0,
  } })));
  const action = [...providers][0].resolve({ sessionId: "viewed", path: "private/report.bin", delivery: { seq: 2, index: 0 } }, new AbortController().signal)[0];
  await action.run(); const message = notify.mock.calls.at(-1)[0];
  expect(message).toContain("report.bin"); expect(message).toContain(expected); expect(message).not.toContain("private/");
});

it.each(["copied", "unconfirmed"])("retains A's %s receipt when B is rejected as busy", async status => {
  const { providers, notify } = await fixture(); const receipt = Promise.withResolvers();
  const begin = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const copy = vi.fn(() => receipt.promise);
  vi.stubGlobal("dshDesktop", { sessionFileActions: { begin, copy, cancel: vi.fn() } });
  const fetcher = vi.fn(async () => Response.json({ token: "grant", location: {
    host: "harness", hostInstanceId: "host-1", sessionId: "viewed", messageId: 2, attachmentId: 0,
  } })); vi.stubGlobal("fetch", fetcher);
  const action = [...providers][0].resolve({ sessionId: "viewed", path: "report.bin", delivery: { seq: 2, index: 0 } }, new AbortController().signal)[0];
  const a = action.run(); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
  const b = action.run(); await b;
  receipt.resolve({ status, reason: status === "unconfirmed" ? "publish_failed" : undefined }); await a;
  expect(copy).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(2);
  const messages = notify.mock.calls.map(([message]) => message);
  expect(messages.some(message => message.includes(status === "copied" ? "已复制 1 个文件" : "结果未确认"))).toBe(true);
  expect(messages.some(message => message.includes("正在发布另一操作"))).toBe(true);
});
