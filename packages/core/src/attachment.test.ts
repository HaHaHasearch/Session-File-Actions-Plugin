import { expect, test } from "vitest";
import { attachmentKey, type AttachmentLocation } from "@session-file-actions/core";

test("相同文件在不同消息中可分别选择，重绘后仍能识别原卡片", () => {
  const first: AttachmentLocation & { name: string; content: string; path: string } = {
    host: "harness",
    hostInstanceId: "host-1",
    sessionId: "session-1",
    messageId: "message-1",
    attachmentId: 0,
    name: "report.pdf",
    content: "same bytes",
    path: "same/path/report.pdf",
  };
  const second = { ...first, messageId: "message-2" };
  const selected = new Set([attachmentKey(first), attachmentKey(second)]);

  expect(selected.size).toBe(2);

  const redrawn = { ...first, name: "renamed.pdf", content: "changed", path: "other/path" };
  expect(selected.has(attachmentKey(redrawn))).toBe(true);
  selected.delete(attachmentKey(redrawn));
  expect(selected.has(attachmentKey(first))).toBe(false);
  expect(selected.has(attachmentKey(second))).toBe(true);
  expect(selected.size).toBe(1);
});

test("宿主、实例、会话、消息和附件位置各自区分身份", () => {
  const base: AttachmentLocation = {
    host: "harness",
    hostInstanceId: "host-1",
    sessionId: "session-1",
    messageId: 4,
    attachmentId: 0,
  };
  const locations: AttachmentLocation[] = [
    base,
    { ...base, host: "opencode" },
    { ...base, hostInstanceId: "host-2" },
    { ...base, sessionId: "session-2" },
    { ...base, messageId: 5 },
    { ...base, attachmentId: 1 },
    { ...base, messageId: "4" },
    { ...base, attachmentId: "0" },
  ];

  expect(new Set(locations.map(attachmentKey)).size).toBe(8);
  expect(new Set([
    attachmentKey({ ...base, hostInstanceId: "a/b", sessionId: "c" }),
    attachmentKey({ ...base, hostInstanceId: "a", sessionId: "b/c" }),
  ]).size).toBe(2);
});

test("不接受缺失或无法可靠表示的出现位置标识", () => {
  const base: AttachmentLocation = {
    host: "harness",
    hostInstanceId: "host-1",
    sessionId: "session-1",
    messageId: 4,
    attachmentId: 0,
  };
  const invalid: AttachmentLocation[] = [
    { ...base, hostInstanceId: "" },
    { ...base, sessionId: "" },
    { ...base, messageId: "" },
    { ...base, attachmentId: "" },
    { ...base, messageId: NaN },
    { ...base, messageId: Infinity },
    { ...base, attachmentId: -1 },
    { ...base, attachmentId: 0.5 },
    { ...base, attachmentId: Number.MAX_SAFE_INTEGER + 1 },
  ];

  for (const location of invalid) {
    expect(() => attachmentKey(location)).toThrow();
  }
});
