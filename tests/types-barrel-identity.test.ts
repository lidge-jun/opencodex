import { describe, expect, test } from "bun:test";
import * as barrel from "../src/types";
import * as tools from "../src/types/tools";
import * as wire from "../src/types/wire";

/**
 * The mega-file split turned `src/types.ts` into a re-export barrel. Its correctness
 * argument was "tsc plus the ~400 files that import through it", which is true for
 * TYPES — they are erased, so a wrong one fails compilation.
 *
 * It is not true for the runtime values. A barrel that copied an implementation, wrapped
 * one, or re-declared a `Set` would typecheck cleanly and pass every existing suite,
 * because no test imported a leaf directly — every import went through the barrel, so
 * barrel and leaf were never compared to each other.
 *
 * A forked `MODEL_ADAPTER_OVERRIDE_ALLOWED` is the concrete hazard: two `Set` instances
 * where the code assumes one, diverging the moment anything mutates or identity-checks it.
 * The original split risk assessment named singleton forking as a MEDIUM program risk and
 * relied on review greps to catch it. This is that check, mechanised.
 *
 * Reference identity is the right assertion: an ESM re-export binds the same object, so
 * `toBe` passes for a genuine re-export and fails for a copy, a wrapper, or a re-declaration.
 */
describe("types barrel re-exports the leaves by identity, not by copy", () => {
  test.each([
    "namespacedToolName",
    "toolChoiceAliases",
    "toolChoiceCandidates",
    "toolAllowedByChoice",
    "resolveToolChoiceWireName",
    "modelInList",
    "isAllowedToolChoice",
    "toolChoiceToolPredicate",
  ] as const)("types/tools %s is the same binding", name => {
    expect(barrel[name]).toBe(tools[name]);
  });

  test.each([
    "UPSTREAM_HTTP_VERSION_VALUES",
    "REASONING_SUMMARY_DELIVERY_VALUES",
    "OPENAI_PROVIDER_TIER_VERSION",
    "MODEL_ADAPTER_OVERRIDE_ALLOWED",
    "captureWireAdapterHardPins",
    "isWirePinnedModel",
    "pinnedWireAdapter",
  ] as const)("types/wire %s is the same binding", name => {
    expect(barrel[name]).toBe(wire[name]);
  });

  test("the wire allowlist is one Set, not two", () => {
    // Called out explicitly because it is the only mutable-shaped value in the moved set,
    // and a fork here is invisible to every other assertion in the repository.
    expect(barrel.MODEL_ADAPTER_OVERRIDE_ALLOWED).toBe(wire.MODEL_ADAPTER_OVERRIDE_ALLOWED);
    expect([...barrel.MODEL_ADAPTER_OVERRIDE_ALLOWED]).toEqual([...wire.MODEL_ADAPTER_OVERRIDE_ALLOWED]);
  });

  test("every runtime value the leaves export is reachable from the barrel", () => {
    // Guards the other direction: a leaf can grow a new export that the barrel forgets to
    // re-export, which no consumer notices until one tries to import it from the barrel.
    for (const [leafName, leaf] of [["tools", tools], ["wire", wire]] as const) {
      for (const [name, value] of Object.entries(leaf)) {
        if (typeof value !== "function" && typeof value !== "object" && typeof value !== "number") continue;
        expect({ leaf: leafName, name, present: name in barrel }).toEqual({ leaf: leafName, name, present: true });
      }
    }
  });
});
