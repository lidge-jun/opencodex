# 061 — #1933 implementation record

Branch: `fix/tray-registry-encoding` off `fix/service-proxy-env`.
Commit: `e3b063750`. PR: **#2117** → `fix/service-proxy-env` (stacked).

## One plan assumption was wrong

`060` said "route `runRegistry`/`runRegistryAsync` through
`decodeWindowsTextBytes`", which reads like a seam change. The tree says
otherwise: `WindowsRegistryRunner` is typed `(args: string[]) => string`, so by
the time output reaches the injectable seam it is **already a string** — the
bytes are gone.

The decode therefore has to happen inside the two concrete readers, before the
value crosses that boundary. Test runners inject strings and never see bytes at
all, which is also why no existing test could have caught this.

## The change

```
decodeRegistryOutput(stdout: Buffer | string): string
  bytes = typeof stdout === "string" ? Buffer.from(stdout, "binary") : stdout
  return decodeWindowsTextBytes(bytes).trim()
```

| Reader | Before | After |
|---|---|---|
| `runRegistry` | `encoding: "utf8"` → `.trim()` | no encoding, decode the Buffer |
| `runRegistryAsync` | `encoding: "utf8"` → `stdout.trim()` | `encoding: "buffer"`, decode in the callback |

## A vacuous test I wrote and then replaced

The first behavioral test called `decodeWindowsTextBytes` directly on
synthesized cp1252 bytes and asserted the round trip. **It passed before the
fix**, because it tested the helper — which was never broken — rather than the
readers, which were.

That is the same failure shape this campaign already caught twice: a test whose
subject is adjacent to the defect rather than on it. Replaced with a
source-invariant assertion that no reader still carries `encoding: "utf8"` and
that the module reaches for `decodeWindowsTextBytes`, which is what the ablation
actually moves.

## Verification

```
bun test tests/windows-tray.test.ts tests/windows-text-decoding.test.ts   25 pass / 0 fail
bun x tsc --noEmit                                                       exit 0
```

**Ablation recorded.** Restoring `encoding: "utf8"` on the sync reader:

```
 0 pass
 1 fail
```

Restoring the fix returns 25/0.

## Deliberately not done

- **The foreign-Run refusal is untouched.** That check is correct; it was being
  fed corrupted input.
- **No `reg export` migration.** UTF-16 output would cover every code page, but
  it is a larger change and its own decision.
- **`Refs #1933`, not `Closes`.** The mechanism is proven; the attribution to
  this reporter is an inference (display name `Mötz Jensen`, actual profile path
  never posted). Closing needs `ocx tray status --json` from them.
