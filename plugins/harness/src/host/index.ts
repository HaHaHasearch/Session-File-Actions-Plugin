import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-tool-present/types";
import type {} from "@deepseek-ai/dsh-api-workspace-files";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import { basename } from "node:path";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
import { createHash, randomUUID } from "node:crypto";
import { attachmentKey, type AttachmentLocation } from "@session-file-actions/core";

export const inject = ["connection", "sessionQuery"];

const path = "/api/session-file-actions.resolve";

function coordinate(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function failure(error: unknown): { status: number; reason: string } {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (error instanceof Error && error.name === "SessionPersistenceCorruptionError") return { status: 500, reason: "session_corrupt" };
  if (error instanceof Error && error.name === "SessionPersistenceNotFoundError") return { status: 404, reason: "not_found" };
  if (code === "workspace-file/too-large" || code === "FS_TOO_LARGE") return { status: 413, reason: "too_large" };
  if (code === "EIO") return { status: 500, reason: "io_error" };
  if (code === "FS_PERMISSION_DENIED" || code === "FS_SANDBOX_DENIED" || code === "EACCES" || code === "EPERM") {
    return { status: 403, reason: "permission_denied" };
  }
  if (code === "SESSION_QUERY_PERSISTENCE_FAILED") {
    const cause = error instanceof Error ? error.cause : undefined;
    const causeCode = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
    if (causeCode === "EACCES" || causeCode === "EPERM") return { status: 403, reason: "permission_denied" };
    return { status: 500, reason: "persistence_failed" };
  }
  if (code === "SESSION_QUERY_CORRUPT_SESSION") return { status: 500, reason: "session_corrupt" };
  if (code === "SESSION_QUERY_SOURCE_CONFLICT") return { status: 500, reason: "source_conflict" };
  if (code === "workspace-file/not-regular-file" || code === "FS_NOT_REGULAR_FILE") {
    return { status: 422, reason: "not_regular_file" };
  }
  if (code === "SESSION_QUERY_SESSION_NOT_FOUND" || code === "SESSION_QUERY_EVENT_NOT_FOUND"
    || code === "workspace-file/not-found" || code === "FS_NOT_FOUND"
    || code === "ENOENT" || code === "ENOTDIR") return { status: 404, reason: "not_found" };
  return { status: 500, reason: "internal_failure" };
}

export function apply(ctx: Context): void {
  const hostInstanceId = createHash("sha256").update("session-file-actions:").update(ctx.connection.browserPeer.id).digest("hex");
  const lifetime = new AbortController();
  const pending = new Set<Promise<Response>>();
  const grants = new Map<string, { query: string; expires: number; operationId: string; sessionId: string }>();
  ctx.effect(() => () => grants.clear());
  ctx.connection.fetch.register({
    path: "/api/session-file-actions.copy", methods: ["POST"], requestBody: "buffered",
    async fetch(request) {
      const rejectGrant = (operationId: string = randomUUID()): Response => {
        ctx.logger.warn(JSON.stringify({ operationId, host: "harness", stage: "grant", reason: "invalid_grant" }));
        return new Response("invalid_grant", { status: 403 });
      };
      let value: unknown;
      try { value = await request.json(); } catch { return rejectGrant(); }
      if (typeof value !== "object" || value === null || !("token" in value) || typeof value.token !== "string") return rejectGrant();
      const grant = grants.get(value.token);
      grants.delete(value.token);
      if (!grant || grant.expires < Date.now() || !("hostInstanceId" in value) || value.hostInstanceId !== hostInstanceId
        || !("sessionId" in value) || value.sessionId !== grant.sessionId || !("operationId" in value) || value.operationId !== grant.operationId) return rejectGrant(grant?.operationId);
      const task = resolve(ctx, new Request(`http://localhost${path}?${grant.query}`), hostInstanceId, AbortSignal.any([request.signal, lifetime.signal]), true);
      pending.add(task);
      try { return await task; } finally { pending.delete(task); }
    },
  });
  ctx.effect(() => async () => {
    lifetime.abort();
    await Promise.allSettled(pending);
  });
  ctx.connection.fetch.register({
    path, methods: ["GET"], requestBody: "buffered",
    fetch(request) {
      const task = (async () => {
        const response = await resolve(ctx, request, hostInstanceId, AbortSignal.any([request.signal, lifetime.signal]));
        const query = new URL(request.url).searchParams;
        if (!response.ok || query.get("authorize") !== "copy") return response;
        for (const [token, grant] of grants) if (grant.expires < Date.now()) grants.delete(token);
        if (grants.size >= 128) return new Response("grant_limit", { status: 429 });
        const operationId = query.get("operationId");
        const sessionId = query.get("sessionId");
        if (!operationId || !sessionId) return new Response("invalid_coordinates", { status: 400 });
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null) throw new Error("Invalid identity response");
        const token = randomUUID();
        grants.set(token, { query: query.toString(), expires: Date.now() + 60_000, operationId, sessionId });
        return Response.json({ ...payload, token }, { headers: { "cache-control": "no-store" } });
      })();
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
  });
}

async function resolve(ctx: Context, request: Request, hostInstanceId: string, signal: AbortSignal, content = false): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const requestedOperation = query.get("operationId");
  const operationId = requestedOperation !== null && /^[0-9a-f-]{36}$/i.test(requestedOperation) ? requestedOperation : randomUUID();
  const sessionId = query.get("sessionId");
  const seq = coordinate(query.get("seq"));
  const index = coordinate(query.get("index"));
  const fail = (status: number, stage: string, reason: string): Response => {
    ctx.logger.warn(JSON.stringify({ operationId, host: "harness", stage, reason }));
    return new Response(reason, { status, headers: { "cache-control": "no-store" } });
  };
  if (!sessionId || seq === undefined || index === undefined
    || ["sessionId", "seq", "index"].some(key => query.getAll(key).length !== 1)
    || query.getAll("operationId").length > 1 || (requestedOperation !== null && !/^[0-9a-f-]{36}$/i.test(requestedOperation))) {
    return fail(400, "coordinates", "invalid_coordinates");
  }
  signal.throwIfAborted();
  let read: Awaited<ReturnType<Context["sessionQuery"]["readEvent"]>>;
  try {
    read = await ctx.sessionQuery.readEvent({ sessionId: SessionId(sessionId), seq: SessionSeq(seq), before: 0, after: 0 }, signal);
  } catch (error: unknown) {
    signal.throwIfAborted();
    const { status, reason } = failure(error);
    return fail(status, "event", reason);
  }
  const data: unknown = read.target.data;
  if (read.session.id !== sessionId || read.target.seq !== seq) return fail(500, "event", "inconsistent_event");
  if (read.target.type !== "deliverables/presented" || typeof data !== "object" || data === null || Array.isArray(data)
    || !("turn" in data) || typeof data.turn !== "number" || !Number.isSafeInteger(data.turn) || data.turn < 1
    || !("callId" in data) || typeof data.callId !== "string" || data.callId.length === 0
    || !("files" in data) || !Array.isArray(data.files)) return fail(404, "event", "delivery_not_found");
  const file: unknown = data.files[index];
  if (typeof file !== "object" || file === null || Array.isArray(file) || !("path" in file)
    || typeof file.path !== "string" || file.path.trim().length === 0
    || ("description" in file && file.description !== undefined && typeof file.description !== "string")) {
    return fail(404, "event", "delivery_not_found");
  }
  signal.throwIfAborted();
  const location: AttachmentLocation = { host: "harness", hostInstanceId, sessionId, messageId: seq, attachmentId: index };
  attachmentKey(location);
  if (content) {
    try {
      const files = ctx.get("workspaceFiles");
      const policy = ctx.get("sandboxPolicy");
      if (!files || !policy) return fail(503, "read", "file_service_unavailable");
      const result = await files.readBytes({ sessionId: SessionId(sessionId), workspaceRoot: read.session.cwd ?? policy.workspaceRoot }, file.path, {}, signal);
      signal.throwIfAborted();
      if (!result.eof || result.offset !== 0 || result.data.length !== result.bytes) return fail(409, "read", "source_changed");
      return new Response(new Uint8Array(result.data), { headers: {
        "content-type": "application/octet-stream", "cache-control": "no-store",
        "x-copy-name": encodeURIComponent(basename(file.path.replaceAll("\\", "/"))),
        "x-copy-size": String(result.data.length), "x-copy-sha256": createHash("sha256").update(result.data).digest("hex"),
        "x-copy-host": hostInstanceId, "x-copy-operation": operationId,
      } });
    } catch (error: unknown) {
      signal.throwIfAborted();
      const { status, reason } = failure(error);
      return fail(status, "read", reason);
    }
  }
  return Response.json({ location }, { headers: { "cache-control": "no-store" } });
}
