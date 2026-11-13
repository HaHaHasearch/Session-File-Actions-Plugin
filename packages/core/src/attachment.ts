export interface AttachmentLocation {
  host: "harness" | "opencode";
  hostInstanceId: string;
  sessionId: string;
  messageId: string | number;
  attachmentId: string | number;
}

export function attachmentKey(location: AttachmentLocation): string {
  const identifiers = [
    location.host,
    location.hostInstanceId,
    location.sessionId,
    location.messageId,
    location.attachmentId,
  ];
  if (identifiers.some((id) =>
    typeof id === "string" ? id.length === 0 : !Number.isSafeInteger(id) || id < 0
  )) {
    throw new Error("Attachment location requires stable identifiers");
  }
  return JSON.stringify(identifiers);
}
