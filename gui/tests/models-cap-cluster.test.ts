import { expect, test } from "bun:test";
import { effectiveDeclaration, withoutComments } from "./helpers/css-declarations";

/**
 * WP3 (devlog/_fin/260830_models_provider_header/040_cap_cluster_and_occupied_slot.md).
 *
 * The defect the user actually reported: openai showed a 1.05M cap value and
 * anthropic showed nothing, because the cap Select was rendered only when the cap
 * was on. Two cards therefore started their control row at different left edges.
 * The slot is now always occupied — disabled with its value when the cap is off,
 * which is an honest rendering of "no opinion".
 */

const readPage = () => Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
const readCss = async () => withoutComments(await Bun.file(new URL("../src/styles-models-workspace.css", import.meta.url)).text());

test("the cap Select is no longer conditional on the cap being on", async () => {
  const page = await readPage();

  // The guard that caused the reported misalignment.
  expect(page).not.toContain("{(capOn || nativeProviderGroup) && (");

  // Occupancy without inertness would be a lie: the control must still refuse input
  // while the cap is off.
  expect(page).toContain("disabled={busy || !capOn}");
});

/**
 * Found by the independent audit. `providerCapCustomOpen` is per-provider state that
 * nothing clears when the cap is switched off. While the Select disappeared with the
 * cap this was unreachable for routed providers; always-rendering it would have left
 * the custom input and its Apply button standing under an off cluster — and Apply
 * sends `enabled: true`, so the field would silently turn the cap back on.
 */
test("the custom-cap editor cannot outlive the cap being switched off", async () => {
  const page = await readPage();
  expect(page).toContain("{capOn && providerCapCustomOpen[provider] && (");
});

test("the cap trio is one visual cluster that can wrap", async () => {
  const css = await readCss();

  // Tighter than the row own var(--space-2): that difference is what makes the trio
  // read as one control rather than three peers.
  expect(effectiveDeclaration(css, ".models-cap-cluster", "gap")).toBe("var(--space-1)");
  expect(effectiveDeclaration(css, ".models-provider-actions", "gap")).toBe("var(--space-2)");

  // Load-bearing: the cluster is one flex item of a wrapping row and its children do
  // not shrink, so a nowrap cluster would overflow into .models-provider-card own
  // overflow: hidden and be clipped silently.
  expect(effectiveDeclaration(css, ".models-cap-cluster", "flex-wrap")).toBe("wrap");

  // A min-width floor here would be the child-floor design 011 rejected.
  expect(() => effectiveDeclaration(css, ".models-cap-cluster", "min-width")).toThrow();
});

test("grouping did not become a functional merge", async () => {
  const page = await readPage();
  const start = page.indexOf('<div className="models-cap-cluster">');
  expect(start).toBeGreaterThan(-1);
  const cluster = page.slice(start, page.indexOf("</div>", start));

  // Three separate controls, three tab stops. The per-model button opens a different
  // SCOPE than the provider-wide switch and select, so collapsing them would be a
  // lie about what the surface does.
  expect(cluster).toContain("on={capOn}");
  expect(cluster).toContain("onChange={v => onSelectProviderCap(provider, v)}");
  expect(cluster).toContain('t("models.contextSettings")');
});
