# 012 — Mark sourcing decision

Research agent (claude-opus-5) verified on the public web, 2026-09-08. Assets held outside the
repo at `/tmp/ocx-marks/` until wp3 commits them.

| id | Decision | File | Source | Terms basis |
|----|----------|------|--------|-------------|
| `qoder` | ship | `qoder.svg` | `https://qoder.com/favIcon.svg` (declared site icon; 73,379 B; viewBox `0 0 206 206`; byte-identical on `qoder.cn`, `qoder.com.cn`, and the schema.org Organization logo URL) | Qoder ToS (BRIGHT ZENITH, 2026-04-29) reserves rights generally, no mark-use prohibition; same posture as `meta.svg` |
| `qoder-cn` | ship, shared asset | `qoder.svg` | same file | CN agreement (通义云启（杭州）信息技术有限公司 + Alibaba Cloud, 2026-05-20) §五(a) reserves 商标 rights without restricting third-party use |
| `codebuddy` | initials tile, documented | none | mark exists (`…/web/ide/logo.svg`) | CodeBuddy service agreement §9.3 "Tencent Logo": no use of Tencent brand features "under any circumstances" without written consent |
| `codebuddy-cn` | initials tile, documented | none | same | same clause on `codebuddy.cn/document/term` |

Wiring consequences:

- `gui/tests/provider-icons.test.ts` derives the asset stem from `providerId.split("-")[0]`,
  so committing `qoder.svg` fails the unwired-asset check for both `qoder` and `qoder-cn`
  until each has its own alias row (the Meta commit pinned both ids for the same reason).
- Do not mask `qoder.svg`: light plate + dark glyph, both neutral inks, 94.5% opaque; a
  mask collapses it into a filled box (README "plate problem").
- Display names: `qoder` → "Qoder", `qoder-cn` → "Qoder CN", `codebuddy` → "CodeBuddy",
  `codebuddy-cn` → "CodeBuddy CN".
- The CodeBuddy refusal goes into `gui/public/provider-icons/README.md` because no test
  can detect an absent mark; without the note a later pass would re-fetch the logo.
