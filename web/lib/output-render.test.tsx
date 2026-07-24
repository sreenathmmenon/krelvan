import { test } from "node:test";
import assert from "node:assert/strict";
import { previewText } from "./output-render.js";

test("inbox preview turns markdown tables into readable field summaries", () => {
  const preview = previewText([
    "Verified Todo Record",
    "| Field | Verified value | Type |",
    "|---|---:|---|",
    "| userId | 1 | number |",
    "| id | 1 | number |",
    "| title | delectus aut autem | string |",
    "| completed | false | boolean |",
    "",
    "Source: https://jsonplaceholder.typicode.com/todos/1",
  ].join("\n"), 220);

  assert.equal(
    preview,
    "Verified Todo Record · userId: 1 · id: 1 · title: delectus aut autem · completed: false",
  );
  assert.doesNotMatch(preview, /\|/);
  assert.doesNotMatch(preview, /---/);
});
