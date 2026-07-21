import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
let warn: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  warn?.mockRestore();
  warn = undefined;
});

function vertexProvider(name: string): OcxConfig {
  return {
    providers: {
      [name]: {
        adapter: "google",
        googleMode: "vertex",
        baseUrl: "https://aiplatform.googleapis.com",
        apiKey: "test-key",
        models: ["publisher-model-a"],
      },
    },
  };
}

describe("Vertex catalog configuration", () => {
  test("models + liveModels false exposes configured Vertex ids without discovery", async () => {
    globalThis.fetch = (() => { throw new Error("must not fetch"); }) as typeof fetch;
    const config = vertexProvider("vertex-static");
    config.providers["vertex-static"]!.liveModels = false;
    const rows = await gatherRoutedModels(config);
    expect(rows).toContainEqual(expect.objectContaining({
      provider: "vertex-static",
      id: "publisher-model-a",
    }));
  });

  test("non-2xx diagnostic identifies provider, URL class, and configured fallback", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (() => Promise.resolve(new Response("missing", { status: 404 }))) as typeof fetch;
    await gatherRoutedModels(vertexProvider("vertex-http"));
    expect(warn.mock.calls.flat().join(" ")).toContain(
      'Provider model discovery for "vertex-http" failed with HTTP 404 [urlClass=vertex-aiplatform, fallback=configured]',
    );
  });

  test("exception diagnostic identifies provider, URL class, and configured fallback", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (() => { throw new TypeError("offline"); }) as typeof fetch;
    await gatherRoutedModels(vertexProvider("vertex-throw"));
    expect(warn.mock.calls.flat().join(" ")).toContain(
      'Provider model discovery for "vertex-throw" threw TypeError [urlClass=vertex-aiplatform, fallback=configured]',
    );
  });
});
