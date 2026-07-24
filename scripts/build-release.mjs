#!/usr/bin/env node
/** Produce a clean runtime-only dist directory. Tests and demos never enter customer packages. */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
const tsc = process.platform === "win32"
  ? join(root, "node_modules", ".bin", "tsc.cmd")
  : join(root, "node_modules", ".bin", "tsc");
const result = spawnSync(tsc, ["-p", "tsconfig.release.json"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
