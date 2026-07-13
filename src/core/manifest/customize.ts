/**
 * applyCustomize — the "make it mine" bake step.
 *
 * A builder clones a template for their customer: picks a name, points it at their
 * knowledge base, sets the tone, flips toggles. This function takes the template
 * manifest + those settings and returns a FRESH, self-contained manifest with the
 * settings baked in — which then installs/signs like any other agent. Nothing is
 * layered or computed at runtime: what you see in the cloned manifest is what runs
 * (each customer's agent is its own independent, signed artifact).
 *
 * Guards:
 *  - Deny-by-default: a setting key not declared in manifest.customize is an ERROR,
 *    not a silent ignore — a builder must never think they changed something they didn't.
 *  - Type-checked per field (text -> string, choice -> one of options, toggle -> boolean).
 *  - Pure function, no I/O; the input manifest is never mutated.
 *  - The result is re-validated with validateManifest before being returned.
 */

import {
  validateManifest,
  fatalIssues,
  type CustomizeField,
  type Manifest,
} from "./manifest.js";

export type CustomizeSettings = Record<string, string | number | boolean>;

export type CustomizeResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; error: string };

/** Bake builder settings into a fresh manifest (see module doc). */
export function applyCustomize(template: Manifest, settings: CustomizeSettings): CustomizeResult {
  const declared = template.customize ?? {};

  // Deny-by-default: reject any setting the template did not declare as customizable.
  for (const key of Object.keys(settings)) {
    if (!(key in declared)) {
      return { ok: false, error: `'${key}' is not a customizable setting of this template` };
    }
  }

  // Deep-clone via JSON — manifests are plain JSON by construction (they are stored,
  // signed, and shipped as JSON), so this is a faithful copy with no shared references.
  const m = JSON.parse(JSON.stringify(template)) as Manifest;
  // The clone is a new, independent agent: it does not re-expose the template's
  // customize surface (re-customizing = clone the template again), and it must not
  // inherit a schedule silently — the builder arms schedules deliberately.
  delete m.customize;

  for (const [key, field] of Object.entries(declared)) {
    if (!(key in settings)) continue; // omitted setting -> template's own value stands
    const value = settings[key]!;

    const typed = checkType(key, field, value);
    if (typed !== null) return { ok: false, error: typed };

    if (field.rename) {
      const name = String(value).trim();
      if (!name) return { ok: false, error: `'${key}': the agent name cannot be empty` };
      m.name = name;
    } else if (field.seedKey) {
      m.seed = { ...(m.seed ?? {}), [field.seedKey]: value as string | number | boolean };
    } else if (field.autonomy) {
      const node = m.nodes.find((n) => n.id === field.autonomy!.nodeId);
      if (!node) return { ok: false, error: `'${key}': node '${field.autonomy.nodeId}' not found` };
      node.autonomy = value === true ? field.autonomy.on : field.autonomy.off;
    }
  }

  const issues = fatalIssues(validateManifest(m));
  if (issues.length > 0) {
    return { ok: false, error: `customized manifest is invalid: ${issues.map((i) => i.message).join("; ")}` };
  }
  return { ok: true, manifest: m };
}

/** Validate a single setting value against its declared field type. Returns an error string or null. */
function checkType(key: string, field: CustomizeField, value: string | number | boolean): string | null {
  switch (field.type) {
    case "text":
      if (typeof value !== "string") return `'${key}' must be a string`;
      return null;
    case "choice":
      if (typeof value !== "string") return `'${key}' must be a string`;
      if (!field.options?.includes(value)) {
        return `'${key}' must be one of: ${(field.options ?? []).join(", ")}`;
      }
      return null;
    case "toggle":
      if (typeof value !== "boolean") return `'${key}' must be true or false`;
      return null;
    default:
      return `'${key}' has an unknown field type`;
  }
}
