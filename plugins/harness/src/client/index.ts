import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-context-menu/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import { attachmentKey, type AttachmentLocation } from "@session-file-actions/core";

declare module "@deepseek-ai/cordis" {
  interface Context {
    deliveryCardCoordinates: { readonly version: 1 };
  }
}

export const inject = ["contextMenus"];
const safeHostFailures = new Set([
  "too_large", "io_error", "invalid_grant", "invalid_coordinates", "permission_denied", "not_found", "not_regular_file", "persistence_failed",
  "session_corrupt", "source_conflict", "internal_failure", "inconsistent_event", "delivery_not_found",
]);

function isLocation(value: unknown, sessionId: string, seq: number, index: number): value is AttachmentLocation {
  return typeof value === "object" && value !== null && "host" in value && value.host === "harness"
    && "hostInstanceId" in value && typeof value.hostInstanceId === "string" && value.hostInstanceId.length > 0
    && "sessionId" in value && value.sessionId === sessionId
    && "messageId" in value && value.messageId === seq && "attachmentId" in value && value.attachmentId === index;
}

export function apply(ctx: Context): void {
  const lifetime = new AbortController();
  const pending = new Set<Promise<void>>();
  const copies = new Map<string, () => Promise<void>>();
  let preparing: AbortController | undefined;
  let missingCapabilityReported = false;
  const hasDeliveryCoordinates = (): boolean => {
    const capability: unknown = ctx.get("deliveryCardCoordinates");
    if (typeof capability === "object" && capability !== null && "version" in capability && capability.version === 1) return true;
    // This existing service is owned by deliverables; its presence shows that
    // activation completed, so an absent marker is not a startup-order guess.
    if (ctx.get("chatFileMentions") !== undefined && !missingCapabilityReported) {
      missingCapabilityReported = true;
      const operationId = crypto.randomUUID();
      console.error(JSON.stringify({ operationId, host: "harness", stage: "capability", status: "failed", reason: "missing_delivery_coordinates" }));
      ctx.contextMenus.notify("This Harness build lacks delivery-card coordinates. Use the patched Harness build.");
    }
    return false;
  };
  ctx.effect(() => {
    const unregister = ctx.contextMenus.register({
      id: "session-file-actions.delivery", target: "file", order: 300,
      resolve(target, signal) {
        if (!hasDeliveryCoordinates()) return [];
        if (!("delivery" in target)) return [];
        if (signal.aborted) return [];
        const operationId = crypto.randomUUID();
        const requestSignal = AbortSignal.any([signal, lifetime.signal]);
        const task = (async () => {
          let stage = "coordinates";
          let reason = "invalid_coordinates";
          try {
            const delivery: unknown = target.delivery;
            if (typeof delivery !== "object" || delivery === null || !("seq" in delivery) || !("index" in delivery)
              || typeof delivery.seq !== "number" || !Number.isSafeInteger(delivery.seq) || delivery.seq < 0
              || typeof delivery.index !== "number" || !Number.isSafeInteger(delivery.index) || delivery.index < 0
              || target.sessionId.length === 0) throw new Error(reason);
            const query = new URLSearchParams({ sessionId: target.sessionId, seq: String(delivery.seq), index: String(delivery.index), operationId });
            stage = "request";
            reason = "transport_failure";
            const response = await fetch(`api/session-file-actions.resolve?${query}`, { signal: requestSignal });
            if (!response.ok) {
              const responseReason = await response.text();
              requestSignal.throwIfAborted();
              reason = safeHostFailures.has(responseReason) ? responseReason : `http_${response.status}`;
              throw new Error(reason);
            }
            stage = "response";
            reason = "invalid_response";
            const payload: unknown = await response.json();
            if (typeof payload !== "object" || payload === null || !("location" in payload)) {
              throw new Error(reason);
            }
            const location: unknown = payload.location;
            if (!isLocation(location, target.sessionId, delivery.seq, delivery.index)) throw new Error(reason);
            attachmentKey(location);
            requestSignal.throwIfAborted();
            console.info(JSON.stringify({ operationId, host: "harness", stage: "resolved" }));
          } catch (_error) {
            if (requestSignal.aborted) return;
            console.error(JSON.stringify({ operationId, host: "harness", stage, status: "failed", reason }));
            ctx.contextMenus.notify("Could not resolve this delivery.");
          }
        })();
        pending.add(task);
        void task.then(() => pending.delete(task), () => pending.delete(task));
        const globals: unknown = globalThis;
        const desktop: unknown = typeof globals === "object" && globals !== null && "dshDesktop" in globals ? globals.dshDesktop : undefined;
        const bridge = typeof desktop === "object" && desktop !== null && "sessionFileActions" in desktop ? desktop.sessionFileActions : undefined;
        if (!isCopyBridge(bridge)) return [{ id: "copy-file", label: "复制文件（需要匹配的桌面补丁）", disabled: true }];
        return [{ id: "copy-file", label: "复制文件", failureLabel: "复制文件失败", run: () => {
          const copyTask = (async () => {
          const controller = new AbortController();
          const copySignal = AbortSignal.any([lifetime.signal, controller.signal]);
          const copyOperation = crypto.randomUUID();
          const delivery: unknown = target.delivery;
          if (typeof delivery !== "object" || delivery === null || !("seq" in delivery) || typeof delivery.seq !== "number"
            || !("index" in delivery) || typeof delivery.index !== "number") throw new Error("invalid_coordinates");
          const query = new URLSearchParams({ sessionId: target.sessionId, seq: String(delivery.seq), index: String(delivery.index), operationId: copyOperation, authorize: "copy" });
          copies.set(copyOperation, () => { controller.abort(); return bridge.cancel(copyOperation); });
          let stage = "accept";
          try {
            const accepted = await bridge.begin(copyOperation);
            if (accepted === false) {
              console.info(JSON.stringify({ operationId: copyOperation, host: "harness", stage, status: "busy", reason: "clipboard_busy" }));
              ctx.contextMenus.notify(`复制未受理：${copyFailureLabel("clipboard_busy")}`);
              return;
            }
            if (accepted !== true) throw new Error("invalid_acceptance");
            preparing?.abort();
            preparing = controller;
            stage = "authorize";
            copySignal.throwIfAborted();
            const response = await fetch(`api/session-file-actions.resolve?${query}`, { signal: copySignal });
            if (!response.ok) {
              const reason = await response.text();
              throw new Error(safeHostFailures.has(reason) ? reason : "authorization_failed");
            }
            const payload: unknown = await response.json();
            if (typeof payload !== "object" || payload === null || !("token" in payload) || typeof payload.token !== "string"
              || !("location" in payload) || !isLocation(payload.location, target.sessionId, delivery.seq, delivery.index)) throw new Error("invalid_authorization");
            copySignal.throwIfAborted();
            if (preparing === controller) preparing = undefined;
            stage = "copy";
            const result = await bridge.copy({ token: payload.token, hostInstanceId: payload.location.hostInstanceId, sessionId: target.sessionId, operationId: copyOperation });
            if (lifetime.signal.aborted) return;
            if (typeof result !== "object" || result === null || !("status" in result)) throw new Error("invalid_copy_result");
            if (result.status === "copied") ctx.contextMenus.notify("已复制 1 个文件");
            else if (result.status === "unconfirmed") {
              const name = target.path.split(/[\\/]/u).at(-1) ?? "附件";
              ctx.contextMenus.notify(`复制 ${name} 结果未确认：${copyFailureLabel("reason" in result ? result.reason : "publish_failed")}`);
            }
            else if (result.status === "cancelled") ctx.contextMenus.notify("复制已取消");
            else {
              const reason = "reason" in result ? result.reason : undefined;
              const detail = copyFailureLabel(reason);
              const name = target.path.split(/[\\/]/u).at(-1) ?? "附件";
              ctx.contextMenus.notify(`复制 ${name} 失败：${detail}`);
            }
          } catch (error: unknown) {
            if (copySignal.aborted) return;
            const reason = error instanceof Error && safeHostFailures.has(error.message) ? error.message : stage === "authorize" ? "authorization_failed" : "copy_failed";
            console.error(JSON.stringify({ operationId: copyOperation, host: "harness", stage, status: "failed", reason }));
            const name = target.path.split(/[\\/]/u).at(-1) ?? "附件";
            ctx.contextMenus.notify(`复制 ${name} 失败：${copyFailureLabel(reason)}`);
          } finally {
            copies.delete(copyOperation);
            if (preparing === controller) preparing = undefined;
          }
          })();
          pending.add(copyTask);
          void copyTask.then(() => pending.delete(copyTask), () => pending.delete(copyTask));
          return copyTask;
        } }];
      },
    });
    return async () => {
      lifetime.abort();
      await Promise.all([...copies.values()].map(cancel => cancel()));
      unregister();
      await Promise.allSettled(pending);
    };
  }, "session-file-actions: delivery menu");
}

interface CopyBridge {
  begin(operationId: string): Promise<boolean>;
  copy(request: { token: string; hostInstanceId: string; sessionId: string; operationId: string }): Promise<unknown>;
  cancel(operationId: string): Promise<void>;
}
function isCopyBridge(value: unknown): value is CopyBridge {
  return typeof value === "object" && value !== null && "begin" in value && typeof value.begin === "function" && "copy" in value && typeof value.copy === "function"
    && "cancel" in value && typeof value.cancel === "function";
}

function copyFailureLabel(reason: unknown): string {
  switch (reason) {
    case "permission_denied": case "host_403": return "无读取权限";
    case "invalid_grant": return "复制授权已失效";
    case "not_found": case "host_404": return "源文件不存在";
    case "too_large": return "源文件超过当前完整读取上限（32 MiB）";
    case "disk_full": return "本地磁盘空间不足";
    case "io_error": return "文件读写错误";
    case "publish_failed": return "系统剪贴板发布失败";
    case "invalid_filename": return "文件名不适用于 Windows";
    case "integrity_failed": return "完整性校验失败";
    case "clipboard_busy": return "剪贴板正在发布另一操作";
    default: return "文件准备失败";
  }
}
