#!/usr/bin/env node
/**
 * package-release — produce the downloadable, self-contained CORE release zip.
 *
 * The WordPress-style artifact for the trust/self-host audience: unzip anywhere with
 * Node 22+ installed and run — no npm install, no network, no third-party code. The
 * core has ZERO runtime dependencies (Node built-ins only), which is what makes a
 * genuinely self-contained zip possible:
 *
 *   unzip krelvan-core-<version>.zip
 *   cd krelvan-core-<version>
 *   node bin/krelvan.mjs hello        # first agent + its signed, verifiable proof
 *   node bin/krelvan.mjs up --api-only
 *
 * (The full web UI needs Next.js dependencies — use `npx krelvan` or the repo for that;
 *  the zip's README section says so plainly. No hidden surprises.)
 *
 * Every release ships with SHA256SUMS so the download itself is verifiable — the
 * platform that signs agent runs also ships checksummed releases.
 *
 * Usage: node scripts/package-release.mjs   (builds core first; writes to ./release/)
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const NAME = `krelvan-core-${pkg.version}`;
const RELEASE_DIR = join(ROOT, "release");
const STAGE = join(RELEASE_DIR, NAME);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, cwd: ROOT, ...opts });
  if ((r.status ?? 1) !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed`);
    process.exit(1);
  }
}

console.log(`\npackaging ${NAME} …\n`);

// 1. Fresh core build (tsc only — the zip is core-only by design).
run("npm", ["run", "build"]);

// 2. Stage exactly what the self-contained core needs. Nothing else.
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
const INCLUDE = ["bin", "dist", "capabilities", "README.md", "LICENSE", ".env.example", "docs/TRUST_MODEL.md"];
for (const item of INCLUDE) {
  const src = join(ROOT, item);
  if (!existsSync(src)) continue;
  cpSync(src, join(STAGE, item), { recursive: true });
}
// A minimal package.json (name/version/bin only) so `node bin/krelvan.mjs` resolves
// cleanly and the artifact self-describes — the zip is NOT meant for `npm install`.
writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: pkg.type, bin: pkg.bin, engines: pkg.engines }, null, 2) + "\n",
);

// 3. Zip it (deterministic order via -X to strip extra file attrs).
const zipName = `${NAME}.zip`;
rmSync(join(RELEASE_DIR, zipName), { force: true });
run("zip", ["-r", "-X", "-q", zipName, NAME], { cwd: RELEASE_DIR });

// 4. Checksums — the release is itself a verifiable artifact.
const zipBytes = readFileSync(join(RELEASE_DIR, zipName));
const sha256 = createHash("sha256").update(zipBytes).digest("hex");
writeFileSync(join(RELEASE_DIR, "SHA256SUMS"), `${sha256}  ${zipName}\n`);

rmSync(STAGE, { recursive: true, force: true });

console.log(`\n  release/${zipName}  (${(zipBytes.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  release/SHA256SUMS  ${sha256.slice(0, 16)}…`);
console.log(`\nverify a download:  shasum -a 256 -c SHA256SUMS\n`);
