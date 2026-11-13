import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copySnapshot } from "./copy";
const boundary = vi.hoisted(() => ({ afterWrite: (): void => {} }));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: async (...args: Parameters<typeof original.writeFile>) => {
    await original.writeFile(...args); boundary.afterWrite();
  } };
});
const roots: string[] = [];
afterEach(async () => { boundary.afterWrite = () => {}; for (const root of roots.splice(0)) await rm(root, { recursive: true }); });
async function root() { const base = resolve(import.meta.dirname, "../../../..", ".local/tmp/04-copy-tests"); await mkdir(base, { recursive: true }); const path = await mkdtemp(join(base, "test-")); roots.push(path); return path; }
it("publishes a verified independent binary snapshot that survives completion", async () => {
  const bytes = new Uint8Array([0, 255, 32]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  let published = "";
  await copySnapshot(await root(), "report.bin", bytes, hash, new AbortController().signal, async uri => { published = uri; });
  bytes.fill(1);
  expect([...await readFile(fileURLToPath(published.trim()))]).toEqual([0, 255, 32]);
});
it("never publishes corrupt bytes or unsafe names", async () => {
  const publish = vi.fn(); const bytes = new Uint8Array([1]); const hash = createHash("sha256").update(bytes).digest("hex");
  const directory = await root();
  for (const name of ["../escape", "CON.txt", "trailing."]) await expect(copySnapshot(directory, name, bytes, hash, new AbortController().signal, publish)).rejects.toThrow("invalid_filename");
  await expect(copySnapshot(directory, "ok.bin", bytes, "0".repeat(64), new AbortController().signal, publish)).rejects.toThrow("integrity_failed");
  expect(publish).not.toHaveBeenCalled();
});

it("removes the partial snapshot when cancelled after disk write but before publication", async () => {
  const directory = await root(); const controller = new AbortController(); const publish = vi.fn();
  const bytes = new Uint8Array([7, 0, 255]); const hash = createHash("sha256").update(bytes).digest("hex");
  boundary.afterWrite = () => controller.abort();
  await expect(copySnapshot(directory, "binary.bin", bytes, hash, controller.signal, publish)).rejects.toThrow();
  expect(publish).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
});
