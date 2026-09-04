import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { providerIconSrc } from "../src/provider-icons";

const PUBLIC_DIR = join(import.meta.dir, "..", "public", "provider-icons");

/**
 * Asset filenames that could plausibly belong to a provider id.
 *
 * A plan variant is a billing arrangement, not a brand -- `alibaba-token-plan`
 * wears the Alibaba mark -- so the first dash-segment is probed too.
 */
function candidateAssets(providerId: string): string[] {
  const stem = providerId.split("-")[0]!;
  return [
    `${providerId}.svg`,
    `${providerId}-color.svg`,
    `${stem}.svg`,
    `${stem}-color.svg`,
  ];
}

/*
 * The gap this exists for, stated plainly: `minimax.svg` was committed for the
 * MiniMax Code CLIENT and the MiniMax PROVIDER kept rendering an initial tile for
 * weeks. Nothing could have told anyone. `CLIENT_MARKS` is keyed by
 * `ExportClientId` and `PROVIDER_ICON_ALIASES` by provider id, so adding artwork
 * on one side leaves no signal on the other, and the fallback tile is a designed
 * state that looks identical to a mistake.
 *
 * This is the only check that closes that loop, and it keeps closing it as new
 * assets land: a mark added for any reason is immediately owed a provider row.
 */
test("a provider whose brand asset is already committed is actually wired to it", () => {
  const files = new Set(readdirSync(PUBLIC_DIR).filter(name => name.endsWith(".svg")));
  const unwired: string[] = [];
  for (const entry of PROVIDER_REGISTRY) {
    if (providerIconSrc(entry.id)) continue;
    const found = candidateAssets(entry.id).find(name => files.has(name));
    if (found) unwired.push(`${entry.id}: ${found} is committed but PROVIDER_ICON_ALIASES has no row`);
  }
  expect(unwired).toEqual([]);
});

/*
 * A mistyped filename renders a broken image, which is strictly worse than the
 * fallback tile it replaced: the tile is deliberate and legible, the broken image
 * is a visual defect. The map is plain strings, so nothing else checks this.
 */
test("every wired provider icon names a file that exists", () => {
  const broken = PROVIDER_REGISTRY
    .map(entry => [entry.id, providerIconSrc(entry.id)] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
    .filter(([, src]) => !existsSync(join(PUBLIC_DIR, src.split("/").pop()!)))
    .map(([id, src]) => `${id} -> ${src}`);
  expect(broken).toEqual([]);
});

/*
 * The four rows this phase added, pinned by intent rather than by count.
 *
 * MiniMax is one brand on two endpoints (`api.minimax.io` and `api.minimaxi.com`),
 * the same shape as the three Alibaba ids that already share one asset. Xiaomi's
 * MiMo ids are the same brand as `mimo-free`, which was already wired -- the
 * inconsistency was the bug.
 */
test("the MiniMax and Xiaomi MiMo provider ids resolve to their brand's mark", () => {
  expect(providerIconSrc("minimax")).toBe("/provider-icons/minimax.svg");
  expect(providerIconSrc("minimax-cn")).toBe("/provider-icons/minimax.svg");
  expect(providerIconSrc("xiaomi-mimo")).toBe("/provider-icons/xiaomi-color.svg");
  expect(providerIconSrc("mimo")).toBe("/provider-icons/xiaomi-color.svg");
  // The precedent that makes the two above consistent rather than novel.
  expect(providerIconSrc("mimo-free")).toBe("/provider-icons/xiaomi-color.svg");
});

/*
 * One brand, two credentials.
 *
 * `meta-model` is Meta's own pay-as-you-go Model API and `meta-muse` imports the
 * Muse Code CLI's credential. They are separate providers with separate billing
 * and separate ToS risk, but they are the same company's mark -- the same shape
 * as the three Alibaba plan ids sharing one asset.
 *
 * Pinned explicitly rather than left to the generic wiring check above, because
 * that check only fires when an asset named after the id is already committed.
 * Neither id is `meta`, so a dropped alias row here would restore the fallback
 * tile silently.
 */
test("both Meta provider ids resolve to the Meta mark", () => {
  expect(providerIconSrc("meta-model")).toBe("/provider-icons/meta.svg");
  expect(providerIconSrc("meta-muse")).toBe("/provider-icons/meta.svg");
});
