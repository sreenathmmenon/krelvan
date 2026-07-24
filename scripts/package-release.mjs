#!/usr/bin/env node
/**
 * Build the exact npm tarball that is also uploaded as the manual GitHub Release asset.
 * One artifact means npm customers and manual-download customers receive the same bytes.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = join(ROOT, "release");
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

rmSync(RELEASE_DIR, { recursive: true, force: true });
mkdirSync(RELEASE_DIR, { recursive: true });

run("npm", ["pack", "--pack-destination", RELEASE_DIR]);
const packedFiles = readdirSync(RELEASE_DIR).filter((name) => name.endsWith(".tgz"));
if (packedFiles.length !== 1) {
  throw new Error(`expected one npm artifact, found ${packedFiles.length}`);
}
const packedFile = packedFiles[0];

const artifactPath = join(RELEASE_DIR, packedFile);
const bytes = readFileSync(artifactPath);
const digest = createHash("sha256").update(bytes).digest("hex");
writeFileSync(join(RELEASE_DIR, "SHA256SUMS"), `${digest}  ${packedFile}\n`);
writeFileSync(
  join(RELEASE_DIR, "release-manifest.json"),
  JSON.stringify({
    format: "krelvan-release-manifest:1",
    name: packageJson.name,
    version: packageJson.version,
    artifact: packedFile,
    bytes: bytes.length,
    sha256: digest,
  }, null, 2) + "\n",
);

run(process.execPath, [join(ROOT, "scripts", "scan-release.mjs"), artifactPath]);

console.log(`release/${packedFile}`);
console.log(`release/SHA256SUMS`);
console.log(`release/release-manifest.json`);
