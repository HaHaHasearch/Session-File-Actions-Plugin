import { describe, expect, it } from "vitest";
import { identify } from "./identity";

describe("OpenCode message attachment identity", () => {
  const location = {
    host: "opencode",
    hostInstanceId: "server-a",
    sessionId: "session-a",
    messageId: "message-a",
    attachmentId: "file:0",
  };

  it("distinguishes the persisted message and the original item", () => {
    expect(identify(location)).toEqual({ type: "identified", key: '["opencode","server-a","session-a","message-a","file:0"]' });
    expect(identify({ ...location, messageId: "message-b", attachmentId: "reference:2" })).toEqual({
      type: "identified", key: '["opencode","server-a","session-a","message-b","reference:2"]',
    });
  });

  it("rejects malformed locations at the process boundary", () => {
    expect(identify({ ...location, attachmentId: "file:-1" })).toEqual({ type: "invalid", reason: "invalid_attachment" });
    expect(identify({ ...location, attachmentId: "reference:9007199254740992" })).toEqual({ type: "invalid", reason: "invalid_attachment" });
    expect(identify({ ...location, sessionId: "" })).toEqual({ type: "invalid", reason: "invalid_location" });
    expect(identify({ ...location, host: "harness" })).toEqual({ type: "invalid", reason: "invalid_location" });
    expect(identify(null)).toEqual({ type: "invalid", reason: "invalid_location" });
  });
});
