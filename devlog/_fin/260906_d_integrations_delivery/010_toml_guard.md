# 010 — TOML rewrite admission

Depends on: roadmap lock. Class C2/C3 parser-admission preservation. Owner: main; bounded implementation reviewer during B, no future-phase code writes.

Source: PR #3669, commit f6db9cae8e8854c6df06087288a074d767f9787d, Hako <25837994+devswha@users.noreply.github.com>. Preserve this author via cherry-pick and add Co-authored-by on carry PR. Existing review has no unresolved threads; reported local results are not our current-head CI proof.

## File change map

MODIFY src/integrations/config-io.ts: replace direct Bun.TOML.parse return with iterative document walk. Reject non-array objects with prototypes other than Object.prototype or null before JSON cloning can coerce typed date/time scalars to strings. Scalars/quoted dates/plain objects/arrays remain accepted.
MODIFY tests/clients/integrations-state.test.ts: exercise all supported TOML temporal kinds at root, nested tables and inline arrays; quoted equivalents stay accepted.
MODIFY tests/clients/integrations-writer.test.ts: real temp Kimi config produces unsafe state; apply refuses without changing original bytes, operation journal or ownership records.
MODIFY docs-site/src/content/docs/{guides,fr/guides,tr/guides,zh-tw/guides}/integrations.md: carry the source commit descriptions of refused date/time rewrites.
MODIFY structure/09_client-integrations.md: add typed TOML temporal values to the existing round-trip refusal contract after the classifier paragraph.
No new fields, enums, serializers, dependencies, runtime options or management endpoints. The parser is the existing common admission point for status and writers. Bypass is explicit manual editing outside managed rewrite; this guard does not control that user action.

## Exact source patch

```diff
diff --git a/src/integrations/config-io.ts b/src/integrations/config-io.ts
index 4f2a83482..9cb5f97ba 100644
--- a/src/integrations/config-io.ts
+++ b/src/integrations/config-io.ts
@@ -162,7 +162,22 @@ export function parseConfig(text: string | null, format: ConfigFormat): unknown
          * evidence is gone.
          */
         if (/(^|[\s,[=])[-+]?(?:inf|nan)(?=[\s,\]]|$)/mi.test(text)) return PARSE_FAILED;
-        return Bun.TOML.parse(text);
+        const document = Bun.TOML.parse(text);
+        // TOML date/time scalars are Temporal objects with toJSON methods.
+        // The merge layer JSON-clones documents, which silently turns these
+        // into strings. Refuse before either status or a writer can admit a
+        // lossy rewrite, including dates nested in arrays and inline tables.
+        const pending: unknown[] = [document];
+        while (pending.length > 0) {
+          const value = pending.pop();
+          if (value === null || typeof value !== "object") continue;
+          if (!Array.isArray(value)) {
+            const prototype = Object.getPrototypeOf(value);
+            if (prototype !== Object.prototype && prototype !== null) return PARSE_FAILED;
+          }
+          for (const child of Object.values(value)) pending.push(child);
+        }
+        return document;
       }
     }
   } catch {
diff --git a/tests/clients/integrations-state.test.ts b/tests/clients/integrations-state.test.ts
index 54ab80de1..872e9b382 100644
--- a/tests/clients/integrations-state.test.ts
+++ b/tests/clients/integrations-state.test.ts
@@ -401,6 +401,25 @@ describe("classifier unit behavior", () => {
     expect(parseConfig("{{{", "json")).toBe(PARSE_FAILED);
   });

+  test("parseConfig refuses typed TOML dates before a JSON clone can turn them into strings", () => {
+    for (const literal of [
+      "2026-09-05T10:00:00Z",
+      "2026-09-05T10:00:00-07:00",
+      "2026-09-05T10:00:00.123456",
+      "2026-09-05",
+      "10:00:00.123456",
+    ]) {
+      for (const text of [
+        `expires = ${literal}\n`,
+        `[user]\nexpires = ${literal}\n`,
+        `items = [{ expires = ${literal} }]\n`,
+      ]) {
+        expect(parseConfig(text, "toml")).toBe(PARSE_FAILED);
+      }
+      expect(parseConfig(`expires = "${literal}"\n`, "toml")).toEqual({ expires: literal });
+    }
+  });
+
   test("parseConfig refuses json number literals a rewrite would change", () => {
     // Overflow to Infinity — a rewrite would bake in null.
     expect(parseConfig("{\"a\": 1e999}", "json")).toBe(PARSE_FAILED);
diff --git a/tests/clients/integrations-writer.test.ts b/tests/clients/integrations-writer.test.ts
index 0bf81fdb5..de2f16471 100644
--- a/tests/clients/integrations-writer.test.ts
+++ b/tests/clients/integrations-writer.test.ts
@@ -141,6 +141,24 @@ function reverseJsonObjectKeys(value: unknown): unknown {
 }

 describe("apply", () => {
+  test("refuses Kimi TOML date rewrites without changing the file or ownership store", () => {
+    const spec = INTEGRATION_CLIENTS.kimi;
+    mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
+    const configPath = spec.configPath(TEST_ENV, home);
+    mkdirSync(dirname(configPath), { recursive: true });
+    const original = "[user]\nexpires = 2026-09-05T10:00:00Z\n";
+    writeFileSync(configPath, original);
+    const request = input({ clientId: "kimi" });
+
+    expect(readIntegrationState(request).state).toBe("unsafe");
+    const result = applyIntegration(request);
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("unsafe");
+    expect(readFileSync(configPath, "utf8")).toBe(original);
+    expect(store.listOperations()).toHaveLength(0);
+    expect(store.readRecords().kimi).toBeUndefined();
+  });
+
   test("refuses a client that is not installed, and writes nothing", () => {
     const result = applyIntegration(input());
     expect(result.ok).toBe(false);
```

## Additional structure diff

After “Status and mutation must use the same classifier” paragraph add:

> TOML temporal scalars cannot survive the JSON-cloned merge representation with their types intact. The common parser refuses documents containing them before either status or mutation proceeds, including nested arrays and inline tables. Quoted date strings remain supported.

## Acceptance and activation

- Unquoted offset/local date-time, local date, local time at every tested nesting returns PARSE_FAILED.
- Identical quoted values remain plain strings and can be managed.
- Kimi apply on typed temporal input activates unsafe classification and writes nothing, including bookkeeping.
- Existing special-float admission and other formats are unchanged.
- C consumes hosted current-head CI actual gates/platform jobs; no local suites/typecheck. Original focused paths named above are included in the CI repository tests.
- Independently review prototype traversal and actual parser shapes; unexpected compatibility gaps change the plan before implementation.
- Once integrated, refresh dev ancestry and close source #3669 immediately with attributed carry PR evidence.
