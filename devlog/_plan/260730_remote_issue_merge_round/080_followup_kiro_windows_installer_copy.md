# 080 — Follow-up issue: Kiro CLI install copy is Unix-only across CLI and docs

**Filed as https://github.com/lidge-jun/opencodex/issues/716** (labels: `bug`, `documentation`) on
2026-07-30. This document is the local draft/rationale; #716 is the tracked work item.

Origin: deferred residual from WP1 of the 2026-07-30 loop entry (issue #710, commit `14d58ec1d`).
Recorded per the D-phase obligation in `070_audit_synthesis_round1.md` — the A-phase reviewer judged
the deferral acceptable **provided D files a concrete follow-up**. This document is that filing.

## Why it was deferred, not fixed inline

The reviewer's reasoning (round 2, accepted): `docs-site/.../guides/providers.md:160-164` already
claims the import path "searches the platform Kiro CLI stores". #710 made that existing sentence
*true* on Windows rather than contradicting it, so the credential-path fix did not need to expand
into installer copy. The Unix-only install wording is pre-existing debt with an independent blast
radius (5 locales + 2 CLI strings), and folding it into a credential-discovery commit would have
mixed a security-boundary change with a docs sweep.

## The gap

`https://cli.kiro.dev/install | bash` appears in **12 places**; the PowerShell installer appears in
**zero**. Verified: `rg -rn "install.ps1" src docs-site readme` returns no hits.

| File | Sites | Kind |
|---|---|---|
| `src/oauth/kiro.ts` | 2 | Runtime CLI/GUI login instructions |
| `docs-site/src/content/docs/guides/providers.md` | 2 | English docs (source of truth) |
| `docs-site/src/content/docs/ko/guides/providers.md` | 2 | Korean |
| `docs-site/src/content/docs/ja/guides/providers.md` | 2 | Japanese |
| `docs-site/src/content/docs/zh-cn/guides/providers.md` | 2 | Simplified Chinese |
| `docs-site/src/content/docs/ru/guides/providers.md` | 2 | Russian |

The Windows installer command is known from the #710 reporter, who used it to reach the state that
exposed the discovery bug:

```powershell
irm 'https://cli.kiro.dev/install.ps1' | iex
```

## Why this now matters more than before #710

Before `14d58ec1d`, a Windows user following the Unix install line could not complete a native import
anyway — discovery would miss the store regardless, so the copy was one of two blockers. Now the
import works on Windows, and the install instruction is the **only** remaining blocker on that path.
The fix that made Windows viable is what promotes this from cosmetic to user-facing.

The `src/oauth/kiro.ts` strings are the higher-severity half: they are shown at the moment login fails
(no kiro-cli token found), so a Windows user is handed a command their shell cannot run at exactly the
point they need it.

## Scope for the follow-up

IN

- Both `src/oauth/kiro.ts` instruction strings: offer the PowerShell command on Windows, or present
  both commands labeled by platform. Prefer platform-conditional text — the message is already
  assembled at runtime, and `process.platform` is available.
- All five `providers.md` locales: document both installers. English is the source of truth; the four
  translations must not contradict it (AGENTS.md docs-sync rule).
- A focused test asserting the Windows instruction path, consistent with the pure-resolver precedent
  from #710 (keep platform branching testable rather than sniffed inline).

OUT

- Kiro credential discovery, token parsing, snapshot/rollback — settled by #710.
- The `kiro-cli login` / `KIRO_ACCESS_TOKEN` fallback semantics.
- Any other provider's install copy. Verify separately before assuming the same gap exists elsewhere;
  do not widen this into a repo-wide installer audit without evidence.

## Accept criteria

| # | Scenario | Observable proof |
|---|----------|------------------|
| 1 | Windows login failure shows a runnable install command | The `onManualCodeInput` instruction string contains the PowerShell installer when `platform === "win32"` |
| 2 | POSIX copy unchanged | macOS/Linux still receive the `curl ... | bash` form |
| 3 | English docs document both | `providers.md` Kiro credential-import section names both installers |
| 4 | Locales consistent | ko/ja/zh-cn/ru updated; no locale claims Unix-only |
| 5 | No unconditional Unix-only install string remains in runtime copy | `rg -n "cli.kiro.dev/install " src` shows only platform-branched or dual-form usage |
| 6 | Gates | `bun x tsc --noEmit`, focused test, `bun run test` (OAuth surface per `src/AGENTS.md`), `bun run privacy:scan` |

## Verification note for whoever picks this up

Confirm the PowerShell URL against Kiro's official docs before shipping. It is currently sourced from
the #710 reporter's transcript — a credible primary user report, but not vendor documentation. Treat
it as a lead to verify, not a settled fact.
