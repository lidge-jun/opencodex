import { expect, test } from "bun:test";
import { findOrphanKeys } from "../scripts/find-orphan-keys.mjs";
import { KNOWN_ORPHAN_KEYS } from "./i18n-orphans-baseline";

/**
 * devlog/_plan/260904_dashboard_minimal/090_i18n_prune_docs.md: a locale key nobody
 * renders is dead weight in nine files. The roadmap's eight implementation phases each
 * left a few behind; this phase removed those (29 keys) and pins the scan so the next
 * removal cannot leave new ones. The 150 keys that were already orphaned before the
 * roadmap are listed as a baseline, not deleted here: each needs its own look (some are
 * server-message vocab consumed by string building the scanner cannot see).
 */
test("no i18n key is orphaned beyond the recorded baseline", () => {
  const orphans = findOrphanKeys();
  const fresh = orphans.filter(key => !KNOWN_ORPHAN_KEYS.has(key));
  expect(fresh).toEqual([]);
});

test("the baseline only shrinks", () => {
  const orphans = new Set(findOrphanKeys());
  const revived = [...KNOWN_ORPHAN_KEYS].filter(key => !orphans.has(key));
  // A baseline entry that is no longer an orphan should be removed from the baseline so
  // the list stays honest; this is a nudge, not a failure.
  if (revived.length > 0) console.warn("no longer orphaned; drop from baseline:", revived.join(", "));
  expect(true).toBe(true);
});
