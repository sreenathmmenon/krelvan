#!/usr/bin/env node
/**
 * Fail-closed release metadata checks. This runs before every npm pack/publish so a version
 * mismatch, mutable customer dependency, or incomplete npm artifact cannot ship accidentally.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const rootPackage = readJson("package.json");
const rootLock = readJson("package-lock.json");
const webPackage = readJson("web/package.json");
const webLock = readJson("web/package-lock.json");
const versionSource = readFileSync(join(ROOT, "src/version.ts"), "utf8");
const webReleaseSource = readFileSync(join(ROOT, "web/lib/release.ts"), "utf8");
const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const releaseCompose = readFileSync(join(ROOT, "docker-compose.release.yml"), "utf8");
const failures = [];

function requireEqual(label, actual, expected) {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, received ${String(actual)}`);
}

function requireCondition(condition, message) {
  if (!condition) failures.push(message);
}

const version = rootPackage.version;
requireCondition(/^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), `root version is not a valid pre-1.0 release: ${version}`);
requireEqual("root lock version", rootLock.version, version);
requireEqual("root lock package version", rootLock.packages?.[""]?.version, version);
requireEqual("web version", webPackage.version, version);
requireEqual("web lock version", webLock.version, version);
requireEqual("web lock package version", webLock.packages?.[""]?.version, version);

const embedded = versionSource.match(/KRELVAN_VERSION\s*=\s*"([^"]+)"/)?.[1];
requireEqual("embedded protocol version", embedded, version);
const webEmbedded = webReleaseSource.match(/RELEASE_VERSION\s*=\s*"([^"]+)"/)?.[1];
requireEqual("customer-facing web version", webEmbedded, version);
requireEqual("Docker build version", dockerfile.match(/ARG KRELVAN_VERSION=([^\s]+)/)?.[1], version);
const dockerBases = [...dockerfile.matchAll(/^FROM node:([^\s@]+)@sha256:([a-f0-9]{64})/gm)];
requireEqual("pinned Docker stage count", dockerBases.length, 3);
requireCondition(
  dockerBases.every((match) => match[1] === "22.23.1-slim"),
  "every Docker stage must use the reviewed Node.js 22.23.1 slim image",
);
requireEqual(
  "Docker base digest count",
  new Set(dockerBases.map((match) => match[2])).size,
  1,
);
requireEqual("Compose image version", compose.match(/image:\s+\S+:([^\s]+)/)?.[1], version);
requireEqual(
  "release Compose image version",
  releaseCompose.match(/image:\s+\S+:([^\s]+)/)?.[1],
  version,
);

const shippedFiles = new Set(rootPackage.files ?? []);
for (const required of [
  "bin/",
  "dist/",
  "web/app/",
  "web/lib/",
  "web/public/",
  "web/middleware.ts",
  "web/package.json",
  "web/package-lock.json",
  "capabilities/",
]) {
  requireCondition(shippedFiles.has(required), `npm files is missing ${required}`);
}
requireCondition(!shippedFiles.has("src/"), "npm runtime must not ship the development source/test tree");

for (const [scope, dependencies] of [
  ["root", rootPackage.dependencies],
  ["web", webPackage.dependencies],
]) {
  for (const [name, spec] of Object.entries(dependencies ?? {})) {
    requireCondition(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(spec)),
      `${scope} customer dependency ${name} must use an exact version, received ${String(spec)}`,
    );
  }
}

for (const dangerous of ["preinstall", "install", "postinstall"]) {
  requireCondition(!(dangerous in (rootPackage.scripts ?? {})), `root package must not define ${dangerous}`);
  requireCondition(!(dangerous in (webPackage.scripts ?? {})), `web package must not define ${dangerous}`);
}

requireEqual("npm public access", rootPackage.publishConfig?.access, "public");
requireEqual("npm provenance", rootPackage.publishConfig?.provenance, true);
requireEqual(
  "repository",
  rootPackage.repository?.url,
  "git+https://github.com/sreenathmmenon/krelvan.git",
);

if (failures.length > 0) {
  console.error(`release check failed with ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`release metadata verified: krelvan ${version}`);
