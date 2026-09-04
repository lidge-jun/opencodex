/**
 * Where the Codex Set account actions live.
 *
 * "한도 도달 계정 일시 중지" and "할당량 새로고침" used to sit in the page head beside the
 * title and the Spark toggle — four controls and a heading on one row, with the actions
 * far above the account cards they operate on. They render in their own row below the
 * account-mode banner now.
 *
 * The embedded surface is deliberately excluded: in the Providers workspace the same
 * component renders a bare `.row` with no title, so there is nothing to crowd and the
 * buttons stay inline.
 */
import { expect, test } from "bun:test";

const raw = await Bun.file(new URL("../src/components/codex-account-pool-main-card.tsx", import.meta.url)).text();
// Comments name these controls; matching prose is not evidence about code.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const pool = (await Bun.file(new URL("../src/components/CodexAccountPool.tsx", import.meta.url)).text())
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

const headStart = src.indexOf("export function CodexAccountPoolPageHead");
const head = src.slice(headStart, src.indexOf("export function CodexAccountPoolActionButtons", headStart));

test("the standalone page head no longer renders the two action buttons inline", () => {
  // The head keeps the title, the feedback region and the Spark toggle; the pause and
  // refresh labels are reached through the shared component only.
  expect(head).not.toContain('t("codexAuth.pauseExhausted")');
  expect(head).not.toContain('t("codexAuth.refreshQuota")');
});

test("the embedded surface keeps them inline, because it has no title row to crowd", () => {
  expect(head).toContain("embedded && (");
  expect(head).toContain("CodexAccountPoolActionButtons");
});

test("the standalone page renders them in their own row instead", () => {
  expect(pool).toContain("!embedded && (");
  expect(pool).toContain("CodexAccountPoolActions");
});

test("both buttons still exist and keep their disabled contract", () => {
  const shared = src.slice(src.indexOf("export function CodexAccountPoolActionButtons"));
  expect(shared).toContain('t("codexAuth.pauseExhausted")');
  expect(shared).toContain('t("codexAuth.refreshQuota")');
  // A refresh in flight must not let a second pause/refresh start beside it.
  expect(shared.match(/disabled=\{refreshingQuota \|\| pausingExhausted \|\| !!pauseBusy\}/g)?.length).toBe(2);
});

test("the head classes the CSS tests pin are still rendered", () => {
  // codex-set-page-head-wrap.test.ts throws "rule not found" if these disappear, and the
  // toast-tone suite queries the feedback span by class.
  expect(head).toContain("page-head codex-auth-page-head");
  expect(head).toContain("codex-auth-page-head__actions");
  expect(head).toContain("codex-auth-page-head__feedback");
});

test("the relocated row has a layout rule that wraps", () => {
  const start = css.indexOf(".codex-auth-actions-row {");
  expect(start).toBeGreaterThan(-1);
  const rule = css.slice(start, css.indexOf("}", start));
  expect(rule).toContain("flex-wrap: wrap");
  expect(rule).toContain("justify-content: flex-end");
});
