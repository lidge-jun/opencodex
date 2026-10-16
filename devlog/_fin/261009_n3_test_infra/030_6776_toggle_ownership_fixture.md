# 030 — #6776: native Codex toggle fixture owns its service-manager evidence

## Defect

`tests/codex-integration/native-codex-toggle.test.ts` writes a matching v2
`service-state.json` into its synthetic `OPENCODEX_HOME`, then enables Codex
through the management route. Enable runs production admission, which calls
`inspectServiceManagerInstallation` (`src/integrations/native/ownership-preflight.ts`).
That probe asks the real service manager: `launchctl print gui/<uid>/…` on macOS
and `systemctl --user show opencodex-proxy` on Linux, neither of which HOME can
redirect. On a machine with an installed opencodex service the probe returns a
registration that the sandbox plist cannot explain, admission returns
`service-home`, and the round-trip case reads `state: "absent"`.

Reproduced on `730d898457` by simulating a registered launchd job: 12 pass / 1 fail
with the reported refusal. Hosted runners have no registration, so CI passes.

The production ownership boundary is correct and unchanged.

## Change — MODIFY `tests/codex-integration/native-codex-toggle.test.ts` only

```diff
-import { afterEach, beforeEach, describe, expect, test } from "bun:test";
+import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
+import * as serviceManagerProbe from "../../src/service-manager-probe";
+let restoreServiceManagerProbe = () => {};

 beforeEach(() => {
+  // The route fixture owns no service, and HOME cannot redirect launchctl/systemctl.
+  // Without this the host's own opencodex registration decides the case.
+  const probe = spyOn(serviceManagerProbe, "inspectServiceManagerInstallation")
+    .mockReturnValue({ kind: "absent" });
+  restoreServiceManagerProbe = () => probe.mockRestore();

 afterEach(() => {
+  restoreServiceManagerProbe();
```

The fixture's `service-state.json` is still validated by the real state reader, so
the case keeps exercising the state comparison.

## Regression

The existing round-trip case is the regression. Its host dependence is proven by
the scratch reproduction (simulated registered manager: fails on dev, passes with
the spy). A case asserting `inspectServiceManagerInstallation` is called during
enable confirms the stub is on the admission path rather than dead code.

## Verify

```sh
FH=$(mktemp -d); env HOME="$FH" USERPROFILE="$FH" CLAUDE_CONFIG_DIR="$FH/.claude" \
  bun test tests/codex-integration/native-codex-toggle.test.ts
```


## Implementation record

Implemented as written in PR #6834 (branch `codex/n3-codex-toggle-fixture`, commit `c6addbb97e`),
test-only. With a simulated registered service manager the round-trip case fails on dev (12 pass /
1 fail, `service-home` refusal, `state: "absent"`) and passes with the stub (14/14). The new call
assertion fails when the production probe call is bypassed; the spy is restored before fixture
cleanup.

