# Beginner PDF guide

The requested deliverable is a Korean illustrated introduction for readers who have never used a coding agent. It explains Codex, the independent OpenCodex proxy, provider/model selection, setup and verification, then walks through a small local website task. The PDF is a local artifact under `~/Developer`; it is not a product release or public documentation deployment.

## Scope and implementation

One documentation-only work phase, `wp1`. The detailed manuscript plan and editable source are in the task-owned `opencodex-guide-20260912` directory beside the PDF. The later user refinement adds official Codex images, real OpenCodex GUI screenshots with synthetic data, a polite noncoder voice, author-attributed model recommendations and an input-box max/ultra explanation.

The GUI was built in the isolated `codex/beginner-pdf-mockup-20260912` worktree at `a0676af29bfeca11c1d87b36dc202bce0ef33334`. Existing dependency installations were reused. `bun run build` in `gui` passed (TypeScript project build and Vite; 297 modules). No production application source was changed. The screenshot fixture server served the built UI and synthetic responses only; the isolated browser blocked requests outside that fixture origin. Its server and browser were stopped after capture.

NEW artifacts outside this repository: original Korean manuscript JSON, ReportLab builder, PDF verifier, official image provenance, screenshot manifests, all-page raster renders, independent editorial reviews, HTTP link checks and the final PDF. This repository record documents that actual artifact work; it does not assert product implementation or use a product test as a PDF verifier.

## Source decisions

- Current OpenAI documentation supplies Codex terminology, supported surfaces, permissions and review concepts.
- Current OpenCodex documentation supplies installation, setup, provider authentication, routing and GUI behavior.
- The native input effort menu is distinguished from the subagent effort setting, proactive delegation and V2 effort caps. Current catalog documentation states that max/ultra advertisement is independent of the collaboration-surface toggle. Historical official screenshots locate the menu but do not prove that those exact tiers are visible in a current user's app.
- Model recommendations are attributed to the author rather than claimed as universal performance findings. Subscription included usage, API pricing and additional usage credits remain distinct. Zero subscription-quota consumption for every cache read is not stated as an official guarantee.
- Official images and synthetic settings screenshots are labeled separately. Fictitious account names, endpoints and usage values are not working credentials or real measurements.

## Verification and review

The artifact verifier explicitly opens the generated PDF, checks A4 dimensions, embedded Korean fonts, text, page-map agreement, internal destinations and external link annotations. All source URLs receive an HTTP check. Every rendered page receives visual review; screenshots are enlarged around relevant controls. Independent editorial and image reviewers inspect the actual files instead of the Git index.

Accepted review fixes: added the missing concrete Codex launch step, fixed malformed Korean, aligned the summary with the homepage exercise, enlarged official screenshot details, changed Korean wrapping to preserve words, increased caption legibility and removed clipped screenshot fragments. A source-list page may retain intentional whitespace because bibliography entries are grouped; this is not an unobserved layout pass.

## Process limitation

Native architect-type dispatch was unavailable in the exposed schema; it was not claimed to have run. Inherited native agents supplied editorial, factual and image reviews. Aside browser reads supplied current page evidence and its agent read selected rendered pages as a fresh reader. The first Aside research agent could only retrieve search excerpts, so its report was not used as primary proof; later direct browser reads verified those pages.

The first B-to-C attempt reported SOURCE-DELTA-01 because the PDF lives outside the repository. This record now provides the actual documentation delta and retains the distinction between artifact checks and product changes. No FSM bytes, baselines or receipts were manually modified. Final completion still requires the final artifact hash, rendered review, a producer-generated check receipt and criteria closure.

## Delivery

`/Users/jun/Developer/OpenCodex_처음부터_이해하기.pdf`, sha256 `14d0ffd9c18af9899c90a54c2bb73d770594e4fdb2a22a32a99f13c24d4f2b91`, 32 A4 pages, 6.9 MB. The verifier reports embedded Korean font subsets, 148 internal destinations, 27 unique external URLs, no glyph outside the page box and no empty page. Every external URL answered HTTP 200. Every page was rendered at 95 dpi and inspected; the editorial reviewer and the rendered-page reviewer both returned PASS after their findings were applied. The check receipt is `.codexclaw/evidence/01a093a9-c7ea-7133-bb87-3ee569af64ba/test-receipt.json` and was produced against the earlier hash `0f813938...`, before the follow-up naming patch below.

## Follow-up: app naming (C1 patch)

The user asked for the current app name. The changelog entry dated 2026-07-09, "Codex joins the ChatGPT desktop app 26.707", states that Codex is now part of the ChatGPT desktop app on macOS and Windows and that existing Codex app users keep their projects, settings and workflows. The app documentation page is titled "ChatGPT desktop app" and its quickstart tells the reader to choose ChatGPT or Codex after signing in. Both pages were read in a browser on 2026-09-12.

The booklet now carries a short "앱 이름이 바뀌었어요" section on the Codex page, names the surface "ChatGPT 데스크톱 앱" in the surface table and the prerequisite step, dates both official screenshots to the period when the app was called the Codex app, adds a glossary row, and adds source S26 for the changelog entry. Rebuilt and re-verified with zero errors; the six affected pages were re-rendered and inspected.

## Follow-up: dashboard routes (C1 patch)

Each page that shows or describes a dashboard screen now carries the address that opens it, using the hash routes the capture run actually visited: `#dashboard`, `#providers`, `#models`, `#codex-set/prompt`, `#subagents`, `#integrations` and `#logs`. Provider and subagent sub-tabs are reached inside the page, so those pages link the base route and name the tab in the text. The first screenshot page adds one line saying the port can differ and that `ocx gui` opens the live address.

Final artifact: sha256 `50d2495e0aca8603fe0536180788031bd3d036f08dc1d5e5e7af56bbf04c3294`, 32 pages, 148 internal destinations, 53 external link annotations over 34 unique URLs (27 public sources plus 7 local routes), verifier errors none. The 27 public URLs were HTTP-checked earlier and all answered 200; the local routes are not part of that check because they depend on a running proxy. `http://localhost:10100/` answered 200 with the dashboard HTML on this machine, and the hash is resolved client-side, so every listed route opens in the dashboard.

Applied review findings: the missing Codex launch step, malformed Korean endings, a summary that described a replaced exercise, Korean word-preserving line breaks, caption legibility, and five screenshot crops that cut the controls the text points at.

One page of the source list keeps deliberate trailing whitespace because bibliography entries are grouped by page rather than reflowed.

Unrelated to this unit: `src/codex/quota.ts` appeared staged in this checkout at 12:55 while this work ran. It matches the `codex/phantom-elapsed-short-quota` worktree and belongs to another task. It was left untouched.
