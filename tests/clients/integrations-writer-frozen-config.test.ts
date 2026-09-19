import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegrationCoordinated } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * A coordinated write plans from its input, awaits the writer lock and a revalidation, and only
 * then serializes the document. Everything else it resolves is frozen before that await, and the
 * configuration was the one thing still held by reference: an edit landing in the window meant the
 * plan that authorized the write and the document it produced described different configurations.
 */
let home: string;
let store: IntegrationStateStore;
const TEST_ENV = {} as NodeJS.ProcessEnv;

const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
];

const CHECKED_HOST = "127.0.0.1";
const LATER_HOST = "10.11.12.13";

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "ocx-writer-frozen-config-"));
  home = join(base, "home");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(join(base, "store", "integrations"));
});

afterEach(() => {
  removeTreeWithRetry(dirname(home));
});

function installHermes(): string {
  const spec = INTEGRATION_CLIENTS.hermes;
  mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec.configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

test("the configuration a coordinated write checked is the one it writes", async () => {
  const configPath = installHermes();
  const config = {
    port: 10100,
    hostname: CHECKED_HOST,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
  } as unknown as OcxConfig;

  let edited = false;
  const result = await applyIntegrationCoordinated(
    { clientId: "hermes", models: MODELS, config, port: 10100, store, env: TEST_ENV, home },
    {
      revalidate: async () => {
        // The revalidation has just agreed that this write may proceed. A management route editing
        // the live configuration here is the whole hazard: it is after the check and before the
        // document exists.
        config.hostname = LATER_HOST;
        edited = true;
        return null;
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(edited).toBe(true);
  const written = readFileSync(configPath, "utf8");
  // The document describes the configuration the check passed on. Holding the caller's object
  // would have serialized the edit instead, with the plan still vouching for the other one. The
  // port form is asserted rather than the checked host itself because a loopback hostname is
  // normalized on the way into a client document, while the edited one would arrive verbatim.
  expect(written).toContain(":10100/v1");
  expect(written).not.toContain(LATER_HOST);
  // And the edit itself is untouched: freezing the input is not an excuse to write it back.
  expect(config.hostname).toBe(LATER_HOST);
});
