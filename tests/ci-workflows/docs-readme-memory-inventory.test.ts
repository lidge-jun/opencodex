/**
 * The README memory inventory restates three counts that live in source, and nothing compared
 * them.
 *
 * The block was written once (`6c14e3433`, 2026-08-13) and never revisited. `usage_snapshot`
 * became the thirteenth retained store the very next day, three more state-store registrations
 * landed after that, and `native_control_replay` became the fourteenth retained store while this
 * guard was still in review, so all eight README files kept advertising 12 and 24 the whole
 * time. Review does not catch this: an English diff of one number looks complete on its own,
 * and the seven translations were copied from a source that was already stale.
 *
 * AGENTS.md calls this class out directly: derive a count from the thing it describes rather
 * than restating it. The three numbers below are derived from the rosters the runtime actually
 * registers, so the next store that lands fails this test in all eight pages at once instead of
 * silently disagreeing with the proxy for months.
 *
 * Each page is anchored by a locale-specific label rather than by the digits, so a reworded
 * sentence fails loudly and asks to be re-anchored. That is the intended behavior: a sentence
 * nobody can locate is a sentence nobody is checking.
 *
 * The opening sentence states no total, and this test holds it that way. The three rosters below
 * it can be summed, but the page also lists stores belonging to no roster, and its last bullet
 * describes a ledger that keeps no process-level RAM index at all, so a single total over
 * "categories of process-retained state" has no source to be derived from. A count that cannot
 * be derived is not stated here.
 *
 * The numbers moved while this guard was written, so the diff that adds it also corrects the
 * documents; the test would otherwise land red.
 *
 * One locale needed a word changed and not only a digit: Russian agrees its numeral with the
 * noun, and `регистрации` was the right genitive for the 24 the page used to claim while
 * `регистраций` is the right one for 28. The anchor here follows the corrected wording, so a
 * page that reverts to the stale number has to revert the inflection too, and this fails.
 *
 * Every Russian anchor carries an inflection its numeral governs, not only the state-store one:
 * `удерживаемых хранилищ`, `наблюдаемых буфера` and `регистраций` each change form with the
 * count. A future count that moves one of them stops this check matching and fails it, asking
 * for a re-anchor. That is the designed outcome. The alternative — a pattern loose enough to
 * match any noun form — would accept a sentence nobody re-read, which is the failure this guard
 * exists to prevent.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  APP_OWNED_OBSERVED_BUFFER_REGISTRATIONS,
  APP_OWNED_RETAINED_STORE_REGISTRATIONS,
} from "../../src/lib/app-owned-memory-stores";
import { STATE_STORE_REGISTRATIONS } from "../../src/lib/state-store-registrations";
import { repoPath } from "../helpers/repo-root";

const RETAINED = APP_OWNED_RETAINED_STORE_REGISTRATIONS.length;
const OBSERVED = APP_OWNED_OBSERVED_BUFFER_REGISTRATIONS.length;
const STATE_STORES = STATE_STORE_REGISTRATIONS.length;

/**
 * One README, the three counts it states, and the sentence that must carry no count.
 *
 * Each claim captures the number it states instead of merely searching for the derived value:
 * `toContain("4")` would pass on the `60 s interval` further down the same bullet, which is the
 * one place in this block where a second number sits close enough to be mistaken for the claim.
 */
const PAGES = [
  {
    locale: "en",
    path: "README.md",
    retained: /(\d+) retained stores/,
    observed: /(\d+) observed buffers/,
    stateStores: /(\d+) state-store registrations/,
    totalSentence: "process-retained state",
  },
  {
    locale: "fr",
    path: "readme/README.fr.md",
    retained: /(\d+) stockages conservés/,
    observed: /(\d+) tampons observés/,
    stateStores: /(\d+) enregistrements de stockages/,
    totalSentence: "état conservé par le processus",
  },
  {
    locale: "ja",
    path: "readme/README.ja.md",
    retained: /保持ストア (\d+) 個/,
    observed: /観測バッファ (\d+) 個/,
    stateStores: /state-store の登録 (\d+) 個/,
    totalSentence: "プロセスが保持する状態を",
  },
  {
    locale: "ko",
    path: "readme/README.ko.md",
    retained: /유지 저장소 (\d+)개/,
    observed: /관측 버퍼 (\d+)개/,
    stateStores: /state-store 등록 (\d+)개/,
    totalSentence: "프로세스가 붙잡고 있는 상태를",
  },
  {
    locale: "ru",
    path: "readme/README.ru.md",
    retained: /(\d+) удерживаемых хранилищ/,
    observed: /(\d+) наблюдаемых буфера/,
    stateStores: /(\d+) регистраций state-store/,
    totalSentence: "удерживаемое процессом",
  },
  {
    locale: "tr",
    path: "readme/README.tr.md",
    retained: /(\d+) tutulan depo/,
    observed: /(\d+) gözlenen arabellek/,
    stateStores: /(\d+) state-store kaydı/,
    totalSentence: "süreçte tutulan durumu",
  },
  {
    locale: "zh-CN",
    path: "readme/README.zh-CN.md",
    retained: /(\d+) 个保留存储/,
    observed: /(\d+) 个观测缓冲区/,
    stateStores: /(\d+) 个状态存储注册/,
    totalSentence: "进程保留状态",
  },
  {
    locale: "zh-TW",
    path: "readme/README.zh-TW.md",
    retained: /(\d+) 個保留儲存/,
    observed: /(\d+) 個觀測緩衝區/,
    stateStores: /(\d+) 個狀態儲存註冊/,
    totalSentence: "行程保留狀態",
  },
] as const;

/**
 * The number one page states for one claim.
 *
 * Exactly one occurrence is required. A page that states the count twice has two places to
 * update and this check only sees one of them, so the second is a silent drift waiting to
 * happen; a page that states it zero times has been reworded past the anchor.
 */
function statedOnce(path: string, claim: RegExp): number {
  const hits = [...readFileSync(repoPath(path), "utf8").matchAll(new RegExp(claim, "g"))];
  expect(hits.length, `${path} states this count ${hits.length} times; re-anchor this check`).toBe(1);
  return Number(hits[0]![1]);
}

/** The single line carrying `anchor`, which is the line a claim is required to sit on. */
function anchoredLine(path: string, anchor: string): string {
  const lines = readFileSync(repoPath(path), "utf8")
    .split("\n")
    .filter(line => line.includes(anchor));
  expect(lines.length, `${path} has no line containing "${anchor}"; re-anchor this check`).toBe(1);
  return lines[0]!;
}

describe("documented memory inventory counts match the registered rosters", () => {
  test("the rosters are the only source of the numbers under test", () => {
    // A derived count that collapsed to zero would make every assertion below vacuous.
    expect(RETAINED).toBeGreaterThan(0);
    expect(OBSERVED).toBeGreaterThan(0);
    expect(STATE_STORES).toBeGreaterThan(0);
  });

  for (const page of PAGES) {
    test(`${page.locale} README states ${RETAINED} retained stores`, () => {
      expect(statedOnce(page.path, page.retained)).toBe(RETAINED);
    });

    test(`${page.locale} README states ${OBSERVED} observed buffers`, () => {
      expect(statedOnce(page.path, page.observed)).toBe(OBSERVED);
    });

    test(`${page.locale} README states ${STATE_STORES} state-store registrations`, () => {
      expect(statedOnce(page.path, page.stateStores)).toBe(STATE_STORES);
    });

    test(`${page.locale} README states no total it cannot derive`, () => {
      const line = anchoredLine(page.path, page.totalSentence);
      expect(line, `${page.path} states a total; derive it from a roster or drop it`).not.toMatch(/[0-9]/);
    });
  }
});
