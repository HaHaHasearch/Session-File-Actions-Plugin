import { attachmentKey, type AttachmentLocation } from "@session-file-actions/core";
import type { IdentityResult } from "../ipc";

export function identify(input: unknown): IdentityResult {
  if (typeof input !== "object" || input === null || !("host" in input) || input.host !== "opencode" ||
      !("hostInstanceId" in input) || typeof input.hostInstanceId !== "string" ||
      !("sessionId" in input) || typeof input.sessionId !== "string" ||
      !("messageId" in input) || typeof input.messageId !== "string" ||
      !("attachmentId" in input) || typeof input.attachmentId !== "string") {
    return { type: "invalid", reason: "invalid_location" };
  }
  if (!input.hostInstanceId || !input.sessionId || !input.messageId)
    return { type: "invalid", reason: "invalid_location" };
  const match = /^(file|reference):(0|[1-9][0-9]*)$/.exec(input.attachmentId);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return { type: "invalid", reason: "invalid_attachment" };

  const location: AttachmentLocation = {
    host: "opencode",
    hostInstanceId: input.hostInstanceId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    attachmentId: input.attachmentId,
  };
  return { type: "identified", key: attachmentKey(location) };
}
