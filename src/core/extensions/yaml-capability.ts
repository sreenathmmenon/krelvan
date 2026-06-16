/**
 * YAML capability loader — turns a declarative .yaml file into a CapabilityPlugin.
 *
 * This is the zero-TypeScript path for adding capabilities. A power user or ops
 * person drops a .yaml file in their capabilities/ directory and Krelvan picks it
 * up at startup — no code required.
 *
 * The loader:
 *  1. parses the raw YAML text into a plain object
 *  2. validates it against the YamlCapabilitySchema (structural + semantic checks)
 *  3. compiles it into a live CapabilityPlugin that the Supervisor can run
 *
 * Security constraints inherited from the architecture:
 *  - secrets are referenced as {{secret:name}} — never inlined
 *  - the compiled plugin never sees raw secrets (the caller resolves tokens)
 *  - no eval anywhere — template interpolation is a whitelist substitution only
 *  - all costs are integer cents (floats rejected at validation time)
 *
 * Guards:
 *  - EXT-01: unknown sideEffect values are rejected at load time, not run time
 *  - EXT-02: {{secret:name}} references are extracted and reported so the broker
 *    can check they are registered before the first run
 *  - EXT-03: response mapping uses a whitelist of allowed field paths — no eval,
 *    no arbitrary property access chains
 *  - EXT-04: estimateCents must be a non-negative integer (ledger invariant)
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import type { SideEffectClass } from "../manifest/manifest.js";
import { assertPublicUrl } from "../plugins/ssrf-guard.js";

// ── Schema types (what a valid YAML file must contain) ────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface YamlHeader {
  /** literal value or {{secret:name}} reference */
  value: string;
}

export interface YamlHttpBlock {
  url: string;
  method: HttpMethod;
  /** key → literal or {{secret:name}} */
  headers?: Record<string, string>;
  /** body template — only for POST/PUT/PATCH; may reference {{input.field}} */
  body?: Record<string, unknown>;
}

export interface YamlInputField {
  type: "string" | "number" | "boolean" | "object";
  required?: boolean;
  description?: string;
}

export interface YamlOutputField {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
}

/** The full schema of a valid capability YAML file. */
export interface YamlCapabilitySchema {
  /** capability name; must match [a-z][a-z0-9._-]* */
  name: string;
  /** human description — shown in the UI capability catalogue */
  description: string;
  /** side-effect class — drives admission, approval gates, replay */
  sideEffect: SideEffectClass;
  /** pre-flight cost estimate in integer cents (0 = free) */
  estimateCents: number;

  /** the HTTP call to make */
  http: YamlHttpBlock;

  /** declared input fields (what the agent passes in call.input) */
  input?: Record<string, YamlInputField>;

  /** declared output fields (for documentation + UI; not enforced at runtime) */
  output?: Record<string, YamlOutputField>;

  /** dot-path into the HTTP response JSON to use as the output (default: full body) */
  responseField?: string;

  /** expected HTTP success status codes (default: [200, 201, 204]) */
  successCodes?: number[];
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

const VALID_SIDE_EFFECTS: ReadonlySet<string> = new Set<SideEffectClass>([
  "read",
  "write-reversible",
  "write-irreversible",
  "spend",
  "message-human",
  "identity-mutation",
]);

const VALID_METHODS: ReadonlySet<string> = new Set<HttpMethod>([
  "GET", "POST", "PUT", "PATCH", "DELETE",
]);

const VALID_INPUT_TYPES = new Set(["string", "number", "boolean", "object"]);
const VALID_OUTPUT_TYPES = new Set(["string", "number", "boolean", "object", "array"]);

/** EXT-03: only simple dot-paths (no brackets, no spaces, no eval). */
const SAFE_DOT_PATH = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

/** EXT-02: extract all {{secret:name}} references from a string. */
export function extractSecretRefs(s: string): string[] {
  const refs: string[] = [];
  const re = /\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) refs.push(m[1]);
  }
  return refs;
}

/** Extract all {{input.field}} references from a string. */
function extractInputRefs(s: string): string[] {
  const refs: string[] = [];
  const re = /\{\{input\.([a-zA-Z0-9_.]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) refs.push(m[1]);
  }
  return refs;
}

/**
 * Validate a parsed YAML object against the capability schema.
 * Returns all errors (empty array = valid).
 * Pure function — no I/O.
 */
export function validateYamlCapability(raw: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [{ field: "(root)", message: "capability must be a YAML object" }];
  }

  const obj = raw as Record<string, unknown>;

  // ── name ──────────────────────────────────────────────────────────────────
  if (typeof obj["name"] !== "string" || !obj["name"]) {
    errors.push({ field: "name", message: "required string" });
  } else if (!/^[a-z][a-z0-9._-]*$/.test(obj["name"])) {
    errors.push({ field: "name", message: "must match [a-z][a-z0-9._-]* (e.g. 'crm.lookup', 'stripe.charge')" });
  }

  // ── description ───────────────────────────────────────────────────────────
  if (typeof obj["description"] !== "string" || !obj["description"].trim()) {
    errors.push({ field: "description", message: "required non-empty string" });
  }

  // ── sideEffect ────────────────────────────────────────────────────────────
  if (typeof obj["sideEffect"] !== "string") {
    errors.push({ field: "sideEffect", message: "required string" });
  } else if (!VALID_SIDE_EFFECTS.has(obj["sideEffect"])) {
    errors.push({
      field: "sideEffect",
      message: `must be one of: ${[...VALID_SIDE_EFFECTS].join(", ")}`,
    });
  }

  // ── estimateCents ─────────────────────────────────────────────────────────
  if (obj["estimateCents"] === undefined || obj["estimateCents"] === null) {
    errors.push({ field: "estimateCents", message: "required (use 0 if free)" });
  } else if (
    typeof obj["estimateCents"] !== "number" ||
    !Number.isInteger(obj["estimateCents"]) ||
    obj["estimateCents"] < 0
  ) {
    errors.push({ field: "estimateCents", message: "must be a non-negative integer (cents)" });
  }

  // ── http block ────────────────────────────────────────────────────────────
  if (typeof obj["http"] !== "object" || obj["http"] === null || Array.isArray(obj["http"])) {
    errors.push({ field: "http", message: "required object" });
  } else {
    const http = obj["http"] as Record<string, unknown>;

    if (typeof http["url"] !== "string" || !http["url"].trim()) {
      errors.push({ field: "http.url", message: "required non-empty string" });
    } else {
      // url must start with https:// or http:// or {{
      if (!/^(https?:\/\/|\{\{)/.test(http["url"])) {
        errors.push({ field: "http.url", message: "must start with https:// or http:// (or a {{input.*}} reference)" });
      }
    }

    if (typeof http["method"] !== "string") {
      errors.push({ field: "http.method", message: "required string" });
    } else if (!VALID_METHODS.has(http["method"].toUpperCase())) {
      errors.push({ field: "http.method", message: `must be one of: ${[...VALID_METHODS].join(", ")}` });
    } else {
      // body only makes sense for write methods
      const method = (http["method"] as string).toUpperCase();
      if (http["body"] !== undefined && method === "GET") {
        errors.push({ field: "http.body", message: "body is not allowed on GET requests" });
      }
    }

    if (http["headers"] !== undefined) {
      if (typeof http["headers"] !== "object" || Array.isArray(http["headers"])) {
        errors.push({ field: "http.headers", message: "must be a key-value map of strings" });
      } else {
        const headers = http["headers"] as Record<string, unknown>;
        for (const [k, v] of Object.entries(headers)) {
          if (typeof v !== "string") {
            errors.push({ field: `http.headers.${k}`, message: "header value must be a string" });
          }
        }
      }
    }
  }

  // ── input fields ──────────────────────────────────────────────────────────
  if (obj["input"] !== undefined) {
    if (typeof obj["input"] !== "object" || Array.isArray(obj["input"])) {
      errors.push({ field: "input", message: "must be a key-value map of field definitions" });
    } else {
      const inputFields = obj["input"] as Record<string, unknown>;
      for (const [k, v] of Object.entries(inputFields)) {
        if (typeof v !== "object" || v === null) {
          errors.push({ field: `input.${k}`, message: "field definition must be an object" });
        } else {
          const field = v as Record<string, unknown>;
          if (!VALID_INPUT_TYPES.has(field["type"] as string)) {
            errors.push({ field: `input.${k}.type`, message: `must be one of: ${[...VALID_INPUT_TYPES].join(", ")}` });
          }
        }
      }
    }
  }

  // ── output fields ─────────────────────────────────────────────────────────
  if (obj["output"] !== undefined) {
    if (typeof obj["output"] !== "object" || Array.isArray(obj["output"])) {
      errors.push({ field: "output", message: "must be a key-value map of field definitions" });
    } else {
      const outputFields = obj["output"] as Record<string, unknown>;
      for (const [k, v] of Object.entries(outputFields)) {
        if (typeof v !== "object" || v === null) {
          errors.push({ field: `output.${k}`, message: "field definition must be an object" });
        } else {
          const field = v as Record<string, unknown>;
          if (!VALID_OUTPUT_TYPES.has(field["type"] as string)) {
            errors.push({ field: `output.${k}.type`, message: `must be one of: ${[...VALID_OUTPUT_TYPES].join(", ")}` });
          }
        }
      }
    }
  }

  // ── responseField ─────────────────────────────────────────────────────────
  if (obj["responseField"] !== undefined) {
    if (typeof obj["responseField"] !== "string") {
      errors.push({ field: "responseField", message: "must be a string dot-path (e.g. 'data.items')" });
    } else if (!SAFE_DOT_PATH.test(obj["responseField"])) {
      errors.push({ field: "responseField", message: "must be a simple dot-path — letters, digits, underscores, dots only (EXT-03)" });
    }
  }

  // ── successCodes ──────────────────────────────────────────────────────────
  if (obj["successCodes"] !== undefined) {
    if (!Array.isArray(obj["successCodes"])) {
      errors.push({ field: "successCodes", message: "must be an array of integers" });
    } else {
      for (const [i, code] of (obj["successCodes"] as unknown[]).entries()) {
        if (typeof code !== "number" || !Number.isInteger(code) || code < 100 || code > 599) {
          errors.push({ field: `successCodes[${i}]`, message: "must be an integer HTTP status code (100–599)" });
        }
      }
    }
  }

  return errors;
}

// ── Runtime compilation ───────────────────────────────────────────────────────

export type LoadResult =
  | { ok: true; plugin: CapabilityPlugin; secretRefs: string[] }
  | { ok: false; errors: ValidationError[] };

/**
 * Minimal YAML parser — handles the subset we need without a third-party dep.
 * Supports: key: value, nested objects (indentation), arrays (- item),
 * quoted strings, multi-line strings are not supported (not needed for this schema).
 *
 * This is intentionally restricted. We do NOT support arbitrary YAML.
 * If a field fails to parse, validation will catch the missing/wrong value.
 */
export function parseYaml(text: string): unknown {
  const lines = text.split("\n");
  return parseBlock(lines, 0, 0).value;
}

interface ParseResult {
  value: unknown;
  nextLine: number;
}

function parseBlock(lines: string[], startLine: number, baseIndent: number): ParseResult {
  const obj: Record<string, unknown> = {};
  let i = startLine;

  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const stripped = raw.replace(/#.*$/, "").trimEnd(); // strip comments
    if (!stripped.trim()) { i++; continue; } // skip blank/comment lines

    const indent = stripped.length - stripped.trimStart().length;
    if (indent < baseIndent) break; // end of this block
    if (indent > baseIndent) { i++; continue; } // unexpected deeper indent — skip

    const colonIdx = stripped.indexOf(":");
    if (colonIdx < 0) { i++; continue; } // not a key: value line

    const key = stripped.slice(baseIndent, colonIdx).trim();
    const rest = stripped.slice(colonIdx + 1).trim();

    if (!rest) {
      // nested object or array block follows
      const nextNonEmpty = findNextNonEmpty(lines, i + 1);
      if (nextNonEmpty === -1) { obj[key] = {}; i++; continue; }

      const nextRaw = lines[nextNonEmpty] ?? "";
      const nextIndent = nextRaw.length - nextRaw.trimStart().length;
      const nextTrimmed = nextRaw.trimStart();

      if (nextTrimmed.startsWith("- ")) {
        // array
        const arr: unknown[] = [];
        let j = nextNonEmpty;
        while (j < lines.length) {
          const l = (lines[j] ?? "").replace(/#.*$/, "").trimEnd();
          if (!l.trim()) { j++; continue; }
          const lIndent = l.length - l.trimStart().length;
          if (lIndent < nextIndent) break;
          if (lIndent === nextIndent && l.trimStart().startsWith("- ")) {
            arr.push(parseScalar(l.trimStart().slice(2).trim()));
          }
          j++;
        }
        obj[key] = arr;
        i = j;
      } else {
        // nested object
        const nested = parseBlock(lines, nextNonEmpty, nextIndent);
        obj[key] = nested.value;
        i = nested.nextLine;
      }
    } else {
      obj[key] = parseScalar(rest);
      i++;
    }
  }

  return { value: obj, nextLine: i };
}

function findNextNonEmpty(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    const l = (lines[i] ?? "").replace(/#.*$/, "").trim();
    if (l) return i;
  }
  return -1;
}

function parseScalar(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  const n = Number(s);
  if (!isNaN(n) && s.trim() !== "") return n;
  return s;
}

// ── Template interpolation ────────────────────────────────────────────────────

/**
 * Substitute {{secret:name}} and {{input.field}} in a string.
 * Only these two patterns are allowed — no arbitrary expressions (EXT-03).
 */
function interpolate(
  template: string,
  input: Record<string, unknown>,
  secrets: Record<string, string>,
): string {
  return template
    .replace(/\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g, (_, name: string) => {
      const val = secrets[name];
      if (val === undefined) throw new Error(`secret '${name}' is not registered`);
      return val;
    })
    .replace(/\{\{input\.([a-zA-Z0-9_.]+)\}\}/g, (_, path: string) => {
      const val = getPath(input, path);
      if (val === undefined) throw new Error(`input field '${path}' is not provided`);
      return String(val);
    });
}

/** Resolve a dot-path into an object. Only simple paths — no bracket access. */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Walk an object and interpolate all string leaf values. */
function interpolateObject(
  obj: unknown,
  input: Record<string, unknown>,
  secrets: Record<string, string>,
): unknown {
  if (typeof obj === "string") return interpolate(obj, input, secrets);
  if (Array.isArray(obj)) return obj.map((v) => interpolateObject(v, input, secrets));
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = interpolateObject(v, input, secrets);
    }
    return result;
  }
  return obj;
}

// ── Compiler: schema → CapabilityPlugin ──────────────────────────────────────

/**
 * Compile a validated YamlCapabilitySchema into a live CapabilityPlugin.
 * `resolveSecrets` is called at invoke time — it returns the scoped tokens the
 * broker minted for this call. The plugin never holds raw secrets.
 */
export function compileYamlCapability(
  schema: YamlCapabilitySchema,
  resolveSecrets: (refs: string[]) => Record<string, string>,
): CapabilityPlugin {
  const secretRefs = collectSecretRefs(schema);
  const successCodes = new Set(schema.successCodes ?? [200, 201, 204]);

  return {
    name: schema.name,
    sideEffect: schema.sideEffect,

    estimateCents: () => schema.estimateCents,

    async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
      const input = (call.input ?? {}) as Record<string, unknown>;
      const secrets = resolveSecrets(secretRefs);

      // interpolate URL, headers, body
      const url = interpolate(schema.http.url, input, secrets);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(schema.http.headers ?? {})) {
        headers[k] = interpolate(v, input, secrets);
      }

      const fetchOpts: RequestInit = {
        method: schema.http.method,
        headers,
      };

      if (schema.http.body !== undefined) {
        fetchOpts.body = JSON.stringify(interpolateObject(schema.http.body, input, secrets));
        headers["Content-Type"] ??= "application/json";
      }

      // ── SSRF guard ────────────────────────────────────────────────────────────
      // The URL is interpolated from run state ({{input.*}}), so it may be attacker-
      // influenced. Resolve DNS and reject private/loopback/metadata targets before
      // any request leaves the host. (Previously the YAML path had NO guard.)
      await assertPublicUrl(url);

      const response = await fetch(url, fetchOpts);

      if (!successCodes.has(response.status)) {
        const body = await response.text().catch(() => "(unreadable)");
        throw new Error(`HTTP ${response.status} from ${schema.http.url}: ${body.slice(0, 200)}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      let responseBody: unknown;
      if (contentType.includes("application/json")) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      // extract responseField if declared (EXT-03: safe dot-path only)
      let output: unknown = responseBody;
      if (schema.responseField && typeof responseBody === "object" && responseBody !== null) {
        output = getPath(responseBody as Record<string, unknown>, schema.responseField);
      }

      return { output, claimedCostCents: schema.estimateCents };
    },
  };
}

/** Collect all {{secret:name}} references from every string in the schema. */
function collectSecretRefs(schema: YamlCapabilitySchema): string[] {
  const refs = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === "string") extractSecretRefs(v).forEach((r) => refs.add(r));
    else if (Array.isArray(v)) v.forEach(scan);
    else if (v !== null && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(scan);
  };
  scan(schema.http);
  return [...refs];
}

// ── Top-level loader ──────────────────────────────────────────────────────────

/**
 * Parse, validate, and compile a YAML capability file in one call.
 * `resolveSecrets` is forwarded to the compiled plugin (called at invoke time).
 *
 * Usage:
 *   const result = loadYamlCapability(yamlText, (refs) => broker.resolveAll(refs));
 *   if (!result.ok) { ... show result.errors ... }
 *   supervisor.register(result.plugin);
 */
export function loadYamlCapability(
  yamlText: string,
  resolveSecrets: (refs: string[]) => Record<string, string>,
): LoadResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (e) {
    return { ok: false, errors: [{ field: "(parse)", message: `YAML parse error: ${(e as Error).message}` }] };
  }

  const errors = validateYamlCapability(parsed);
  if (errors.length > 0) return { ok: false, errors };

  const schema = parsed as YamlCapabilitySchema;
  const secretRefs = collectSecretRefs(schema);
  const plugin = compileYamlCapability(schema, resolveSecrets);

  return { ok: true, plugin, secretRefs };
}
