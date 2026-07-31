# 999 — Closeout: issue #180 CLI account/key parity

Final D summary across work-phases (updated at WP4 D).

## Delivered surface

`ocx account` family (GUI parity for the credential domain):

| Command | Semantics |
|---|---|
| `ocx account list [provider] [--json] [--all]` | Codex pool + OAuth accounts + API-key pools, masked; config-first classification; provenance-aware fan-out error policy |
| `ocx account current <provider> [--json]` | Active credential (codex: next-session pin incl. `auto` note) |
| `ocx account use <provider> <id\|main> [--json]` | Switch (codex: new sessions only; oauth/keys: immediate) |
| `ocx account refresh openai [--json]` | WHAM quota fan-out, per-account quota lines |
| `ocx account auto-switch <provider> <on\|off\|status\|threshold N> [--json]` | openai-only guard |
| `ocx account remove <provider> <id\|main> --yes [--json]` | Guarded delete, family-correct promotion output, main refused |
| `ocx account add-key <provider> [--label L] [--json]` | Pipe-only stdin, TTY rejected, `[redacted]` on key occurrences |

Docs: `ocx account` section in cli.md (en/ko/zh-cn) + "Switching accounts from the
terminal" pointer in guides/providers.md (3 locales) + `ocx account` rows in the
README CLI lists (en/ko/zh-cn) — audit R4 corrected the initial "deep-link only"
judgment; the READMEs DO carry command lists (README.md:269-287).

## Evidence pointers

- Commits on `dev`: `286bddf2` (feat core), `1235083c` (audit hardening),
  `9110c864` (feat extended), docs commit at WP4 D.
- Tests: `tests/cli-account.test.ts` rows 1-36 (40 cases) green; full isolated
  suite 3268 pass / 0 fail (279 files); `bun x tsc --noEmit` clean.
- Live matrix (real proxy 127.0.0.1:10100): list 12 masked rows; current openai
  pinned row; use ghost → exit 1; round-trip `use openai main` → restore
  `chatgpt-1784123203191` (user pin intact); refresh openai quota lines;
  auto-switch status/threshold/off round-trip with restore; secret grep clean.
- Subagent evidence receipts: `.codexclaw/evidence/2026-07-20-issue180-cli-account-tests.md`,
  `.codexclaw/evidence/subagent-9-issue180-wp2-audit-fold.md`,
  `.codexclaw/evidence/wp3-account-cli-issue180-20260720.md`,
  `.codexclaw/evidence/subagent-9-issue180-docs-verification.md`.
- Audits: WP1 2 rounds (Anscombe), WP2 3 rounds (Gauss), WP3 3 rounds (Gauss) —
  syntheses `005`, `011`, `021`.

## Audit-history notes (what the loop changed)

- Config-first classification (key-overridden OAuth providers route to the key
  family — mirrors `isKeyAuthProvider` + the GUI's `providerAuthSurface`).
- Provenance-specific fan-out tolerance (key 404 / config-oauth 400 only).
- Failed codex active read never fakes a null pin.
- Family-correct delete semantics (codex pin-clear vs oauth/keys promotion).
- Pipe-only secret intake with key-occurrence redaction.
- GUI-parity rebuttals recorded: local providers never classify credentials;
  user metadata (labels/ids) prints verbatim exactly like the GUI.

## Residual candidates (recorded, NOT in this loop's scope)

- `ocx account reauth` (GUI #171 re-auth flows; browser territory).
- Codex pool add-account via CLI browser flow; reset-credit view/consume.
- Failover threshold (`/api/codex-auth/failover`) — GUI doesn't expose it either.
- Non-credential GUI↔CLI gaps from `004` (combos, usage, logs, storage, proxy
  keys, settings families) — candidates for future units.
- Args-helper dedupe across cli modules (consumeFlag copies).
