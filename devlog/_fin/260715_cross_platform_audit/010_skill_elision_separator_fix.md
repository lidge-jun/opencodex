# 010 — Skill-elision basename fix for Windows separators (D1, wp1)

Fixes the user-reported bug: blocked-skill document elision silently fails on Windows
because `maybeElideSkillText` basenames the skill directory with a POSIX-only split.

## Change map

| File | Op | What |
|------|----|------|
| `src/claude/inbound.ts` | MODIFY | normalize `\` → `/` before basename split (1 line) |
| `tests/claude-inbound.test.ts` | MODIFY | parameterize text-block carrier base dir; +4 cases |

## Diff — `src/claude/inbound.ts` (line 183, inside `maybeElideSkillText`)

```diff
-  const base = dir.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
+  // Windows clients send `C:\Users\...\claude-api`; normalize separators before
+  // basenaming (repo precedent: src/codex/inject.ts isOpencodexCatalogPath).
+  const base = dir.replace(/\\/g, "/").split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
```

Behavior table (input first line `Base directory for this skill: <dir>`):

| `<dir>` | base | blocked `claude-api`? |
|---------|------|----------------------|
| `/private/tmp/.../claude-api` | `claude-api` | elided (unchanged) |
| `C:\Users\u\AppData\...\claude-api` | `claude-api` | elided (FIXED) |
| `C:\Users\u\mixed/path\claude-api` | `claude-api` | elided (FIXED) |
| `\\server\share\skills\claude-api` (UNC) | `claude-api` | elided (FIXED) |
| `C:claude-api` (drive-relative, out of client contract) | `c:claude-api` | pass-through (pinned) |

## Diff — `tests/claude-inbound.test.ts`

Generalize the existing carrier builder (currently hardcodes a POSIX base dir):

```diff
-  function requestWithSkillTextBlock(skillDirName: string, textLen: number, cc?: { blockedSkills?: string[] }) {
-    const bundle = `Base directory for this skill: /private/tmp/claude-501/bundled-skills/2.1.207/abc/${skillDirName}\n\n` + "DOCS ".repeat(Math.ceil(textLen / 5));
+  function requestWithSkillTextBlock(skillDirName: string, textLen: number, cc?: { blockedSkills?: string[] }, baseDir?: string) {
+    const dir = baseDir ?? `/private/tmp/claude-501/bundled-skills/2.1.207/abc/${skillDirName}`;
+    const bundle = `Base directory for this skill: ${dir}\n\n` + "DOCS ".repeat(Math.ceil(textLen / 5));
```

New tests (same describe block, after the existing carrier tests):

```ts
test("text-block carrier: Windows backslash base dir is elided (live incident 2026-07-15)", () => {
  const texts = userTexts(requestWithSkillTextBlock("claude-api", 500_000, undefined,
    "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\bundled-skills\\claude-api"));
  expect(texts.some(t => t.includes("elided") && t.includes("claude-api"))).toBe(true);
  expect(texts.every(t => t.length < 10_000)).toBe(true);
});

test("text-block carrier: mixed separators and UNC paths are elided", () => {
  const mixed = userTexts(requestWithSkillTextBlock("claude-api", 500_000, undefined,
    "C:\\Users\\u\\skills/2.1.207\\claude-api"));
  expect(mixed.some(t => t.includes("elided"))).toBe(true);
  const unc = userTexts(requestWithSkillTextBlock("claude-api", 500_000, undefined,
    "\\\\server\\share\\skills\\claude-api"));
  expect(unc.some(t => t.includes("elided"))).toBe(true);
});

test("text-block carrier: drive-relative dir (no separator) stays pass-through", () => {
  const texts = userTexts(requestWithSkillTextBlock("claude-api", 500_000, undefined, "C:claude-api"));
  expect(texts.some(t => t.length > 400_000)).toBe(true);
});
```

## Accept criteria

- New Windows/mixed/UNC cases elide; drive-relative pins pass-through; all pre-existing
  elision tests unchanged and green. Activation scenario: the Windows-path fixture IS the
  trigger (C-ACTIVATION-GROUNDING-01).
- Verifier: `bun test --isolate ./tests/claude-inbound.test.ts` then full gates at C.

## Out of scope

- The tool_result carrier path (`blockedSkillCallIds`) — skill-name based, no paths.
- Native Anthropic passthrough (intentionally never elides).
