# Desktop download focus — landing refinement for PR #5638

The landing page's download section showed all three platform cards at once, with SHA-256 links and a long launch pill that wrapped on phones. This unit keeps the page focused on the visitor's own platform: the pill becomes a one-line "Desktop beta" link, the section shows only the detected platform's card with the other two behind an "Other platforms" disclosure, and the checksum links are removed (the footer's "All releases and checksums" stays). Visitors with no detectable desktop platform, or without JavaScript, still see all three cards.

## Loop spec

- Loop archetype: satisfy-spec, single work-phase (wp1), C2 frontend slice.
- Trigger: user steering on PR #5638 — "one line Desktop beta; show only the matching box per platform with a More dropdown; remove SHA-256 text" under cxc-loop HOTL.
- Goal: the three requirements above, shipped on dev through PR #5638.
- Non-goals: README and readme/ locales (GitHub cannot detect a platform), src/, gui/, desktop/, release tooling, any other PR.
- Verifier: `cd docs-site && bun run build` (exit 0; runs the opencodex-internal-links integration over the rendered Landing on all 8 locales, so it reads this change); focused `bun test tests/ci-workflows/{docs-readme-translation-parity,repo-hygiene,docs-link-targets,install-scripts,file-size-ratchet}.test.ts` (reads README/locales/package files; the size ratchet scans custom.css under the default 2000-line cap, currently 1109 lines, while Landing.astro is not scanned; none of these observe the landing behaviour); `bun run privacy:scan`. Landing behaviour has no automated test, so it is observed in headless Chrome (agbrowse on CDP 9333) against `astro preview`: detected macOS UA (1440 light/dark), forced unknown platform (all three cards, disclosure hidden), 320px/390px pill on one line, disclosure open state, no "SHA-256" text in `#download`, and `[data-lp-asset]` hrefs resolving to releases/download/v2.63.0/.
- Stop condition: criteria c-1..c-5 met with evidence and PR #5638 squash-merged into dev.
- Memory artifact: this unit (000_plan.md, 010_evidence.md), the bound goalplan, and the PR body.
- Expected terminal outcomes: DONE when merged with evidence; BLOCKED on a required CI failure caused by this change that cannot be fixed or a merge refusal; NEEDS_HUMAN on a product decision outside the three requirements.
- Escalation: swe-2 workers are resource-exhausted until about 14:10 KST; DISPATCH-RETIRE-01 — build falls back to main if the swe-2 packet fails again, recorded here. Resource bounds: repo write scope = the two files plus this unit; credentials = existing gh login; no token or time budget was set by the user.

## Conditional paths and activation

| Path | Activation in C | Observable effect |
|---|---|---|
| recommend(platform) → collapse | default headless Chrome UA (Mac) | one card in `.lp-dl-grid`, `details.lp-dl-more` visible, 2 cards inside it |
| undetected fallback | headless Chrome launched with `--user-agent` set to an Android phone, `--dump-dom --virtual-time-budget` after scripts run; plus the no-JS HTML via curl | 3 cards in `.lp-dl-grid`, `details.lp-dl-more` still `hidden` |
| Windows detection | headless Chrome `--user-agent` Windows 11 desktop UA + `--dump-dom` | Windows card alone in `.lp-dl-grid`, 2 cards in `.lp-dl-more-grid`, hero label "Download for Windows" |
| iPadOS desktop mode | not observable: `--user-agent` cannot change `navigator.maxTouchPoints`; the branch is unchanged by this unit (added in 071ad7dc) | stated as unobserved |
| fr dictionary keys | `rg` on `docs-site/dist/fr/index.html` after build | contains "App de bureau bêta" and "Autres plateformes"; no "Bêta de l’app de bureau" |
| Linux arch gate | unchanged code; covered by the existing review-verified branch | n/a (no Linux host) — stated as unobserved |
| fetch failure | unchanged; hrefs default to releases/latest in curl HTML | curl shows releases/latest hrefs |

## File change map

`docs-site/src/components/Landing.astro`
- fr dict: remove 'New' and 'Desktop app beta for macOS, Windows and Linux'; add 'Desktop beta': 'App de bureau bêta', 'Other platforms': 'Autres plateformes'.
- Hero pill: drop `.lp-announce-tag`; text `t('Desktop beta', '데스크톱 베타', '桌面版 Beta', 'Бета для десктопа', 'デスクトップ版ベータ', '桌面版 Beta', 'Masaüstü beta')` + arrow.
- Cards: delete every `.lp-dl-sha` anchor and the `.lp-dl-links` wrappers on macOS and Windows. The Linux card keeps its `.deb` link AFTER the AppImage button inside `.lp-dl-actions` (visible text stays the existing t('.deb package') label), so keyboard focus reaches the primary button first.
- After `.lp-dl-grid`: `<details class="lp-dl-more" hidden><summary>{t('Other platforms', '다른 플랫폼 더보기', '其他平台', 'Другие платформы', 'その他のプラットフォーム', '其他平台', 'Diğer platformlar')}</summary><div class="lp-dl-more-grid"></div></details>`.
- Script: recommend() also moves the non-recommended cards into `.lp-dl-more-grid` (null-safe) and removes `hidden` from the details; delete the four `*.sha256` patterns.

`docs-site/src/styles/custom.css`
- `.lp-announce`: `white-space: nowrap`, drop `text-wrap: balance`, the <30rem override and `.lp-announce-tag`; drop the ko keep-all on `.lp-announce-text` (keep it for `.lp-download`).
- `.lp-dl-alt` gets `align-self: flex-start` (the actions column stretches children). Summary joins the focus-visible outline rule.
- Remove `.lp-dl-sha`, `.lp-dl-sep`, `.lp-dl-links` rules; when editing the shared selector lists keep the `.lp-dl-alt` colour and hover rules. `.lp-dl-actions` reserves one link line for every card (min-height = button + gap + one link line) so buttons share a row in the three-column fallback and the two-column disclosure.
- `.lp-download:has(.lp-dl-more:not([hidden])) .lp-dl-grid { grid-template-columns: minmax(0, 28rem); }`.
- `.lp-dl-more:not([hidden])` block, summary chevron (`list-style:none`, hide webkit marker, `::after` rotate on [open] inside the no-preference motion block), `.lp-dl-more-grid` two columns max 56rem, one column ≤48rem; summary added to the focus-visible outline rule.

SoT sync: structure/ has no docs-site landing owner (checked in C with rg); the PR body is the record.

## Architect consultation

- Handle 01a0cc9b-10e4-76f0-9d6b-dd16dd3a8e5f; proposal D1–D8 plus a rejected CSS-only alternative (focus-order reason).
- Dispositions: D1 accept (summary label ko amended to "다른 플랫폼 더보기" to match the user's "더보기"); D2 accept; D3 accept; D4 accept; D5 accept; D6 accept; D7 accept as proposed (after reflection gap 1): the .deb link stays after the AppImage button and every card's actions reserve one link line; D8 accept.
- Reflection on revision 1: ALIGNED, D1-D8 mapped; four gaps, all folded into revision 2: (1) .deb link moved back after the button for focus order, visible label stated; (2) keep .lp-dl-alt colour/hover while deleting .lp-dl-sha from shared lists; (3) the unknown-platform path is exercised through a real UA override (Chrome --user-agent + --dump-dom) instead of script-stripped HTML; (4) verifier wording corrected — isScannedPath(custom.css)=true with THRESHOLD 2000, Landing.astro not scanned.
- SoT: structure/INDEX.md routes docs-site/ to structure/ops/docs-and-release.md; C checks whether it describes the landing download surface and patches it only if it does.


## Audit (A)

- Reviewer 01a0cc9f: NEAR-PASS. Blockers folded in revision 3: (1) iPad desktop-mode row downgraded to unobserved with reason, Windows UA row added; (2) fr keys verified by grepping dist/fr/index.html, and callers of t('New') / the old pill key checked before deletion; (3) D7 disposition made consistent (link after the button, one-line reserve). Notes folded: .lp-dl-alt align-self, summary focus outline, open-state screenshot shows demoted buttons.
