import { expect, test } from "bun:test";
import type { OcxTool } from "../src/types";
import { toolChoiceCandidates, toolChoiceToolPredicate } from "../src/types";

test("allowed_tools resolves an ambiguous bare name without replaying the candidate list", () => {
  const size = 256;
  const backingTools: OcxTool[] = Array.from({ length: size }, (_, index) => ({
    namespace: `namespace_${index}`,
    name: "shared_name",
    description: "",
    parameters: {},
  }));
  let catalogReads = 0;
  const tools = new Proxy(backingTools, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) catalogReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const arrayIterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
  let ambiguousCandidateIterations = 0;
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    ...arrayIterator,
    value: function (this: unknown[]) {
      const iterator = arrayIterator.value.call(this) as IterableIterator<unknown>;
      const tracksCandidateList = this !== backingTools
        && this !== tools
        && this.length === size
        && this[0] === backingTools[0]
        && this[size - 1] === backingTools[size - 1];
      return {
        next() {
          const result = iterator.next();
          if (tracksCandidateList && !result.done) ambiguousCandidateIterations += 1;
          return result;
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    },
  });

  let filtered: OcxTool[];
  try {
    const allowed = toolChoiceToolPredicate(
      { allowedTools: ["shared_name"], mode: "auto" },
      tools,
    );
    filtered = tools.filter(allowed);
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, arrayIterator);
  }

  expect(filtered).toEqual([]);
  expect(catalogReads).toBeLessThanOrEqual(size * 2);
  expect(ambiguousCandidateIterations).toBe(0);
});

test("public candidate lookups rebuild after a mutable caller changes its catalog", () => {
  const tools: OcxTool[] = [{ namespace: "first", name: "shared", description: "", parameters: {} }];
  const firstLookup = toolChoiceCandidates(tools, "shared");
  expect(firstLookup).toHaveLength(1);
  expect(firstLookup[0]).toBe(tools[0]);

  tools.push({ namespace: "second", name: "shared", description: "", parameters: {} });

  const secondLookup = toolChoiceCandidates(tools, "shared");
  expect(secondLookup).toHaveLength(2);
  expect(secondLookup[0]).toBe(tools[0]);
  expect(secondLookup[1]).toBe(tools[1]);
  const allowed = toolChoiceToolPredicate({ allowedTools: ["shared"], mode: "auto" }, tools);
  expect(tools.filter(allowed)).toEqual([]);
});

test("a compiled resolver fails closed when its catalog objects change", () => {
  const tools: OcxTool[] = [{ namespace: "stable", name: "shared", description: "", parameters: {} }];
  const allowed = toolChoiceToolPredicate({ allowedTools: ["shared"], mode: "auto" }, tools);

  tools[0].name = "changed_after_compile";
  tools.push({ namespace: "late", name: "shared", description: "", parameters: {} });

  expect(tools.filter(allowed)).toEqual([]);
});
