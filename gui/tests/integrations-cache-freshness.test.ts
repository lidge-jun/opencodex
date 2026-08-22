import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The Integrations surfaces MIRROR state that other pages own and mutate: the overview
 * card and the per-client page describe the same connection through different cache
 * keys. Giving them a staleness window meant a toggle on one could be contradicted by
 * a cached read on the other for up to a minute, with no request in flight to correct
 * it — a revisit is exactly when the user looks. They may seed from cache (so a revisit
 * paints instead of flashing a skeleton) but must always revalidate.
 */
const MIRROR_SURFACES = [
  "src/pages/integrations/IntegrationsOverview.tsx",
  "src/pages/integrations/FileIntegrationPage.tsx",
];

test("integration mirror surfaces seed from cache but never suppress revalidation", () => {
  for (const path of MIRROR_SURFACES) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    expect(source).toContain("sessionCacheKey");
    expect(source).not.toContain("staleAfterMs");
  }
});

/**
 * The pages that OWN their truth keep the window: nothing else writes their state
 * behind their back, so a revisit inside it is genuinely up to date.
 */
test("self-owned surfaces keep their staleness window", () => {
  for (const path of ["src/pages/Combos.tsx", "src/pages/ApiKeys.tsx", "src/pages/Grok.tsx"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    expect(source).toContain("staleAfterMs");
  }
});
