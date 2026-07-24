import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("launcher: --help prints usage and exits without starting or building", () => {
  const result = spawnSync(process.execPath, [resolve("bin/krelvan.mjs"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, KRELVAN_SKIP_BUILD: "1" },
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /krelvan \[up\]/);
  assert.doesNotMatch(result.stdout, /Krelvan is up/);
  assert.doesNotMatch(result.stdout, /starting API/);
});

test("launcher: -h is the same non-starting help path", () => {
  const result = spawnSync(process.execPath, [resolve("bin/krelvan.mjs"), "-h"], {
    encoding: "utf8",
    env: { ...process.env, KRELVAN_SKIP_BUILD: "1" },
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.doesNotMatch(result.stdout, /Krelvan is up/);
});
