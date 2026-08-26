# 050 — Enable eager relay for qualified canary revisions

## Files

### MODIFY: src/lib/bun-stream-caps.ts
```diff
+const VERIFIED_CANARY_REVISIONS = new Set<string>([
+  // Populated after CI qualification passes with a specific canary build
+]);
+
 export function bunHasAsyncPullCancelFix(
   version: string,
+  revision: string = Bun.revision,
   minFixed: string | null = MIN_FIXED_BUN_VERSION,
 ): boolean {
+  if (
+    version === "1.4.0-canary.1"
+    && VERIFIED_CANARY_REVISIONS.has(revision)
+  ) {
+    return true;
+  }
   if (!minFixed) return false;
   if (hasPrereleaseSuffix(version)) return false;
```

### MODIFY: tests/bun-stream-caps.test.ts
- Add test for revision-based canary qualification
- Test unverified revision still returns false

