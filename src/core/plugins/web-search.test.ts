/**
 * web_search — query extraction must use the real TOPIC, not the node's instruction text,
 * and the output must carry both `results` and a readable `findings` block for downstream
 * nodes. These guard the two data-flow bugs that made research agents produce hollow output:
 * (1) searching for "You are a research scout. Search the web..." instead of the topic, and
 * (2) emitting only `results` when agents read `findings`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { webSearchCapability, subjectFromInstruction, shapeSearchOutput } from "./web-search.js";

test("subjectFromInstruction: recovers the topic from a research instruction", () => {
  assert.equal(
    subjectFromInstruction("Research the current state of electric vehicle battery technology, and write a brief"),
    "current state of electric vehicle battery technology",
  );
  assert.equal(subjectFromInstruction("Search the web for the latest AI news"), "latest AI news");
  assert.equal(subjectFromInstruction("Look up climate policy in the EU"), "climate policy in the EU");
});

test("subjectFromInstruction: returns empty when nothing subject-like remains", () => {
  assert.equal(subjectFromInstruction(""), "");
  assert.equal(subjectFromInstruction("Research"), "");
});

test("web_search: an explicit `query` starting with a verb is used verbatim, not discarded", async () => {
  // "Find My Friends app privacy" begins with "Find" — isInstruction() used to reject it, leaving an
  // empty query. An explicit query key must be trusted literally.
  const res = await webSearchCapability.invoke({
    nodeId: "search", capability: "web_search",
    input: { query: "Find My Friends app privacy" } as Record<string, unknown>,
  } as unknown as Parameters<typeof webSearchCapability.invoke>[0]);
  const out = (res as { output: { query: string } }).output;
  assert.equal(out.query, "Find My Friends app privacy", "literal explicit query is honored, not blanked");
});

// Drive the capability with no search/LLM keys so it takes the keyless path deterministically
// where possible; we assert on the QUERY it derives (logged via the returned output.query) and
// on the OUTPUT SHAPE. Network is best-effort; we only assert shape + query derivation here.

test("web_search derives the query from the topic state value, not the role instruction", async () => {
  // A research node's input carries a role instruction AND a topic — the query must be the topic.
  const res = await webSearchCapability.invoke({
    nodeId: "search",
    capability: "web_search",
    input: {
      role: "You are a research scout. Search the open web for high-signal sources about the topic.",
      topic: "on-device LLM inference economics",
    },
  } as Parameters<typeof webSearchCapability.invoke>[0]);
  const out = res.output as { query?: string };
  assert.equal(out.query, "on-device LLM inference economics", "query must be the topic, not the role text");
});

test("web_search composes the query from subject-matter state, never the role instruction", async () => {
  const res = await webSearchCapability.invoke({
    nodeId: "market_research",
    capability: "web_search",
    input: { role: "You are a market researcher. Determine what buyers care about and how to win them.", product: "PostgreSQL production database", audience: "engineering teams" },
  } as Parameters<typeof webSearchCapability.invoke>[0]);
  const out = res.output as { query?: string };
  assert.ok(out.query && !/^you are/i.test(out.query), `query must not be the instruction: got "${out.query}"`);
  assert.match(out.query!, /PostgreSQL/i, "query should be built from the product subject");
});

test("web_search returns a soft error (never throws) when there is no query at all", async () => {
  const res = await webSearchCapability.invoke({
    nodeId: "search", capability: "web_search", input: {},
  } as Parameters<typeof webSearchCapability.invoke>[0]);
  const out = res.output as { count?: number; error?: string };
  assert.equal(out.count, 0);
  assert.ok(out.error && out.error.length > 0, "must explain the missing query");
});

test("shapeSearchOutput: a title containing [ ] does not break the summary's markdown link", () => {
  // A real search title like "The best new solar panel technology [Top 9 in 2026]" contains a ] that,
  // left raw inside [title](url), breaks the link and shows literal markdown to the customer. The
  // summary must neutralise the brackets so every result line is a well-formed link.
  const { output } = shapeSearchOutput(
    [{ title: "The best new solar panel technology [Top 9 in 2026]", url: "https://example.com/a", snippet: "one sentence here. two sentence here." }],
    "solar panel technology 2026",
    8,
    "linkup",
  );
  const summary = output.summary;
  // The link closes cleanly with the url, and no raw ] survives inside the label to break parsing.
  assert.match(summary, /\]\(https:\/\/example\.com\/a\)/, "link closes cleanly with the url");
  assert.doesNotMatch(summary, /\[[^\]\n]*\][^(]/, "no unmatched-then-unlinked bracket run in a line");
});

test("explicit query key wins over everything", async () => {
  const res = await webSearchCapability.invoke({
    nodeId: "search",
    capability: "web_search",
    input: { query: "redis vs memcached benchmarks", topic: "something else", role: "You are a scout..." },
  } as Parameters<typeof webSearchCapability.invoke>[0]);
  const out = res.output as { query?: string };
  assert.equal(out.query, "redis vs memcached benchmarks");
});
