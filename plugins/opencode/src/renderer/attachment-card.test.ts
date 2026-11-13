import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentLocation } from "@session-file-actions/core";
import type { ToastOptions } from "@opencode/plugin/gui";
import type { IdentityResult } from "../ipc";
import { identify } from "../main/identity";
import { bindAttachmentCard } from "./attachment-card";

const location = {
  host: "opencode",
  hostInstanceId: "server-a",
  sessionId: "session-a",
  messageId: "message-a",
  attachmentId: "file:0",
} satisfies AttachmentLocation;

function fixture(
  call: (input: AttachmentLocation, options: { signal: AbortSignal }) => Promise<IdentityResult>,
  cardLocation = location,
  signal = new AbortController(),
) {
  const element = new EventTarget();
  const messages: ToastOptions[] = [];
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const cleanup = bindAttachmentCard({
    element,
    location: cardLocation,
    signal: signal.signal,
    identify: call,
    toast: { show: (message) => { messages.push(message); return { dismiss() {} }; } },
    translate: (key) => key,
  });
  return { element, signal, messages, errors, cleanup };
}

afterEach(() => vi.restoreAllMocks());

describe("original attachment identity feedback", () => {
  it("echoes a valid tuple once and removes its listener on cleanup", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const test = fixture(async (input) => identify(input));
    test.element.dispatchEvent(new Event("contextmenu"));
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info).toHaveBeenCalledWith("[session-file-actions] identity tuple echoed", expect.objectContaining({
      host: "opencode", operationId: expect.any(String),
    }));
    expect(test.messages).toEqual([]);
    test.cleanup();
    test.element.dispatchEvent(new Event("contextmenu"));
    await Promise.resolve();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("reports main-process validation separately from a changed IPC identity", async () => {
    const invalid = fixture(async (input) => identify({ ...input, attachmentId: "file:-1" }));
    invalid.element.dispatchEvent(new Event("contextmenu"));
    await vi.waitFor(() => expect(invalid.messages).toHaveLength(1));
    expect(invalid.errors).toHaveBeenCalledWith("[session-file-actions]", expect.objectContaining({
      host: "opencode", phase: "main", reason: "invalid_attachment", operationId: expect.any(String),
    }));
    expect(invalid.messages[0]).toMatchObject({ variant: "error", title: "identity.failed" });
    invalid.cleanup();
    invalid.errors.mockClear();

    const mismatch = fixture(async () => ({ type: "identified", key: "wrong" }));
    mismatch.element.dispatchEvent(new Event("contextmenu"));
    await vi.waitFor(() => expect(mismatch.messages).toHaveLength(1));
    expect(mismatch.errors).toHaveBeenCalledWith("[session-file-actions]", expect.objectContaining({
      host: "opencode", phase: "verify", reason: "identity_mismatch", operationId: expect.any(String),
    }));
    mismatch.cleanup();
  });

  it("shows a safe error for a rejected bridge without logging its private contents", async () => {
    const test = fixture(async () => { throw Object.assign(new Error("C:\\private\\secret.txt attachment body"), { code: "failed" }); });
    test.element.dispatchEvent(new Event("contextmenu"));
    await vi.waitFor(() => expect(test.messages).toHaveLength(1));
    expect(test.errors).toHaveBeenCalledWith("[session-file-actions]", expect.objectContaining({
      host: "opencode", phase: "request", reason: "failed", operationId: expect.any(String),
    }));
    expect(JSON.stringify([test.errors.mock.calls, test.messages])).not.toContain("private");
    expect(JSON.stringify([test.errors.mock.calls, test.messages])).not.toContain("attachment body");
    test.cleanup();
  });

  it.each(["unavailable", "method", "input", "output", "failed", "sensitive-code"]) (
    "only reports an allowed IPC error code for %s",
    async (code) => {
      const test = fixture(async () => { throw { code, message: "SENSITIVE body", cause: "C:\\private" }; });
      test.element.dispatchEvent(new Event("contextmenu"));
      await vi.waitFor(() => expect(test.messages).toHaveLength(1));
      expect(test.errors).toHaveBeenCalledWith("[session-file-actions]", expect.objectContaining({
        host: "opencode", phase: "request", reason: code === "sensitive-code" ? "unknown" : code,
      }));
      expect(JSON.stringify([test.errors.mock.calls, test.messages])).not.toContain("SENSITIVE");
      expect(JSON.stringify([test.errors.mock.calls, test.messages])).not.toContain("private");
      test.cleanup();
    },
  );

  it("reports a subscription failure with the operation ID and a safe stage", async () => {
    const test = fixture(async () => { throw { phase: "subscribe", code: "failed", message: "SENSITIVE body" }; });
    test.element.dispatchEvent(new Event("contextmenu"));
    await vi.waitFor(() => expect(test.messages).toHaveLength(1));
    expect(test.errors).toHaveBeenCalledWith("[session-file-actions]", {
      host: "opencode", operationId: expect.any(String), phase: "subscribe", reason: "failed",
    });
    expect(JSON.stringify(test.errors.mock.calls)).not.toContain("SENSITIVE");
    test.cleanup();
  });

  it("cancels only the unbound card and cancels the remaining card when the plugin unloads", async () => {
    const plugin = new AbortController();
    const signals: AbortSignal[] = [];
    const call = async (_input: AttachmentLocation, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return new Promise<IdentityResult>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    };
    const first = fixture(call, location, plugin);
    const second = fixture(call, location, plugin);
    first.element.dispatchEvent(new Event("contextmenu"));
    second.element.dispatchEvent(new Event("contextmenu"));
    expect(signals).toHaveLength(2);
    first.cleanup();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    plugin.abort();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    await Promise.resolve();
    await Promise.resolve();
    expect(first.messages).toEqual([]);
    expect(second.messages).toEqual([]);
    expect(first.errors).not.toHaveBeenCalled();
    second.cleanup();
  });

  it("does not start an identity request after the plugin has unloaded", async () => {
    const plugin = new AbortController();
    plugin.abort();
    const call = vi.fn(async (): Promise<IdentityResult> => ({ type: "identified", key: "unused" }));
    const test = fixture(call, location, plugin);
    test.element.dispatchEvent(new Event("contextmenu"));
    await Promise.resolve();
    expect(call).not.toHaveBeenCalled();
    expect(test.messages).toEqual([]);
    test.cleanup();
  });

  it("keeps path-shaped session and message IDs out of success and failure logs", async () => {
    const privateLocation = {
      ...location,
      sessionId: "ses_C:\\Users\\example\\private-session",
      messageId: "msg_C:\\Users\\example\\private-message",
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let received: AttachmentLocation | undefined;
    const success = fixture(async (input) => { received = input; return identify(input); }, privateLocation);
    success.element.dispatchEvent(new Event("contextmenu"));
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(received).toEqual(privateLocation);
    const failure = fixture(async () => ({ type: "identified", key: "different" }), privateLocation);
    failure.element.dispatchEvent(new Event("contextmenu"));
    await vi.waitFor(() => expect(failure.messages).toHaveLength(1));
    const logs = JSON.stringify([info.mock.calls, success.errors.mock.calls, failure.messages]);
    expect(logs).not.toContain(privateLocation.messageId);
    expect(logs).not.toContain(privateLocation.sessionId);
    expect(logs).not.toContain("private-message");
    expect(logs).not.toContain("private-session");
    success.cleanup();
    failure.cleanup();
  });

  it("does not report a cancellation after unload", async () => {
    let reject: ((reason: Error) => void) | undefined;
    const pending = new Promise<IdentityResult>((_resolve, fail) => { reject = fail; });
    const test = fixture(() => pending);
    test.element.dispatchEvent(new Event("contextmenu"));
    test.signal.abort();
    test.cleanup();
    if (!reject) throw new Error("Missing promise rejection handler");
    reject(new Error("cancelled"));
    await Promise.resolve();
    await Promise.resolve();
    expect(test.messages).toEqual([]);
    expect(test.errors).not.toHaveBeenCalled();
  });
});
