import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const source = new URL("../../../host-patches/harness/0001-feat-deliverables-retain-file-menu-coordinates.patch", import.meta.url);
const directory = new URL("../lib/", import.meta.url);
const target = new URL("../lib/harness-host.patch", import.meta.url);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

const original = await readFile(source);
if (original.includes(13)) throw new Error("Harness host patch must use LF line endings; convert the source patch to LF before packing");
await mkdir(directory, { recursive: true });
await writeFile(target, original);
const staged = await readFile(target);
if (digest(original) !== digest(staged)) throw new Error("Staged Harness patch does not match the project source");
