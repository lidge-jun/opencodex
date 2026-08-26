# 020 — Bundle Bun 1.4.0-canary.1

## Files

### MODIFY: package.json
```diff
-    "bun": "1.3.14",
+    "bun": "1.4.0-canary.1",
```
`@types/bun` stays at 1.3.14 (canary types may not exist).

### MODIFY: bun.lock
Regenerated via `bun install`.

## Verification
```bash
bun run typecheck
bun run test
```

