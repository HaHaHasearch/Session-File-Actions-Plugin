import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function copySnapshot(
  root: string, name: string, bytes: Uint8Array, expectedHash: string, signal: AbortSignal,
  publish: (uriList: string) => Promise<void>,
): Promise<void> {
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1f]/u.test(name)
    || /[. ]$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) throw new Error("invalid_filename");
  if (!/^[a-f0-9]{64}$/u.test(expectedHash) || createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("integrity_failed");
  signal.throwIfAborted();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "copy-"));
  let publishing = false;
  try {
    const path = join(directory, name);
    await writeFile(path, bytes, { flag: "wx", signal });
    if (createHash("sha256").update(await readFile(path, { signal })).digest("hex") !== expectedHash) throw new Error("integrity_failed");
    signal.throwIfAborted();
    // A published or uncertain clipboard reference must survive plugin and application exit.
    publishing = true;
    await publish(`${pathToFileURL(path).href}\r\n`);
  } finally {
    if (!publishing) await rm(directory, { recursive: true });
  }
}
