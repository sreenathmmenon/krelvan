/**
 * YamlPluginLoader — PluginLoaderStrategy for kind='yaml'.
 *
 * Reads the source file at sourcePath, delegates to the existing YAML capability
 * loader (src/core/extensions/yaml-capability.ts), and returns a live CapabilityPlugin.
 * No dynamic import, no eval. Independently unit-testable with fixture YAML files.
 */

import { readFileSync } from "node:fs";
import { loadYamlCapability } from "../../core/extensions/yaml-capability.js";
import type { PluginLoaderStrategy } from "../../core/plugins/ports.js";
import type { CapabilityPlugin } from "../../core/capability/capability.js";
import type { PersistedPluginRecord } from "../../core/plugins/types.js";
import { assertIsCapabilityPlugin } from "../../core/plugins/types.js";

export class YamlPluginLoader implements PluginLoaderStrategy {
  readonly kind = "yaml" as const;

  async load(
    record: PersistedPluginRecord,
    resolveSecret: (ref: string) => string | undefined,
  ): Promise<CapabilityPlugin> {
    let yamlText: string;
    try {
      yamlText = readFileSync(record.sourcePath, "utf-8");
    } catch (cause) {
      throw new Error(`YamlPluginLoader: cannot read '${record.sourcePath}': ${String(cause)}`);
    }

    // Adapt: the YAML loader wants (refs: string[]) => Record<string, string>
    const resolveSecrets = (refs: string[]): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const ref of refs) {
        const val = resolveSecret(ref);
        if (val !== undefined) out[ref] = val;
      }
      return out;
    };

    const result = loadYamlCapability(yamlText, resolveSecrets);
    if (!result.ok) {
      throw new Error(
        `YamlPluginLoader: validation failed for '${record.sourcePath}':\n` +
          result.errors.map((e) => `  ${e.field}: ${e.message}`).join("\n"),
      );
    }

    const plugin = result.plugin;
    assertIsCapabilityPlugin(plugin, record.name);
    return plugin;
  }
}
