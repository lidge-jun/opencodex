import { describe, expect, test } from "bun:test";
import {
  buildClientConfig,
  OPENCODE_PROVIDER_ID,
  type ExportContext,
  type ExportModel,
  type GajaeGeneratedConfig,
  type HermesGeneratedConfig,
  type PiGeneratedConfig,
} from "../src/clients/config-export";
import type { OcxConfig } from "../src/types";

/**
 * Sibling of catalog-input-modality-enum.test.ts, whose incident this repeats
 * at a different boundary.
 *
 * Our internal modality vocabulary is text|image|audio. Pi and Gajae accept only
 * text|image, and BOTH reject the whole config over one out-of-enum value —
 * Gajae falls back to its built-in list, Pi returns an empty model config. This
 * actually happened: zenmux advertises audio on meta-muse-spark-1.1, we wrote it
 * through verbatim, and gjc reported
 * `/providers/opencodex/models/30/input/2: Invalid option: expected one of
 * "text"|"image"` while showing none of the routed models.
 *
 * The per-entry tests in client-config-export.test.ts all passed while that file
 * was broken, which is why the whole-catalog assertion at the bottom exists.
 */

const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as unknown as OcxConfig;

function ctx(models: ExportModel[]): ExportContext {
  return { baseUrl: "http://127.0.0.1:10100/v1", models, config: CONFIG };
}

function piModels(models: ExportModel[]) {
  return (buildClientConfig("pi", ctx(models)) as PiGeneratedConfig)
    .providers[OPENCODE_PROVIDER_ID].models;
}

function gajaeModels(models: ExportModel[]) {
  return (buildClientConfig("gajae", ctx(models)) as GajaeGeneratedConfig)
    .providers[OPENCODE_PROVIDER_ID].models;
}

function hermesModels(models: ExportModel[]) {
  return (buildClientConfig("hermes", ctx(models)) as HermesGeneratedConfig)
    .providers[OPENCODE_PROVIDER_ID].models;
}

/** The live failure, by its real id and real modality list. */
const MIXED: ExportModel = {
  namespaced: "zenmux/meta-muse-spark-1.1",
  provider: "zenmux",
  id: "meta-muse-spark-1.1",
  contextWindow: 1_048_576,
  inputModalities: ["text", "image", "audio"],
};

/**
 * Reachable three ways: `ocx models add --modalities audio` (src/cli/models.ts),
 * POST /api/custom-models (model-routes.ts ALLOWED_INPUT_MODALITIES), and
 * provider discovery returning an audio-only list.
 */
const AUDIO_ONLY: ExportModel = {
  namespaced: "p/audio-only",
  provider: "p",
  id: "audio-only",
  inputModalities: ["audio"],
};

describe("exported modalities stay inside the enum each client accepts", () => {
  test("Hermes receives only catalog-backed vision booleans", () => {
    const bare: ExportModel = { namespaced: "p/bare", provider: "p", id: "bare" };
    const empty: ExportModel = { ...bare, namespaced: "p/empty", id: "empty", inputModalities: [] };
    expect(hermesModels([MIXED, AUDIO_ONLY, bare, empty])).toEqual({
      "zenmux/meta-muse-spark-1.1": { supports_vision: true },
      "p/audio-only": { supports_vision: false },
      "p/bare": {},
      "p/empty": {},
    });
  });

  test("audio is dropped from a mixed Gajae entry rather than written through", () => {
    expect(gajaeModels([MIXED])[0]?.input).toEqual(["text", "image"]);
  });

  test("the same holds for Pi, whose exposure was latent only because its file was empty", () => {
    expect(piModels([MIXED])[0]?.input).toEqual(["text", "image"]);
  });

  test("a model with NO acceptable modality is omitted, never rewritten to text", () => {
    // Claiming text would advertise a capability the model does not have, and it
    // would fail at call time with no explanation. Losing the row is the lesser
    // cost — and unlike a fabricated modality, it is visible.
    expect(gajaeModels([AUDIO_ONLY])).toEqual([]);
    expect(piModels([AUDIO_ONLY])).toEqual([]);
  });

  test("an undeclared modality list still yields text — unknown is not incompatible", () => {
    // Every routed model takes prompts, so text is the honest floor here. This
    // branch is also what keeps the byte-exact goldens stable.
    const bare: ExportModel = { namespaced: "p/bare", provider: "p", id: "bare" };
    expect(gajaeModels([bare])[0]?.input).toEqual(["text"]);
    expect(piModels([bare])[0]?.input).toEqual(["text"]);
    const empty: ExportModel = { ...bare, namespaced: "p/empty", id: "empty", inputModalities: [] };
    expect(gajaeModels([empty])[0]?.input).toEqual(["text"]);
  });

  test("an already-acceptable list survives untouched", () => {
    const vision: ExportModel = {
      namespaced: "p/vision", provider: "p", id: "vision", inputModalities: ["text", "image"],
    };
    expect(gajaeModels([vision])[0]?.input).toEqual(["text", "image"]);
    expect(piModels([vision])[0]?.input).toEqual(["text", "image"]);
  });

  test("order is preserved and duplicates collapse", () => {
    const dup: ExportModel = {
      namespaced: "p/dup", provider: "p", id: "dup", inputModalities: ["image", "text", "image"],
    };
    expect(gajaeModels([dup])[0]?.input).toEqual(["image", "text"]);
  });

  test("no emitted entry in a whole catalog carries a value its client rejects", () => {
    // The assertion that would have caught the live bug: every per-entry test
    // above can pass while one model in a real catalog still poisons the file.
    const catalog: ExportModel[] = [
      MIXED,
      AUDIO_ONLY,
      { namespaced: "p/bare", provider: "p", id: "bare" },
      { namespaced: "p/vision", provider: "p", id: "vision", inputModalities: ["text", "image"] },
    ];
    for (const models of [gajaeModels(catalog), piModels(catalog)]) {
      expect(models.length).toBe(3);
      for (const entry of models) {
        for (const value of entry.input) {
          expect(["text", "image"]).toContain(value);
        }
      }
      // And the incompatible one is gone rather than silently retyped.
      expect(models.map(m => m.id)).not.toContain("p/audio-only");
    }
  });
});
