import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMarkdownTable, splitMarkdownTableRow } from "./markdown-table.js";

test("markdown table: parses header, alignment, and body rows", () => {
  const table = parseMarkdownTable([
    "| Country | Population | Density |",
    "| :--- | ---: | :---: |",
    "| India | 1,380,004,385 | 420 |",
    "| Japan | 125,836,021 | 333 |",
    "",
  ], 0);

  assert.deepEqual(table, {
    header: ["Country", "Population", "Density"],
    alignments: ["left", "right", "center"],
    rows: [
      ["India", "1,380,004,385", "420"],
      ["Japan", "125,836,021", "333"],
    ],
    nextLine: 4,
  });
});

test("markdown table: escaped and inline-code pipes remain inside their cells", () => {
  assert.deepEqual(
    splitMarkdownTableRow("| Rule | `a | b` and left \\| right |"),
    ["Rule", "`a | b` and left | right"],
  );
});

test("markdown table: ordinary pipe-delimited prose is not accepted without a separator", () => {
  assert.equal(parseMarkdownTable([
    "India | Japan | comparison",
    "This is prose | and remains prose",
  ], 0), null);
});

test("markdown table: rejects malformed and mismatched rows defensively", () => {
  assert.equal(parseMarkdownTable([
    "| A | B |",
    "| -- | --- |",
    "| 1 | 2 |",
  ], 0), null);
  assert.equal(parseMarkdownTable([
    "| A | B |",
    "| --- | --- | --- |",
    "| 1 | 2 |",
  ], 0), null);
});
