# 030 — WP4: detect and report version-manager shim destruction (#2412)

## The change in one sentence

When a version manager has overwritten the shim and its backup, say so with an
actionable message — and refuse to adopt the new binary as a replacement
original.

## The temptation, and why it is wrong

The obvious fix is to make auto-restore work: a backup is missing, so take the
current `codex` binary, rename it to `codex.opencodex-real`, and write a fresh
shim over it. It would make the symptom disappear immediately.

It is wrong twice over.

First, it is a lie about provenance. The binary now sitting at that path is the
version manager's newly installed `codex`, not the original OpenCodex wrapped.
Recording it as `.opencodex-real` asserts a history that did not happen.

Second, it does not survive. The next `mise upgrade codex` rewrites the same
install tree and destroys shim and backup again. The fix would re-arm itself
every upgrade, so the operator gets a repair that silently un-repairs on a
schedule — the worst possible failure shape, because it looks solved.

The install tree belongs to the version manager. OpenCodex should not be
installing files into it, and the supported route for these users is
`openai_base_url` injection plus `ocx service install`, which is what
`ocx start` already configures.

So: detect, report, document. Never adopt.

## Hunk 1 — the ownership heuristic

`src/codex/shim.ts`, exported for direct unit tests:

```ts
export function isVersionManagerOwnedCodexPath(path: string): boolean {
  const n = path.replace(/\\/g, "/").toLowerCase();
  return n.includes("/mise/installs/") || n.includes("/mise/shims/")
    || n.includes("/.asdf/installs/") || n.includes("/.asdf/shims/")
    || n.includes("/.volta/");
}
```

Backslash normalization is for Windows, where volta is common. Scope is the
three managers named in #2412; nvm/fnm/npm-prefix are deliberately excluded
until someone reports them, because a false positive here refuses a repair that
would otherwise be correct.

## Hunk 2 — carry a message, and refuse VM-owned adoption

`src/codex/shim.ts:2043`, before:

```ts
if (!existsSync(file.wrapperPath) || !hasUsableBackingPath(file)) return { status: "ineligible" };
```

After: compute `vmOwned` across wrapper/original/backup paths, include it in the
bail condition, and attach a message built from
`diagnoseCodexShim().summary` — the string `ocx codex-shim status` already
prints — plus, when `vmOwned`, this guidance:

> This Codex binary is owned by a version manager (mise/asdf/volta). OpenCodex
> will not wrap it as a new original, because the next upgrade would overwrite
> the shim and its backup again. Keep routing through Codex `openai_base_url`
> (`ocx start`) and use `ocx service install` for autostart.

The replacement path at `:2076` needs the same guard. If a stale
`.opencodex-real` happens to survive an upgrade, the existing code would
cheerfully re-wrap the new version-manager binary — the adoption this phase
forbids, arriving through the back door.

## Hunk 3 — no CLI changes needed for start/ensure/repair

This is the satisfying part. `src/cli/codex-shim-autorestore.ts:35` already
warns on an ineligible result **if it carries a message**:

```ts
} else if ((result.status === "deferred" || result.status === "ineligible") && result.message) {
  deps.warn(`⚠️  ${result.message}`);
}
```

and `src/cli/root.ts:83` runs that preflight before every command except
uninstall and `codex-shim install`. So attaching the message lights up
`ocx start`, `ocx ensure`, `ocx service repair`, and `ocx status` at once.
The mechanism was built correctly; one field was missing.

## Hunk 4 — docs

`docs-site/src/content/docs/reference/cli/lifecycle.md`, after the paragraph at
~`:357` promising that a completed Codex update restores the shim. That promise
is false for version-manager installs, and leaving it unqualified is how someone
concludes OpenCodex is broken rather than unsupported here. State plainly: the
install tree is not a supported shim target, upgrades destroy shim and backup,
and the supported configuration is service + `openai_base_url`.

English is authoritative; translated locales must not keep promising restore for
this case.

## What must NOT change

- Healthy shims stay `{ status: "healthy" }` on the zero-overhead path
  (`:2058`), including version-manager-owned ones that are currently intact.
  Detection gates repair, not operation.
- Non-VM overwrite with a surviving backup still auto-restores and still warns
  "automatic repair after Codex update".
- `allowFreshInstall: false`. The never-fresh-install rule at `:1887` is the
  invariant this phase reinforces, not one it relaxes.
- `repairService()` semantics. It reports on the background service, and that
  report is accurate; the shim warning arrives from the preflight instead.
- The first-line proxy badge. That is #2411's territory.

## Regression tests

| Test | File | Assertion | Fails before? |
|------|------|-----------|---------------|
| `version-manager overwrite with missing backup is ineligible and names the paths` | `tests/codex-shim.test.ts` | `ineligible` **with** a message naming wrapper state, missing backup, and the version manager; wrapper bytes unchanged | **Yes** — message is undefined |
| `version-manager-owned replacement is not adopted as a new original` | `tests/codex-shim.test.ts` | backup present but VM-owned path → ineligible; wrapper, backup, and state bytes all unchanged | **Yes** — today this restores |
| `ineligible destroyed shim warns on ordinary commands` | `tests/codex-shim-autorestore.test.ts` | one `⚠️` containing the diagnostic | **Yes** |
| `isVersionManagerOwnedCodexPath classifies known trees` | `tests/codex-shim.test.ts` | mise/asdf/volta true; `/usr/local/bin/codex`, `~/.npm-global/bin/codex` false | **Yes** — helper absent |

`tests/codex-shim.test.ts:1921` (`missing backup, missing wrapper, corrupt
state, and platform mismatch never fresh-install`) asserts only on `status`, so
adding a message does not break it — and it is the test that would catch an
adoption regression.

## Acceptance

`bun test tests/codex-shim.test.ts tests/codex-shim-autorestore.test.ts tests/codex-shim-readiness.test.ts`
green; `bun x tsc --noEmit` exit 0; `bun run privacy:scan` pass; docs build not
required for a Markdown-only change but the page must render in review.

## Open question for review

Explicit `ocx codex-shim install` against a version-manager-owned PATH:
warn-and-allow, or refuse outright? Auto-restore must refuse — that is settled
above and is what this issue asks for. An explicit operator command is a
different act. Recommendation: warn, allow, and let the operator own it; a hard
refusal removes a workaround someone may be relying on. This does not block the
phase either way.
