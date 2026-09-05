# 020 — Defect 1: a test asserts on the Windows launcher's argument grammar

Implementation phase. Independent of `010` and `030`. 2 of the 25 failures.

## Failure

```
  [
-   "disable",
+   "/s",
  ]
      at tests/multi-agent-keep-native-v1.test.ts:223:21
(fail) ocx v2 keep-native-v1 > mode v2 honors a pre-existing native-v1 pin …
(fail) ocx v2 keep-native-v1 > enabling the native-v1 pin disables the global V2 override …
```

Evidence: `.tmp/win/v140-1.log`.

## The product is correct

`commandInvocation` (`src/lib/win-exec.ts:79-96`) routes a `.cmd`/`.bat` target
through `ComSpec` as `["/d","/s","/c", "<escaped line>"]`, preserving
`features disable multi_agent_v2` inside the quoted line. A shell-less `.cmd`
spawn is rejected by post-CVE Node/Bun, so the wrapper is required, and
`args[1] === "/s"` is its correct output. Corpus: `cmd-shim-reparses-argv`.

The defect is that `tests/multi-agent-keep-native-v1.test.ts` reads `args[1]`
(`:215`) and compares the joined argv to a POSIX string (`:185`), i.e. it uses the
OS launcher's grammar as its mock API.

## Fix — normalize in the test, do NOT add a product seam

An earlier draft proposed adding `V2CliDeps.featureAction`. **Rejected on audit,
and the audit is right:** it would move all three keep-native call sites outside
`codexFeaturesInvocation`, so those tests would no longer exercise
`cmdV2 → codexFeaturesInvocation → commandInvocation` at all, and a future state
test could bypass launcher construction without anyone noticing. Adding a
product-visible seam to make a test simpler is the wrong trade when the test can
simply read the value correctly.

The repository already has the right pattern, in a test that hit this first
(`tests/codex-v2-gate.test.ts:1736`):

```ts
// POSIX: ["features", "enable|disable", ...]; win32 .cmd: ["/d","/s","/c","...enable..."]
const joined = args.join(" ");
const enabled = args[1] === "enable" || /\benable\b/.test(joined);
```

### MODIFY `tests/multi-agent-keep-native-v1.test.ts`

`:175` — record the semantic action rather than the raw joined argv:

```ts
-      events.push(args.join(" "));
+      events.push(featureActionOf(args));      // "features disable multi_agent_v2"
```

`:214` — same, replacing the `args[1]` index:

```ts
-        actions.push(args[1]!);
+        actions.push(featureActionOf(args).split(" ")[1]!);
```

with one local helper in the test file. **It parses one of the two supported argv
SHAPES; it does not search for a phrase.** An unanchored search would accept
`["/d","/s","/c","echo features disable multi_agent_v2"]` — a bypassed
invocation that never runs `codex` — and report success:

```ts
/**
 * The semantic `features <action> <feature>` triple, parsed from exactly the two
 * argv shapes `commandInvocation` produces (src/lib/win-exec.ts:85-95):
 *   POSIX / .exe : ["features", "<action>", "<feature>"]
 *   win32 .cmd   : ["/d", "/s", "/c", '"<cmd> ^"features^" ^"<action>^" ^"<feature>^""']
 * Anything else throws, so a bypassed or malformed invocation fails the test
 * instead of silently matching.
 */
function featureActionOf(args: readonly string[]): string {
  const ACTION = /^(?:enable|disable)$/;
  const FEATURE = /^[a-z0-9_]+$/;

  // Direct spawn: the exact three-element argv, nothing before or after.
  if (args.length === 3 && args[0] === "features") {
    const [, action, feature] = args;
    if (!ACTION.test(action!) || !FEATURE.test(feature!)) {
      throw new Error(`malformed features argv: ${JSON.stringify(args)}`);
    }
    return `features ${action} ${feature}`;
  }

  // cmd.exe wrapper: fixed prefix, single quoted line, and the command line must
  // BEGIN with the codex target — "echo features disable x" is rejected here.
  if (args.length === 4 && args[0] === "/d" && args[1] === "/s" && args[2] === "/c") {
    const line = args[3]!;
    if (!line.startsWith('"') || !line.endsWith('"')) {
      throw new Error(`unquoted cmd line: ${line}`);
    }
    const inner = line.slice(1, -1);
    // Split on unescaped spaces only: escapeCmdCommand rewrites a space in the
    // target path as "^ ", so "C:\Program Files\..." is ONE token. Then strip the
    // argument quoting, which is "^\"" for a normal target and "^^^\"" for a
    // node_modules/.bin shim (IS_CMD_SHIM double-escapes, win-exec.ts:89).
    const tokens = inner
      .split(/(?<!\^) /)
      .map(t => t.replace(/\^+"/g, "").replace(/\^ /g, " "));
    const [target, keyword, action, feature, ...rest] = tokens;
    if (
      rest.length > 0
      || !/\.(cmd|bat)$/i.test(target ?? "")
      || keyword !== "features"
      || !ACTION.test(action ?? "")
      || !FEATURE.test(feature ?? "")
    ) {
      throw new Error(`unrecognized cmd invocation: ${inner}`);
    }
    return `features ${action} ${feature}`;
  }

  throw new Error(`unrecognized features invocation: ${JSON.stringify(args)}`);
}
```

Three properties matter, and each closes a specific silent-pass hole:

1. **Exact arity and prefix.** Extra leading or trailing tokens are rejected, so
   a wrapper that grew an argument is a failure, not a match.
2. **The cmd line must start with the `.cmd`/`.bat` target.** This is what
   rejects `echo features disable multi_agent_v2`: `echo` is not a batch target.
3. **It throws instead of defaulting.** A future change that stops invoking
   `codex features` fails loudly rather than recording `""` and passing.

### Negative cases the phase must add

The helper is itself test logic, so it gets tested. Each of these must throw:

```ts
["/d","/s","/c",'"echo ^"features^" ^"disable^" ^"multi_agent_v2^""']  // bypassed target
["features","disable"]                                                 // truncated
["features","restart","multi_agent_v2"]                                // unknown action
["/d","/s","/c","features disable multi_agent_v2"]                     // unquoted line
["-c","features disable multi_agent_v2"]                               // wrong shape
```

### Verified against real `commandInvocation` output

The parser was not written from the source and hoped at — it was run against
what `commandInvocation` actually emits for three target shapes:

```
C:\npm\codex.cmd
  "C:\npm\codex.cmd ^"features^" ^"disable^" ^"multi_agent_v2^""
C:\Program Files\npm\codex.cmd
  "C:\Program^ Files\npm\codex.cmd ^"features^" ^"disable^" ^"multi_agent_v2^""
C:\proj\node_modules\.bin\codex.cmd
  "C:\proj\node_modules\.bin\codex.cmd ^^^"features^^^" ^^^"disable^^^" ^^^"multi_agent_v2^^^""
```

Two traps a naive parser walks into, both real:

1. **A space in the target path is escaped as `^ `, not quoted.** Splitting on
   `/\s+/` would break `C:\Program^ Files\...` into two tokens and reject a
   perfectly valid invocation. Hence the `(?<!\^) ` lookbehind.
2. **`node_modules/.bin` shims are DOUBLE-escaped** — `^^^"` rather than `^"` —
   because `IS_CMD_SHIM` (`src/lib/win-exec.ts:17,89`) applies `escapeCmdArg`
   twice. A `/\^?"/` strip handles one caret and leaves `^^` behind. Hence
   `/\^+"/g`.

Measured result of the parser above on all four positive cases (three win32
shapes plus the POSIX triple): each returns `"features disable multi_agent_v2"`.
On the five negative cases: each throws. The `echo` bypass is rejected at the
`.cmd`/`.bat` target check, as intended.

### Unchanged, deliberately

- `src/cli/v2.ts` and `src/lib/win-exec.ts` — no product change in this phase.
- `tests/codex-v2-gate.test.ts:1692-1726` — the launcher contract itself
  (POSIX passthrough, `.cmd` through `cmd.exe` with the exact escaped line,
  `.exe` direct).
- `tests/win-exec.test.ts` — `commandInvocation` behaviour.
- The two repaired tests keep going through the real `codexFeaturesInvocation`,
  so they still cover the integration on both platforms.

## Acceptance

1. `./node_modules/bun/bin/bun.exe test --isolate --timeout 60000 tests/multi-agent-keep-native-v1.test.ts`
   on the box → 11 pass, 0 fail (9 pass / 2 fail today).
2. `bun test tests/multi-agent-keep-native-v1.test.ts` on macOS → 11 pass
   (11 pass today; the normalization must not change POSIX behaviour).
3. `bun test tests/codex-v2-gate.test.ts tests/win-exec.test.ts` unchanged
   (132 + 19 pass).
4. No assertion weakened: the same transition is asserted, read through a
   platform-correct accessor instead of a positional index.
