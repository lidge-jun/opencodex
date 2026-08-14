---
title: "M0-5: Non-JSON depth cap"
phase: "050"
depends: []
consumes: []
branch: codex/m0-5-nonjson-depth-cap
closes: "#1635 (partial — YAML/TOML depth)"
---

# 050 — M0-5: YAML and TOML nesting depth ceiling

## Thesis

JSON configs already have `MAX_JSON_NESTING = 1000` enforced in both parse-time
scanning (`config-io.ts:81`) and serialize-time walk (`serialize.ts:291`). YAML
and TOML configs have no equivalent — a 15,000-level YAML object causes a stack
overflow or ~1.1 GiB RSS spike during `Bun.YAML.parse` or recursive serialization.

## Current state

- `src/integrations/serialize.ts:231`: `MAX_JSON_NESTING = 1000` — JSON only
- `src/integrations/config-io.ts:81`: JSON parse-time depth check against MAX_JSON_NESTING
- `src/integrations/serialize.ts:57-130`: YAML writer is recursive (`yamlMapEntryLines`,
  `yamlLines`) with no depth limit
- YAML/TOML parsing uses `Bun.YAML.parse` / TOML npm package — no pre-parse depth scan
- The YAML writer would overflow the stack on deep structures before any other limit catches it
- JSON5 parsing goes through the same config-io path and already has the depth scan

## File change map

### MODIFY: src/integrations/serialize.ts

Export a shared constant and add depth tracking to YAML writer:

```diff
- export const MAX_JSON_NESTING = 1000;
+ /** Shared ceiling for container nesting across all config formats. */
+ export const MAX_CONFIG_NESTING = 1000;
+ /** @deprecated Use MAX_CONFIG_NESTING */
+ export const MAX_JSON_NESTING = MAX_CONFIG_NESTING;
```

Add depth parameter to YAML recursive functions:

```diff
- function yamlMapEntryLines(key: string, value: unknown, indent: number): string[] {
+ function yamlMapEntryLines(key: string, value: unknown, indent: number, depth = 0): string[] {
+   if (depth >= MAX_CONFIG_NESTING) {
+     throw new UnserializableValueError(
+       \`the document nests deeper than ${MAX_CONFIG_NESTING} levels, which YAML serialization cannot handle safely\`);
+   }
```

Same for `yamlLines`, `yamlArrayMapLines`, and `tomlSection` functions.

### MODIFY: src/integrations/config-io.ts

Update the import and generalize the depth check:

```diff
- import { MAX_JSON_NESTING } from "./serialize";
+ import { MAX_CONFIG_NESTING } from "./serialize";
```

Add a format-agnostic pre-parse depth scan for YAML/TOML text:

```diff
+ /**
+  * Quick indentation-based depth estimate for YAML text. Counts the deepest
+  * indentation run (each 2 spaces = 1 level). Not exact but catches hostile
+  * documents before Bun.YAML.parse can stack-overflow.
+  */
+ function estimateYamlDepth(text: string): number;
+
+ /**
+  * Bracket-counting depth estimate for TOML text. Counts nested table headers
+  * and inline tables.
+  */
+ function estimateTomlDepth(text: string): number;
```

Apply before parsing:

```diff
+ if (format === "yaml") {
+   const est = estimateYamlDepth(text);
+   if (est > MAX_CONFIG_NESTING) return false;
+ }
+ if (format === "toml") {
+   const est = estimateTomlDepth(text);
+   if (est > MAX_CONFIG_NESTING) return false;
+ }
```

### NEW: tests/nonjson-depth.test.ts

Test cases:
1. 15,000-level YAML nested object → bounded error, not stack overflow
2. 15,000-level TOML nested table → bounded error
3. Normal YAML config (5 levels) → parses successfully
4. Normal TOML config (3 levels) → parses successfully
5. Exactly at MAX_CONFIG_NESTING → accepted
6. One level over → rejected
7. Existing JSON depth cap unchanged (regression)
8. Existing config round-trip preserved

## Activation scenario

A user places a malicious `config.yaml` with 15,000 nested levels. The pre-parse
depth estimator catches it before `Bun.YAML.parse` and returns a clean error:
"the document nests deeper than 1000 levels." No stack overflow, no RSS spike.

## Scope boundary

IN: Shared depth constant, YAML/TOML depth estimation, serialize depth tracking, tests
OUT: Changing MAX_JSON_NESTING value, JSON5 changes (already covered),
     big-integer rounding fix (separate #1635 scope item)
