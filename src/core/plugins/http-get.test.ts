import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveHttpGetUrl } from "./http-get.js";

test("http_get: current node role wins over a generic URL carried from an earlier fetch", () => {
  const input = {
    url: "https://countries.dev/alpha/IND",
    "fetch-india.role": "Fetch India from https://countries.dev/alpha/IND",
    "fetch-japan.role": "Fetch Japan from https://countries.dev/alpha/JPN",
  };

  assert.equal(resolveHttpGetUrl(input, "fetch-japan"), "https://countries.dev/alpha/JPN");
});

test("http_get: current node-scoped URL has highest precedence", () => {
  const input = {
    url: "https://example.com/generic",
    "fetch.url": "https://example.com/scoped",
    "fetch.role": "Fetch https://example.com/from-role",
  };

  assert.equal(resolveHttpGetUrl(input, "fetch"), "https://example.com/scoped");
});

test("http_get: a dynamic bare URL still works when the current role has no URL", () => {
  assert.equal(
    resolveHttpGetUrl({ url: "https://example.com/dynamic", "fetch.role": "Fetch the requested page" }, "fetch"),
    "https://example.com/dynamic",
  );
});
