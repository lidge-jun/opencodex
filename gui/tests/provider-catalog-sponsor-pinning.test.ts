import { expect, test } from "bun:test";
import { pinSponsors, type CatalogPreset } from "../src/components/provider-catalog/provider-presets";

/**
 * SPONSORS.md promises a Standard sponsor "a built-in preset near the top of the provider
 * picker". This is the function that keeps that promise, and the two properties that make
 * it honest: sponsors come first in an order no sponsor can buy (Main before Standard, then
 * alphabetical), and everything after them keeps the caller's usage/label order untouched.
 */

const row = (id: string, label: string, sponsor?: CatalogPreset["sponsor"]): CatalogPreset => ({
  id, label, adapter: "openai-chat", baseUrl: `https://${id}.example/v1`, auth: "key",
  ...(sponsor ? { sponsor, sponsorUrl: `https://${id}.example/?utm_source=opencodex` } : {}),
});

test("sponsors are pinned first, Main before Standard, alphabetical within a tier", () => {
  const input = [
    row("zeta", "Zeta"),
    row("packycode", "PackyCode", "standard"),
    row("alpha", "Alpha"),
    row("orcarouter", "OrcaRouter", "standard"),
    row("moon", "Moon Labs", "main"),
  ];
  expect(pinSponsors(input).map(p => p.id)).toEqual(["moon", "orcarouter", "packycode", "zeta", "alpha"]);
});

test("alphabetical among sponsors ignores registry position and case", () => {
  // Ids run z, y, x against labels bravo, ALPHA, charlie: sorting by id instead of label fails here.
  const input = [row("z", "bravo", "standard"), row("y", "ALPHA", "standard"), row("x", "charlie", "standard")];
  expect(pinSponsors(input).map(p => p.id)).toEqual(["y", "z", "x"]);
});

test("with no sponsors the input order is returned as-is", () => {
  const input = [row("zeta", "Zeta"), row("alpha", "Alpha")];
  expect(pinSponsors(input)).toBe(input);
});
