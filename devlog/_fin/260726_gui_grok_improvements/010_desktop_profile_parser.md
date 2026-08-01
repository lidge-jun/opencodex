# 010 — WP1: the Desktop profile parser rejects fields we ourselves write

Severity: highest of the five. This is not cosmetic — it hard-fails the Desktop
tab for any user who has applied a profile once, which is exactly what the
screenshot shows.

## The contradiction

Three places disagree about the shape of a stored profile:

| Location | Behaviour |
|----------|-----------|
| `src/types.ts:437-445` | `OcxClaudeDesktopProfile` DECLARES `appliedFingerprint?` and `appliedAt?` |
| `src/server/management/agent-settings-routes.ts:84`, `:450` | WRITES both into `config.claudeCode.desktopProfile` after a successful apply |
| `src/claude/desktop-profile.ts:79` | REJECTS both: `assertExactKeys(value, ["version", "assignments", "defaults"], "profile")` |

Sequence that produces the screenshot:

1. User assigns models and presses apply. The route writes the profile back with
   `appliedFingerprint` and `appliedAt` so the GUI can show applied-vs-saved state.
2. Next load, `buildClaudeDesktopState` reconciles the stored profile and any PUT
   round-trips it through `parseDesktopProfile`.
3. `assertExactKeys` throws `unknown field "appliedFingerprint"`, the route
   answers 400, and the page renders the red error with a retry button that can
   never succeed — the bad state is on disk.

There is a second, quieter half of the same bug: even if the keys were allowed,
`parseDesktopProfile` ends at `src/claude/desktop-profile.ts:118` with
`return { version: 1, assignments, defaults }`, dropping both fields. A PUT would
therefore silently erase the applied-state markers and the GUI would forget what
it had applied. Fixing only the allowlist would trade a loud failure for a silent
one.

## MODIFY map

### `src/claude/desktop-profile.ts`

Accept the two optional fields:

```ts
-  assertExactKeys(value, ["version", "assignments", "defaults"], "profile");
+  assertExactKeys(value, ["version", "assignments", "defaults", "appliedFingerprint", "appliedAt"], "profile");
```

Validate their types (they are persisted state, so a garbage value must not flow
onward), inserted after the `defaults` object check:

```ts
+  if (value.appliedFingerprint !== undefined && typeof value.appliedFingerprint !== "string") {
+    throw new DesktopProfileError("must be a string", "profile.appliedFingerprint");
+  }
+  if (value.appliedAt !== undefined && typeof value.appliedAt !== "string") {
+    throw new DesktopProfileError("must be a string", "profile.appliedAt");
+  }
```

Preserve them through the return so a round-trip does not erase applied state:

```ts
-  return { version: 1, assignments, defaults };
+  return {
+    version: 1,
+    assignments,
+    defaults,
+    ...(typeof value.appliedFingerprint === "string" ? { appliedFingerprint: value.appliedFingerprint } : {}),
+    ...(typeof value.appliedAt === "string" ? { appliedAt: value.appliedAt } : {}),
+  };
```

### P-phase amendment: `reconcileDesktopProfile` drops them too

Found while re-verifying this doc against the tree. `desktop-profile.ts:164` ends
with:

```ts
return parseDesktopProfile({ version: 1, assignments, defaults });
```

It rebuilds the object from scratch, so even a parser that preserves the fields
would lose them here — and `agent-settings-routes.ts:417` persists exactly this
return value on every PUT:

```ts
config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: reconcileDesktopProfile(state.profile, state.models) };
```

So saving any assignment change would silently reset the applied-state markers and
the GUI would report "not applied" for a config that is applied on disk. Carry the
fields through:

```ts
-  return parseDesktopProfile({ version: 1, assignments, defaults });
+  return parseDesktopProfile({
+    version: 1,
+    assignments,
+    defaults,
+    ...(profile.appliedFingerprint !== undefined ? { appliedFingerprint: profile.appliedFingerprint } : {}),
+    ...(profile.appliedAt !== undefined ? { appliedAt: profile.appliedAt } : {}),
+  });
```

`profile` is the already-parsed stored value at line 147, so this preserves what
the user had rather than inventing a value.

Deliberately NOT changed: the write sites. The routes are correct — the applied
fingerprint genuinely belongs on the profile, which is why `types.ts` declares it.
The parser is the side that is wrong.

## TESTS

`tests/claude-desktop-profile.test.ts` (existing file if present, else the
management test): a profile carrying both fields parses, the values survive the
round-trip, and a non-string value for either is rejected with the field named.

Mutation check: revert the allowlist entry and confirm the new case fails.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/claude-desktop-profile.test.ts tests/claude-management-api.test.ts` | pass |
| `bun run typecheck` | exit 0 |
