/**
 * Capability directory loader — auto-discovers capability files at startup.
 *
 * Supported file types in the capabilities/ directory:
 *   *.yaml / *.yml   → YAML HTTP capability (zero code needed)
 *   *.js             → TypeScript/JS capability module (compiled or tsx-run)
 *   mcp-servers.json → MCP server connection configs
 *
 * TypeScript (.ts) files: Krelvan cannot dynamically import raw .ts files without
 * tsx registered globally. Users should either compile to .js first, or run Krelvan
 * with `tsx` (which is the default: `tsx src/api/index.ts`). In tsx mode, .ts files
 * ARE importable — so we also accept .ts here when tsx is registered.
 *
 * Secrets are resolved from environment variables at invoke time.
 * A capability that declares name: MY_SECRET will read process.env.MY_SECRET.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { getLogger } from "../observability/logger.js";
import { loadYamlCapability } from "../extensions/yaml-capability.js";
import type { CapabilityPlugin } from "./capability.js";
import type { McpServerConfig } from "../mcp/mcp-client.js";
import { assertIsCapabilityPlugin } from "../plugins/types.js";

const log = getLogger("dir-loader");

export interface LoadedCapability {
  plugin: CapabilityPlugin;
  source: string;  // file path it was loaded from
  secretRefs: string[];
}

export interface DirectoryLoadResult {
  capabilities: LoadedCapability[];
  /** JS/TS modules that must be loaded asynchronously (returned for async loading) */
  jsModulePaths: string[];
  errors: Array<{ file: string; error: string }>;
  mcpConfigs: McpServerConfig[];
}

/**
 * Scan a directory synchronously for YAML capabilities and MCP configs.
 * JS/TS module paths are returned separately for async loading.
 *
 * `resolveSecret` is called at INVOKE time (lazily, per run) for each {{secret:NAME}}
 * reference, so a secret a customer sets after startup is picked up without a reload.
 * Defaults to reading process.env. Missing secrets do NOT prevent loading — they
 * fail at invoke time with a clear error.
 */
export function loadCapabilityDirectory(
  dir: string,
  resolveSecret: (name: string) => string | undefined = (name) => process.env[name],
): DirectoryLoadResult {
  const result: DirectoryLoadResult = { capabilities: [], jsModulePaths: [], errors: [], mcpConfigs: [] };

  if (!existsSync(dir)) {
    log.info({ dir }, "capabilities directory does not exist — skipping");
    return result;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    log.warn({ dir, err: (err as Error).message }, "cannot read capabilities directory");
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const ext = extname(entry).toLowerCase();

    if (entry === "mcp-servers.json") {
      try {
        const raw = readFileSync(fullPath, "utf8");
        const configs = JSON.parse(raw) as McpServerConfig[];
        if (!Array.isArray(configs)) {
          result.errors.push({ file: fullPath, error: "mcp-servers.json must be a JSON array" });
        } else {
          result.mcpConfigs.push(...configs);
          log.info({ count: configs.length, file: fullPath }, "loaded mcp server configs");
        }
      } catch (err) {
        result.errors.push({ file: fullPath, error: (err as Error).message });
      }
      continue;
    }

    // JS/TS modules — async, collected and loaded by loadJsCapabilities()
    if (ext === ".js" || ext === ".ts" || ext === ".mjs") {
      result.jsModulePaths.push(resolve(fullPath));
      continue;
    }

    if (ext !== ".yaml" && ext !== ".yml") continue;

    // YAML capabilities
    try {
      const yaml = readFileSync(fullPath, "utf8");

      const loaded = loadYamlCapability(yaml, (refs) => {
        const secrets: Record<string, string> = {};
        for (const ref of refs) {
          const val = resolveSecret(ref);
          if (val !== undefined) secrets[ref] = val;
        }
        return secrets;
      });

      if (!loaded.ok) {
        const errMsg = loaded.errors.map(e => `${e.field}: ${e.message}`).join("; ");
        result.errors.push({ file: fullPath, error: errMsg });
        log.warn({ file: fullPath, errors: loaded.errors }, "capability validation failed");
        continue;
      }

      result.capabilities.push({
        plugin: loaded.plugin,
        source: fullPath,
        secretRefs: loaded.secretRefs,
      });

      log.info({ name: loaded.plugin.name, file: fullPath, secretRefs: loaded.secretRefs }, "loaded yaml capability");
    } catch (err) {
      result.errors.push({ file: fullPath, error: (err as Error).message });
      log.warn({ file: fullPath, err: (err as Error).message }, "failed to load capability file");
    }
  }

  // A capability shipped as compiled JS keeps its .ts SOURCE beside it in the archive
  // (e.g. text-transform.js + text-transform.ts). At runtime under plain Node (the
  // customer path — no tsx registered) importing the .ts throws "Unknown file extension
  // '.ts'", logging a load failure for a file that is just the source of the .js we already
  // have. When a runnable sibling (.js/.mjs/.cjs) exists for the same basename+dir, drop the
  // .ts so it is never import()ed. In tsx dev mode only the .ts exists, so nothing is dropped.
  result.jsModulePaths = dedupeModulePaths(result.jsModulePaths);

  return result;
}

/**
 * Collapse a list of module paths so that when both a runnable JS variant and its .ts
 * source share the same directory+basename, only the runnable one is kept. Order-preserving.
 */
function dedupeModulePaths(paths: string[]): string[] {
  const runnable = new Set(
    paths
      .filter(p => /\.(js|mjs|cjs)$/i.test(p))
      .map(p => p.replace(/\.(js|mjs|cjs)$/i, "")),
  );
  return paths.filter(p => {
    if (!/\.ts$/i.test(p)) return true;
    return !runnable.has(p.replace(/\.ts$/i, ""));
  });
}

/**
 * Async: import JS/TS capability modules discovered by loadCapabilityDirectory().
 *
 * Each module must export a default that satisfies CapabilityPlugin:
 *   export default {
 *     name: "my-capability",
 *     sideEffect: "read",
 *     estimateCents: () => 5,
 *     async invoke(call) { ... }
 *   }
 *
 * Secrets are resolved from process.env — the module receives them via call.input
 * or can read process.env directly (since it runs in a worker thread in production,
 * but in dev/tsx mode it runs in-process).
 */
// The JS/TS capabilities Krelvan ships with (first-party, safe to import in-process).
// Anything else is treated as untrusted (see loadJsCapabilities).
const BUNDLED_JS_CAPABILITIES = new Set(["text-transform"]);

function isBundledCapability(modulePath: string): boolean {
  const base = modulePath.split("/").pop()?.replace(/\.(js|ts|mjs|cjs)$/, "") ?? "";
  return BUNDLED_JS_CAPABILITIES.has(base);
}

export async function loadJsCapabilities(
  modulePaths: string[],
): Promise<{ loaded: LoadedCapability[]; errors: Array<{ file: string; error: string }> }> {
  const loaded: LoadedCapability[] = [];
  const errors: Array<{ file: string; error: string }> = [];

  // SECURITY: these JS/TS files are imported IN-PROCESS with full host privileges —
  // this is arbitrary code execution. We only auto-load files Krelvan SHIPS with
  // (bundled first-party capabilities). Any other .js/.ts dropped into the
  // capabilities dir is untrusted and is skipped unless the operator explicitly
  // opts in via KRELVAN_ALLOW_UNTRUSTED_PLUGINS=1.
  const allowUntrusted = process.env["KRELVAN_ALLOW_UNTRUSTED_PLUGINS"] === "1";

  for (const modulePath of modulePaths) {
    if (!allowUntrusted && !isBundledCapability(modulePath)) {
      errors.push({ file: modulePath, error: "untrusted JS/TS capability skipped — runs in-process with full host access. Set KRELVAN_ALLOW_UNTRUSTED_PLUGINS=1 to allow (only for code you trust)." });
      log.warn({ file: modulePath }, "skipped untrusted in-process JS/TS capability (set KRELVAN_ALLOW_UNTRUSTED_PLUGINS=1 to allow)");
      continue;
    }
    try {
      const mod = await import(modulePath) as Record<string, unknown>;
      const candidate = mod["default"] ?? Object.values(mod)[0];

      assertIsCapabilityPlugin(candidate, modulePath);

      loaded.push({
        plugin: candidate,
        source: modulePath,
        secretRefs: [],
      });

      log.info({ name: candidate.name, file: modulePath }, "loaded js/ts capability");
    } catch (err) {
      errors.push({ file: modulePath, error: (err as Error).message });
      log.warn({ file: modulePath, err: (err as Error).message }, "failed to load js capability");
    }
  }

  return { loaded, errors };
}
