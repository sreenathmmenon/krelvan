import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Tracer, NoopTracer, type SpanRecord, type SpanSink } from "./spans.js";

function collectSink(): { records: SpanRecord[]; sink: SpanSink } {
  const records: SpanRecord[] = [];
  return { records, sink: { emit: (r) => records.push(r) } };
}

describe("ActiveSpan", () => {
  test("emits a record on end()", () => {
    const { records, sink } = collectSink();
    const tracer = new Tracer("trace-1", sink);
    const span = tracer.startRun("test-manifest");
    span.end({ result: "ok" });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.name, "run");
    assert.equal(records[0]!.traceId, "trace-1");
    assert.equal(records[0]!.status, "ok");
    assert.equal(records[0]!.attributes.result, "ok");
    assert.ok(records[0]!.durationMs >= 0);
  });

  test("does not emit twice on double end()", () => {
    const { records, sink } = collectSink();
    const tracer = new Tracer("t", sink);
    const span = tracer.startRun("m");
    span.end();
    span.end();
    assert.equal(records.length, 1);
  });

  test("endError() sets status=error and attaches error attribute", () => {
    const { records, sink } = collectSink();
    const tracer = new Tracer("t", sink);
    const span = tracer.startRun("m");
    span.endError(new Error("boom"), { extra: "x" });
    assert.equal(records[0]!.status, "error");
    assert.equal(records[0]!.attributes.error, "boom");
    assert.equal(records[0]!.attributes.extra, "x");
  });

  test("set() accumulates attributes before end()", () => {
    const { records, sink } = collectSink();
    const tracer = new Tracer("t", sink);
    const span = tracer.startRun("m");
    span.set({ a: 1 }).set({ b: 2 });
    span.end({ c: 3 });
    assert.equal(records[0]!.attributes.a, 1);
    assert.equal(records[0]!.attributes.b, 2);
    assert.equal(records[0]!.attributes.c, 3);
  });
});

describe("Tracer parent/child hierarchy", () => {
  test("startNode() is a child of startRun()", () => {
    const { records, sink } = collectSink();
    const tracer = new Tracer("t", sink);
    const runSpan = tracer.startRun("m");
    const nodeSpan = tracer.startNode("nodeA");
    nodeSpan.end();
    tracer.endNode();
    runSpan.end();
    assert.equal(records[0]!.name, "node:nodeA");
    assert.equal(records[0]!.parentId, runSpan.spanId);
    assert.equal(records[1]!.name, "run");
    assert.equal(records[1]!.parentId, null);
  });

  test("startEffect() is a child of the current node span", () => {
    const { records, sink } = collectSink();
    const tracer = new Tracer("t", sink);
    const runSpan = tracer.startRun("m");
    const nodeSpan = tracer.startNode("nodeA");
    const effectSpan = tracer.startEffect("nodeA", "http.call", 10);
    effectSpan.end({ costCents: 8 });
    nodeSpan.end();
    tracer.endNode();
    runSpan.end();
    assert.equal(records[0]!.name, "effect:http.call");
    assert.equal(records[0]!.parentId, nodeSpan.spanId);
    assert.equal(records[0]!.attributes.estimateCents, 10);
    assert.equal(records[0]!.attributes.costCents, 8);
  });

  test("startFold() is a child of the run span", () => {
    const { records, sink } = collectSink();
    const tracer = new Tracer("t", sink);
    const runSpan = tracer.startRun("m");
    const fold = tracer.startFold();
    fold.end();
    runSpan.end();
    assert.equal(records[0]!.name, "fold");
    assert.equal(records[0]!.parentId, runSpan.spanId);
  });

  test("startEffect() falls back to root span after endNode()", () => {
    const { records, sink } = collectSink();
    const tracer = new Tracer("t", sink);
    const runSpan = tracer.startRun("m");
    const nodeSpan = tracer.startNode("nodeA");
    nodeSpan.end();
    tracer.endNode(); // clears currentNodeSpanId
    const effect = tracer.startEffect("nodeA", "cap", null);
    effect.end();
    runSpan.end();
    // effect should parent to runSpan, not the ended node span
    assert.equal(records[1]!.name, "effect:cap");
    assert.equal(records[1]!.parentId, runSpan.spanId);
  });

  test("startEffect() falls back to root span if no node span started", () => {
    const { records, sink } = collectSink();
    const tracer = new Tracer("t", sink);
    const runSpan = tracer.startRun("m");
    const effect = tracer.startEffect("n", "cap", null);
    effect.end();
    runSpan.end();
    assert.equal(records[0]!.parentId, runSpan.spanId);
  });

  test("estimateCents is preserved as null (not coerced to 0)", () => {
    const { records, sink } = collectSink();
    const tracer = new Tracer("t", sink);
    tracer.startRun("m");
    const e = tracer.startEffect("n", "cap", null);
    e.end();
    assert.equal(records[0]!.attributes.estimateCents, null);
  });
});

describe("NoopTracer", () => {
  test("never throws and accepts all span operations silently", () => {
    const tracer = new NoopTracer();
    const r = tracer.startRun("m");
    const n = tracer.startNode("n");
    const e = tracer.startEffect("n", "c", 1);
    const f = tracer.startFold();
    r.end({ x: 1 });
    n.end();
    tracer.endNode();
    e.endError(new Error("x"));
    f.end();
  });

  test("no shared singleton: end() on one span does not affect another", () => {
    const tracer = new NoopTracer();
    const s1 = tracer.startRun("m");
    s1.end();
    // After s1.end(), a new span must still be independently operable
    const s2 = tracer.startFold();
    // s2.end() must not early-return due to s1's ended flag
    // We can't observe this directly since it's noop, but at minimum it must not throw
    s2.end();
    s2.endError(new Error("x")); // second call — must not throw
  });
});
