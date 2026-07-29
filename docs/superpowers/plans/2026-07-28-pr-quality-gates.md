# PR Quality Gates (Ancestry + Description) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `enforce-pr-target` so PRs like #644 fail: wrong ancestry (branched from `main` while targeting `dev`/`dev2-go`) and empty/thin/malformed descriptions, with the same draft + comment + `setFailed` UX as wrong-base.

**Architecture:** Pure validators live in `.github/scripts/pr-quality.cjs` (reusing `issue-quality` helpers for placeholders / structured sections). The workflow checks out **trusted** scripts from the repository default branch (sparse, no PR head), then the existing `github-script` step requires that module, evaluates base + ancestry + description, and drafts/`setFailed`s when any gate fails.

**Tech Stack:** Node CommonJS (Actions scripts), `node:test` for script unit tests, Bun/`tests/ci-workflows.test.ts` + `enforce-pr-target-harness.ts` for workflow behavioral coverage, Astro docs-site for contributing copy.

**Spec:** `docs/superpowers/specs/2026-07-28-pr-quality-gates-design.md`

## Global Constraints

- `ANCESTRY_BEHIND_THRESHOLD = 20`
- Ancestry fail when `behind_main === 0 && behind_base >= 20`
- Release compare ref = `main`
- Description: min section length `40`, min rich sections `2`, unstructured min length `120`, min blocks `2`
- Skip ancestry only for authors with push/maintain/admin on the base repo; permission API failure → fail closed (apply ancestry)
- Do **not** skip description for maintainers
- `[WRONG BRANCH]` title prefix only for wrong **base**
- `pull_request_target`: never check out PR head; checkout only `github.event.repository.default_branch` + sparse `.github/scripts`
- Permissions stay `contents: write` + `pull-requests: write`
- Add trigger type `synchronize`
- No live GitHub in unit tests

## File map

| File | Role |
| --- | --- |
| `.github/scripts/pr-quality.cjs` | Pure ancestry + description assessment + failure collectors |
| `.github/scripts/pr-quality.test.cjs` | Node unit tests for pure rules |
| `.github/workflows/enforce-pr-target.yml` | Checkout + require + multi-gate orchestration |
| `.github/scripts/enforce-pr-target.test.cjs` | Static workflow assertions (checkout safety, synchronize, paths) |
| `tests/helpers/enforce-pr-target-harness.ts` | Allow `require` of scripts; mock compare + permission; PR `body` |
| `tests/ci-workflows.test.ts` | Structural allowlist + behavioral scenarios |
| `.github/workflows/issue-quality-tests.yml` | Path filters for new script/tests |
| `docs-site/src/content/docs/contributing.md` | User-facing branch + description rules |
| `AGENTS.md` / `MAINTAINERS.md` | One-line CI policy note |

---

### Task 1: Pure `pr-quality.cjs` (ancestry + description)

**Files:**
- Create: `.github/scripts/pr-quality.cjs`
- Create: `.github/scripts/pr-quality.test.cjs`
- Modify: `.github/workflows/issue-quality-tests.yml` (add path filters + `node --test` line)

**Interfaces:**
- Produces:
  - `ANCESTRY_BEHIND_THRESHOLD` number (`20`)
  - `isWrongAncestry({ behindMain, behindBase, threshold? }) → boolean`
  - `authorHasPushPermission(permission: string | null | undefined) → boolean` — true for `admin` \| `maintain` \| `write`
  - `assessPrDescription(body: string | null | undefined) → { ok: true } | { ok: false, reason: "empty" | "placeholder" | "escaped_newlines" | "thin" }`
  - `collectPrQualityFailures({ baseRef, allowedBases, body, behindMain, behindBase, authorPermission, permissionLookupFailed? }) → Array<{ code: "wrong_base" | "wrong_ancestry" | "bad_description", reason?: string }>`
    - `wrong_base` when `!allowedBases.includes(baseRef)`
    - `wrong_ancestry` only when base allowed, and (`permissionLookupFailed` or `!authorHasPushPermission(authorPermission)`), and `isWrongAncestry(...)`
    - `bad_description` whenever `assessPrDescription` is not ok (even if wrong_base)

- [ ] **Step 1: Write the failing tests**

Create `.github/scripts/pr-quality.test.cjs`:

```js
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ANCESTRY_BEHIND_THRESHOLD,
  isWrongAncestry,
  authorHasPushPermission,
  assessPrDescription,
  collectPrQualityFailures,
} = require("./pr-quality.cjs");

describe("isWrongAncestry", () => {
  it("flags #644-shaped compares (0 behind main, far behind base)", () => {
    assert.equal(
      isWrongAncestry({ behindMain: 0, behindBase: 44 }),
      true,
    );
  });

  it("uses threshold 20 by default", () => {
    assert.equal(ANCESTRY_BEHIND_THRESHOLD, 20);
    assert.equal(isWrongAncestry({ behindMain: 0, behindBase: 20 }), true);
    assert.equal(isWrongAncestry({ behindMain: 0, behindBase: 19 }), false);
  });

  it("passes when head is behind main (not sitting on main tip)", () => {
    assert.equal(isWrongAncestry({ behindMain: 1, behindBase: 44 }), false);
  });
});

describe("authorHasPushPermission", () => {
  it("accepts write/maintain/admin only", () => {
    assert.equal(authorHasPushPermission("admin"), true);
    assert.equal(authorHasPushPermission("maintain"), true);
    assert.equal(authorHasPushPermission("write"), true);
    assert.equal(authorHasPushPermission("triage"), false);
    assert.equal(authorHasPushPermission("read"), false);
    assert.equal(authorHasPushPermission(null), false);
  });
});

describe("assessPrDescription", () => {
  it("rejects empty and comment-only bodies", () => {
    assert.equal(assessPrDescription("").ok, false);
    assert.equal(assessPrDescription("   ").ok, false);
    assert.equal(
      assessPrDescription("<!-- release notes by coderabbit.ai -->\n\n<!-- end -->").reason,
      "empty",
    );
  });

  it("rejects placeholder-only bodies", () => {
    assert.equal(assessPrDescription("N/A").reason, "placeholder");
    assert.equal(assessPrDescription("TODO").reason, "placeholder");
  });

  it("rejects literal escaped newlines like #644", () => {
    const body =
      "## What changed\\n- make the Windows tray launcher resolve Codex home\\n\\n## Validation\\n- git diff --check";
    assert.equal(assessPrDescription(body).reason, "escaped_newlines");
  });

  it("rejects thin real-newline bodies", () => {
    assert.equal(assessPrDescription("fix stuff").reason, "thin");
  });

  it("accepts two rich markdown sections", () => {
    const body = [
      "## Summary",
      "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
      "",
      "## Test plan",
      "- Launch the tray app after setting CODEX_HOME",
      "- Confirm the listener and launcher use the same workspace root",
    ].join("\n");
    assert.equal(assessPrDescription(body).ok, true);
  });

  it("accepts unstructured bodies that are long enough with multiple blocks", () => {
    const p1 =
      "Updates the Windows tray launcher to resolve the active Codex home through the shared helper so listener and launcher stay aligned.";
    const p2 =
      "Validated with git diff --check on the changed tray module; typecheck was not available in that session so CI must cover it.";
    assert.equal(assessPrDescription(`${p1}\n\n${p2}`).ok, true);
  });
});

describe("collectPrQualityFailures", () => {
  const allowed = ["dev", "dev2-go"];

  it("reports wrong_base without requiring ancestry inputs", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: "## Summary\n" + "x".repeat(50) + "\n\n## Test plan\n" + "y".repeat(50),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
    });
    assert.ok(failures.some((f) => f.code === "wrong_base"));
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("reports wrong_ancestry for contributor on #644-shaped compare", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 0,
      behindBase: 44,
      authorPermission: "read",
    });
    assert.deepEqual(
      failures.map((f) => f.code),
      ["wrong_ancestry"],
    );
  });

  it("skips ancestry for push permission but still flags bad description", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: "",
      behindMain: 0,
      behindBase: 44,
      authorPermission: "write",
    });
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
    assert.ok(failures.some((f) => f.code === "bad_description"));
  });

  it("applies ancestry when permission lookup failed (fail closed)", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 0,
      behindBase: 44,
      authorPermission: null,
      permissionLookupFailed: true,
    });
    assert.ok(failures.some((f) => f.code === "wrong_ancestry"));
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

Run:

```bash
node --test .github/scripts/pr-quality.test.cjs
```

Expected: FAIL — `Cannot find module './pr-quality.cjs'`

- [ ] **Step 3: Implement `.github/scripts/pr-quality.cjs`**

```js
"use strict";

const path = require("node:path");
const {
  clean,
  isPlaceholderOnlyValue,
  hasSubstantialStructuredContent,
} = require(path.join(__dirname, "issue-quality.cjs"));

const ANCESTRY_BEHIND_THRESHOLD = 20;
const MIN_SECTION_LEN = 40;
const MIN_RICH_SECTIONS = 2;
const UNSTRUCTURED_MIN_LEN = 120;
const UNSTRUCTURED_MIN_BLOCKS = 2;

function isWrongAncestry({ behindMain, behindBase, threshold = ANCESTRY_BEHIND_THRESHOLD }) {
  return behindMain === 0 && behindBase >= threshold;
}

function authorHasPushPermission(permission) {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

/**
 * True when the body uses literal backslash-n as the dominant line break
 * (agent bug seen on #644) rather than real newlines.
 */
function hasEscapedNewlines(text) {
  const escaped = (text.match(/\\n/g) || []).length;
  if (escaped < 2) return false;
  const real = (text.match(/\n/g) || []).length;
  return escaped > real;
}

function countContentBlocks(text) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length >= 2) return blocks.length;
  const bullets = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+\S/.test(l));
  return Math.max(blocks.length, bullets.length);
}

function assessPrDescription(body) {
  if (typeof body !== "string" || !body.trim()) {
    return { ok: false, reason: "empty" };
  }
  if (hasEscapedNewlines(body)) {
    return { ok: false, reason: "escaped_newlines" };
  }
  const cleaned = clean(body);
  if (!cleaned) {
    const strippedComments = body.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!strippedComments) return { ok: false, reason: "empty" };
    if (isPlaceholderOnlyValue(strippedComments)) {
      return { ok: false, reason: "placeholder" };
    }
    return { ok: false, reason: "empty" };
  }
  if (isPlaceholderOnlyValue(cleaned)) {
    return { ok: false, reason: "placeholder" };
  }
  if (hasSubstantialStructuredContent(cleaned, MIN_SECTION_LEN, MIN_RICH_SECTIONS)) {
    return { ok: true };
  }
  if (
    cleaned.length >= UNSTRUCTURED_MIN_LEN &&
    countContentBlocks(cleaned) >= UNSTRUCTURED_MIN_BLOCKS
  ) {
    return { ok: true };
  }
  return { ok: false, reason: "thin" };
}

function collectPrQualityFailures({
  baseRef,
  allowedBases,
  body,
  behindMain,
  behindBase,
  authorPermission,
  permissionLookupFailed = false,
}) {
  const failures = [];
  const wrongBase = !allowedBases.includes(baseRef);
  if (wrongBase) {
    failures.push({ code: "wrong_base" });
  } else {
    const skipAncestry =
      !permissionLookupFailed && authorHasPushPermission(authorPermission);
    if (!skipAncestry && isWrongAncestry({ behindMain, behindBase })) {
      failures.push({ code: "wrong_ancestry" });
    }
  }

  const desc = assessPrDescription(body);
  if (!desc.ok) {
    failures.push({ code: "bad_description", reason: desc.reason });
  }
  return failures;
}

module.exports = {
  ANCESTRY_BEHIND_THRESHOLD,
  isWrongAncestry,
  authorHasPushPermission,
  assessPrDescription,
  collectPrQualityFailures,
  hasEscapedNewlines,
};
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
node --test .github/scripts/pr-quality.test.cjs
```

Expected: all tests pass.

- [ ] **Step 5: Wire path filters in `issue-quality-tests.yml`**

In both `pull_request` and `push` `paths:` lists, add:

```yaml
      - ".github/scripts/pr-quality.cjs"
      - ".github/scripts/pr-quality.test.cjs"
```

In the test step commands, add:

```yaml
          node --test .github/scripts/pr-quality.test.cjs
```

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/pr-quality.cjs .github/scripts/pr-quality.test.cjs .github/workflows/issue-quality-tests.yml
git commit -m "feat(ci): add pure PR ancestry and description quality checks"
```

---

### Task 2: Workflow orchestration (checkout + multi-gate)

**Files:**
- Modify: `.github/workflows/enforce-pr-target.yml`
- Modify: `.github/scripts/enforce-pr-target.test.cjs`

**Interfaces:**
- Consumes: `collectPrQualityFailures` from `pr-quality.cjs`
- Produces: workflow that on any failure drafts (soft-fail) + upserts multi-section comment + `core.setFailed`; on all-clear restores prior bot draft/title state

- [ ] **Step 1: Extend static workflow tests (fail until yml updated)**

Append to `.github/scripts/enforce-pr-target.test.cjs`:

```js
  it("listens for synchronize so rebase can clear ancestry failures", () => {
    assert.match(workflow, /synchronize/);
  });

  it("checks out trusted default-branch scripts only (never PR head)", () => {
    assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
    assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
    assert.match(workflow, /sparse-checkout:\s*\.github\/scripts/);
    assert.match(workflow, /persist-credentials:\s*false/);
    assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
  });

  it("loads pr-quality via require from the checked-out scripts", () => {
    assert.match(workflow, /pr-quality\.cjs/);
    assert.match(workflow, /collectPrQualityFailures/);
  });
```

- [ ] **Step 2: Run static test — expect FAIL**

```bash
node --test .github/scripts/enforce-pr-target.test.cjs
```

Expected: FAIL on new assertions (no synchronize / checkout / pr-quality yet).

- [ ] **Step 3: Rewrite `enforce-pr-target.yml` job steps**

Replace the single-step job with two steps. Keep the existing GraphQL helpers, comment marker, title prefix, and soft-fail draft pattern from #631.

1. Add `synchronize` to `on.pull_request_target.types`.
2. First step: trusted checkout

```yaml
      - name: Checkout trusted PR-quality scripts
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          ref: ${{ github.event.repository.default_branch }}
          persist-credentials: false
          sparse-checkout: .github/scripts
```

3. Second step: `github-script` that:

```js
const path = require("path");
const { collectPrQualityFailures } = require(
  path.join(process.cwd(), ".github", "scripts", "pr-quality.cjs"),
);
```

Then:

- `pulls.get` for live PR (include `body`, `head.sha`, `user.login`, `base.ref`, `draft`, `title`, `node_id`)
- `repos.getCollaboratorPermissionLevel` — on error set `permissionLookupFailed = true` and warn
- If base allowed: `repos.compareCommitsWithBasehead` for `main...${headSha}` and `${base}...${headSha}`; read `behind_by`
- `failures = collectPrQualityFailures({...})`
- If `failures.length > 0`:
  - Upsert one comment listing each failure section (`wrong_base`, `wrong_ancestry`, `bad_description`)
  - Title-prefix **only** when `wrong_base`
  - Soft-fail `convertToDraft` like #631; checkpoint ownership in comment state
  - `core.setFailed(summary)` and return
- If no failures and `storedState?.active`: restore title/ready like #631; success comment
- If no failures and no active state: `core.info` and return

Accept bot comments containing either `<!-- wrong-branch-enforcer -->` or `<!-- pr-quality-enforcer -->` when locating state.

Hidden state keeps `version`, `active`, `autoDraftedByBot`, `titlePrefixedByBot`; may add `ancestryFailed` / `descriptionFailed` booleans.

- [ ] **Step 4: Run static tests — expect PASS**

```bash
node --test .github/scripts/enforce-pr-target.test.cjs .github/scripts/pr-quality.test.cjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/enforce-pr-target.yml .github/scripts/enforce-pr-target.test.cjs
git commit -m "feat(ci): enforce PR ancestry and description in target gate"
```

---

### Task 3: Harness + behavioral CI tests

**Files:**
- Modify: `tests/helpers/enforce-pr-target-harness.ts`
- Modify: `tests/ci-workflows.test.ts`

**Interfaces:**
- Consumes: workflow script that `require`s `pr-quality.cjs` and calls compare/permission APIs
- Produces: harness options for `body`, compare fixtures, permission; scoped `require` for `.github/scripts/*` only

- [ ] **Step 1: Extend harness**

1. Add to `RunOptions`:
   - `authorPermission?: string` (default `"read"`)
   - `failPermissionLookup?: boolean`
   - `compareByBasehead?: Record<string, { ahead_by: number; behind_by: number }>`
2. Ensure `pr.body` and `pr.head.sha` are present on `pulls.get` payload.
3. DEFAULT_PR must include a **passing** description (two rich sections) and default compares that are **not** wrong ancestry (`main...sha` → `behind_by: 5`, `dev...sha` → `behind_by: 0`).
4. Replace `require: forbidden("require")` with a scoped loader:

```ts
import { createRequire } from "node:module";
import path from "node:path";

const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
const scriptsRoot = path.resolve(process.cwd(), ".github", "scripts");

function scopedRequire(id: string) {
  calls.push({ method: "require", args: [id] });
  const resolved = path.isAbsolute(id) ? id : path.resolve(process.cwd(), id);
  if (!resolved.startsWith(scriptsRoot + path.sep) && resolved !== scriptsRoot) {
    // Also allow require of files already under scripts via absolute path from path.join
    const norm = resolved.replace(/\\/g, "/");
    if (!norm.includes("/.github/scripts/")) {
      throw new Error(`the script must not require ${id}`);
    }
  }
  return nodeRequire(resolved);
}
```

5. Record `repos.getCollaboratorPermissionLevel` and `repos.compareCommitsWithBasehead` on the fake github client.

- [ ] **Step 2: Update structural allowlist in `tests/ci-workflows.test.ts`**

- Steps length **2**: checkout then github-script
- Pin checkout SHA `11bd71901bbe5b1630ceea73d27597364c9af683`, default_branch ref, `persist-credentials: false`, sparse `.github/scripts`, no PR head ref
- Types sorted: `edited`, `opened`, `ready_for_review`, `reopened`, `synchronize`
- Keep permissions object unchanged
- Keep “no `${{` in script” assertion on the github-script step only

- [ ] **Step 3: Add behavioral scenarios**

1. **Ancestry fail (#644):** base `dev`, permission `read`, `main...sha` behind 0 / `dev...sha` behind 44, good body → `setFailed`, draft attempted, ancestry in comment, **no** title prefix.
2. **Maintainer ancestry skip:** permission `write`, same compares, good body → no `setFailed`.
3. **Empty description:** good ancestry, `body: ""` → `setFailed` + draft.
4. **Escaped newlines:** body with literal `\\n` → `setFailed`.
5. **Clear after active:** prior bot state `active` + `autoDraftedByBot`, now good → mark ready, no `setFailed`.
6. Existing wrong-base scenarios still pass (title prefix + setFailed); give them a good body so description does not double-fail unless intended.

- [ ] **Step 4: Run focused tests**

```bash
node --test .github/scripts/pr-quality.test.cjs .github/scripts/enforce-pr-target.test.cjs
bun test tests/ci-workflows.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/enforce-pr-target-harness.ts tests/ci-workflows.test.ts
git commit -m "test(ci): cover PR ancestry and description enforcement paths"
```

---

### Task 4: Docs and agent policy notes

**Files:**
- Modify: `docs-site/src/content/docs/contributing.md`
- Modify: `AGENTS.md`
- Modify: `MAINTAINERS.md`

- [ ] **Step 1: Contributing (English)**

Add a short **Pull requests** subsection:

- Target `dev` (or `dev2-go` only for scoped Go work); never open ordinary PRs at `main`.
- Branch from current `dev`, not from `main`. CI rejects heads that sit on the `main` tip while far behind the PR base (the #644 failure mode).
- Include a real description (Summary + Test plan, or equivalent substance). Empty, placeholder-only, or escaped-`\n` bodies fail the required `enforce-target` check.
- Note that `pull_request_target` workflow updates apply after promotion to the repository default branch (same ops caveat as #631).

Do not bulk-edit ja/ko/ru/zh-cn in this task.

- [ ] **Step 2: AGENTS.md / MAINTAINERS.md**

One sentence each: CI rejects main-based ancestry into `dev`/`dev2-go` and empty/thin/malformed PR descriptions; push-permission authors skip the ancestry heuristic only.

- [ ] **Step 3: Commit**

```bash
git add docs-site/src/content/docs/contributing.md AGENTS.md MAINTAINERS.md
git commit -m "docs: document PR ancestry and description quality gates"
```

---

### Task 5: Final validation

- [ ] **Step 1: Run required gates**

```bash
node --test .github/scripts/pr-quality.test.cjs .github/scripts/enforce-pr-target.test.cjs
bun test tests/ci-workflows.test.ts
bun run typecheck
bun run privacy:scan
```

Expected: all PASS.

- [ ] **Step 2: Docs-site build**

```bash
cd docs-site && bun install --frozen-lockfile && bun run build
```

Expected: build succeeds.

- [ ] **Step 3: Diff review**

Confirm no unrelated files; no PR-head checkout; title prefix only on wrong base; description still enforced for maintainers.

---

## Spec coverage checklist

| Spec requirement | Task |
| --- | --- |
| Wrong ancestry rule + threshold 20 | Task 1 |
| Maintainer push escape hatch; fail-closed permission | Task 1–3 |
| Description option 2 | Task 1 |
| Collect all failures; draft + setFailed | Task 2–3 |
| No `[WRONG BRANCH]` for ancestry/description | Task 2–3 |
| `synchronize` trigger | Task 2–3 |
| Trusted checkout only | Task 2–3 |
| Unit + harness + ci-workflows tests | Task 1–3, 5 |
| Contributing + AGENTS/MAINTAINERS | Task 4 |
| Default-branch promotion ops note | Task 4 |

## Placeholder / consistency self-review

- No TBD/TODO left in steps.
- `collectPrQualityFailures` / `assessPrDescription` names consistent across tasks.
- Checkout action SHA matches issue-quality (`11bd7190…`).
- DEFAULT_PR body/compares updated so legacy harness scenarios stay green.
