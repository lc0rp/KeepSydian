import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const artifactRoot = resolve(repoRoot, ".tmp/wdio");
export const rootPath = (...parts) => resolve(repoRoot, ...parts);
