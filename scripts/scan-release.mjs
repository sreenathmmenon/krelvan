#!/usr/bin/env node
/**
 * Scan the exact customer tarball, not the source checkout. Output reports only finding
 * categories and paths; it never prints a possible secret value.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const projectPackage = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const artifact = process.argv[2]
  ? resolve(process.argv[2])
  : join(projectRoot, "release", `${projectPackage.name}-${projectPackage.version}.tgz`);
if (!existsSync(artifact) || !artifact.endsWith(".tgz")) {
  console.error(`release tarball not found: ${artifact}`);
  process.exit(2);
}

const scanRoot = mkdtempSync(join(tmpdir(), "krelvan-release-scan-"));
const extractedRoot = join(scanRoot, "package");
const failures = [];

try {
  const extraction = spawnSync("tar", ["-xzf", artifact, "-C", scanRoot], {
    stdio: "inherit",
    shell: false,
  });
  if ((extraction.status ?? 1) !== 0) process.exit(extraction.status ?? 1);

  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  }
  walk(extractedRoot);

  const forbiddenFiles = files
    .map((path) => relative(extractedRoot, path))
    .filter((path) => /(^|\/)(src|test|tests)(\/|$)|\.test\.|(^|\/)\.env(?:\.local)?$/.test(path));
  if (forbiddenFiles.length > 0) {
    failures.push(`development or secret-bearing files: ${forbiddenFiles.join(", ")}`);
  }

  const secretPatterns = {
    "OpenAI credential": /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/,
    "Anthropic credential": /sk-ant-[A-Za-z0-9_-]{20,}/,
    "GitHub credential": /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
    "Slack credential": /xox[baprs]-[A-Za-z0-9-]{20,}/,
    "private key": /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  };
  for (const path of files) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const [label, pattern] of Object.entries(secretPatterns)) {
      if (pattern.test(text)) failures.push(`${label} pattern in ${relative(extractedRoot, path)}`);
    }
  }

  const packageJson = JSON.parse(readFileSync(join(extractedRoot, "package.json"), "utf8"));
  if (!existsSync(join(extractedRoot, "web", "package-lock.json"))) {
    failures.push("web/package-lock.json is missing");
  }
  for (const hook of ["preinstall", "install", "postinstall"]) {
    if (packageJson.scripts?.[hook]) failures.push(`package defines a ${hook} lifecycle hook`);
  }

  if (failures.length > 0) {
    console.error(`release artifact scan failed for ${basename(artifact)}:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `release artifact scan passed: ${basename(artifact)} (${files.length} files; no credential patterns, tests, or install hooks)`,
    );
  }
} finally {
  rmSync(scanRoot, { recursive: true, force: true });
}
