import { attachmentKey, type AttachmentLocation } from "@session-file-actions/core";
import type { Toasts } from "@opencode/plugin/gui";
import type { IdentityResult } from "../ipc";

type Location = AttachmentLocation & { host: "opencode"; messageId: string; attachmentId: string };
type Failure =
  | { phase: "request" | "subscribe" | "sync"; reason: "unavailable" | "method" | "input" | "output" | "failed" | "unknown" }
  | { phase: "main"; reason: "invalid_location" | "invalid_attachment" }
  | { phase: "verify"; reason: "invalid_location" | "identity_mismatch" };

let sequence = 0;

export function bindAttachmentCard(input: {
  element: EventTarget;
  location: Location;
  signal: AbortSignal;
  identify: (location: Location, options: { signal: AbortSignal }) => Promise<IdentityResult>;
  toast: Toasts;
  translate: (key: string) => string;
}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal.aborted) abort();
  else input.signal.addEventListener("abort", abort, { once: true });
  const onContextMenu = () => {
    if (controller.signal.aborted) return;
    const operationId = `${Date.now().toString(36)}-${++sequence}`;
    const active = () => !controller.signal.aborted;
    const fail = (failure: Failure) => {
      if (!active()) return;
      console.error("[session-file-actions]", { host: "opencode", operationId, ...failure });
      input.toast.show({
        variant: "error",
        title: input.translate("identity.failed"),
        description: input.translate("identity.failed.description"),
      });
    };
    void (async () => {
      let result: IdentityResult;
      try {
        result = await input.identify(input.location, { signal: controller.signal });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        const reason = code === "unavailable" || code === "method" || code === "input" || code === "output" || code === "failed"
          ? code : "unknown";
        const stage = typeof error === "object" && error !== null && "phase" in error ? error.phase : undefined;
        const phase = reason === "failed" && (stage === "subscribe" || stage === "sync") ? stage : "request";
        fail({ phase, reason });
        return;
      }
      if (!active()) return;
      if (result.type === "invalid") {
        fail({ phase: "main", reason: result.reason });
        return;
      }
      let expected: string;
      try {
        expected = attachmentKey(input.location);
      } catch {
        fail({ phase: "verify", reason: "invalid_location" });
        return;
      }
      if (result.key !== expected) {
        fail({ phase: "verify", reason: "identity_mismatch" });
        return;
      }
      console.info("[session-file-actions] identity tuple echoed", {
        host: "opencode", operationId,
      });
    })();
  };
  input.element.addEventListener("contextmenu", onContextMenu);
  return () => {
    abort();
    input.signal.removeEventListener("abort", abort);
    input.element.removeEventListener("contextmenu", onContextMenu);
  };
}
