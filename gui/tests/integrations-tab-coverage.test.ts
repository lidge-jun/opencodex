import { expect, test } from "bun:test";
import { FILE_CLIENTS, TABS } from "../src/pages/integrations/integration-tabs";
import { FILE_INTEGRATION_CLIENTS } from "../src/pages/integrations/integration-api";
import { INTEGRATION_TAB_HASHES } from "../src/app-routing";

/*
 * The gap this closes.
 *
 * tests/integrations-invariants.test.ts compares five client lists, and the
 * per-page label maps are Record<FileIntegrationClientId, TKey> so the compiler
 * forces those. TABS and FILE_CLIENTS are neither: they are a plain array and a
 * plain Set, so a client added everywhere else still gets no tab and nothing
 * fails. Aside was the twelfth client to walk this path, and the first with a
 * test standing in it.
 *
 * The expectation is DERIVED rather than written out, so adding client thirteen
 * cannot leave a stale literal here that passes by accident.
 */
test("every file client has a tab definition and is registered as a file client", () => {
  const tabbed = new Set(TABS.map(tab => tab.id));
  const missingTab = FILE_INTEGRATION_CLIENTS.filter(id => !tabbed.has(id));
  expect(missingTab).toEqual([]);

  const missingFileClient = FILE_INTEGRATION_CLIENTS.filter(id => !FILE_CLIENTS.has(id));
  expect(missingFileClient).toEqual([]);
});

test("every tab hash is routable, so a tab can actually be reached", () => {
  // App normalization strips an unregistered hash, which would render the
  // overview instead of the tab and look like a missing client.
  const routable = new Set<string>(INTEGRATION_TAB_HASHES);
  const unroutable = TABS.filter(tab => tab.hash !== "integrations" && !routable.has(tab.hash));
  expect(unroutable.map(tab => tab.hash)).toEqual([]);
});

test("FILE_CLIENTS carries no id the API does not know", () => {
  const known = new Set<string>(FILE_INTEGRATION_CLIENTS);
  expect([...FILE_CLIENTS].filter(id => !known.has(id))).toEqual([]);
});
