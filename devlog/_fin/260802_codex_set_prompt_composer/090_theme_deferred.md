# 090 — Theme: deferred

Status: **not started, deliberately.**

Ask: "뭐 할 수 있으면 theme도 넣는데, codex prompt에는 theme은 나중에 하는
걸로 그냥 설계해가지고 별도 devlog로 그냥 잠깐 스텝만 남겨놓고".

So: steps only. Nothing in WP1-WP7 implements any of this, and no Theme tab
ships with this unit.

## Why it is genuinely separate

Theme configures how Codex *renders*; the Prompt section configures what the
model *reads*. They share a page and nothing else — no config keys, no write
path, no failure modes. Bundling them would put a cosmetic setting behind the
same "applies to new sessions" caveat that prompt layers need, which is both
wrong and confusing.

## Steps when it is picked up

1. **Research the surface.** `~/.codex/config.toml` theme keys at the
   then-current upstream HEAD. `001` §6 shows this area moves fast, so a fresh
   read is mandatory — do not trust this document's assumptions.
2. **Decide ownership.** Whether Codex has a first-party theme setter, as it
   does for `codex features enable/disable` (`cli/src/main.rs:1909-1928`). If it
   does, delegate; the `features.ts:1-15` header states the principle — a
   third-party writer for something upstream already owns is churn.
3. **Reuse WP1.** If a direct write is needed, `prompt-layers.ts` already has
   the path resolution, EOL preservation, scoped line edit, and atomic write.
   Extend the allowlist; do not write a second writer.
4. **Add a third tab** to the `030` shell: `#codex-set/theme`. The shell is
   already n-way; adding a panel is additive.
5. **Extend `/api/codex-prompt`** or add a sibling route. Prefer a sibling —
   theme is not a prompt layer and folding it in would make one endpoint carry
   two unrelated schemas.
6. **i18n** in all six locales, English first (`004` §D).
7. **Live verification.** A theme change is visible; verify it in the actual
   Codex UI rather than asserting the file contents and calling it done.

## Open questions to settle first

- Does theme apply live, or on new sessions like the prompt keys (`003` §3)?
  The answer decides the copy, and the copy is the main UX risk.
- Is theme per-profile? `003` §2 — legacy `[profiles.x]` selection is a hard
  error now, so a per-profile theme would need `<name>.config.toml`.
- Does the Codex desktop app read theme from the same file, or its own store?
  If the latter, this belongs nowhere near `config.toml`.

None of these is answered here. Answering them is step 1.
