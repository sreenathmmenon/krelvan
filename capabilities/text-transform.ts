/**
 * text.transform — A pure TypeScript capability plugin.
 *
 * Demonstrates how to implement CapabilityPlugin in TypeScript.
 * No secrets required, no network calls — pure text manipulation.
 * Cost: zero (compute only).
 */

import type { CapabilityPlugin, EffectCall } from "../src/core/capability/capability.js";

type TransformOp = "uppercase" | "lowercase" | "trim" | "reverse" | "word-count";

export const TextTransformPlugin: CapabilityPlugin = {
  name: "text.transform",
  sideEffect: "read",

  estimateCents(_call: EffectCall): number {
    return 0;
  },

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    const input = call.input as { text: string; operation: TransformOp };

    if (typeof input.text !== "string") {
      throw new Error("text.transform: 'text' must be a string");
    }

    let result: string | number;
    switch (input.operation) {
      case "uppercase":
        result = input.text.toUpperCase();
        break;
      case "lowercase":
        result = input.text.toLowerCase();
        break;
      case "trim":
        result = input.text.trim();
        break;
      case "reverse":
        result = input.text.split("").reverse().join("");
        break;
      case "word-count":
        result = input.text.trim().split(/\s+/).filter(Boolean).length;
        break;
      default:
        throw new Error(`text.transform: unknown operation '${String(input.operation)}'`);
    }

    return { output: { result }, claimedCostCents: 0 };
  },
};

export default TextTransformPlugin;
