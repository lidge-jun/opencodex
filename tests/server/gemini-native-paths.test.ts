import { describe, expect, test } from "bun:test";
import { geminiRouteAllows, isGeminiBodyPath, isGeminiGenerationPath, isGeminiNativePath, parseGeminiNativePath } from "../../src/server/gemini-native-paths";

describe("Gemini native path classifier: Interactions", () => {
  test("create is POST on /v1beta/interactions and the stable /v1/interactions", () => {
    for (const path of ["/v1beta/interactions", "/v1/interactions"]) {
      expect(parseGeminiNativePath(path)).toEqual({ kind: "interactions", httpMethod: "POST" });
      // Raised-body admission and the package-tree fence key on these predicates.
      expect(isGeminiGenerationPath(path)).toBe(true);
      expect(isGeminiNativePath(path)).toBe(true);
    }
  });

  test("stored-interaction paths answer GET and DELETE; cancel answers POST", () => {
    for (const prefix of ["/v1beta", "/v1"]) {
      const item = parseGeminiNativePath(prefix + "/interactions/ocx-int-0a1b");
      expect(item).toEqual({ kind: "interaction", httpMethod: "GET", allow: ["GET", "DELETE"], id: "ocx-int-0a1b" });
      expect(geminiRouteAllows(item!, "GET")).toBe(true);
      expect(geminiRouteAllows(item!, "DELETE")).toBe(true);
      expect(geminiRouteAllows(item!, "POST")).toBe(false);
      expect(isGeminiGenerationPath(prefix + "/interactions/ocx-int-0a1b")).toBe(false);
      const cancel = parseGeminiNativePath(prefix + "/interactions/ocx-int-0a1b/cancel");
      expect(cancel).toEqual({ kind: "interaction-cancel", httpMethod: "POST", id: "ocx-int-0a1b" });
      expect(geminiRouteAllows(cancel!, "POST")).toBe(true);
      expect(geminiRouteAllows(cancel!, "GET")).toBe(false);
    }
  });

  test("near misses are not native paths", () => {
    for (const path of [
      "/v1beta/interactions/", "/v1beta/interactionsX", "/v1/interactionsX", "/v1beta/interactions/a/b",
      "/v1beta/interactions/a%2Fb", "/v1beta/interactions/" + "x".repeat(129), "/v1beta/interactions/a/cancel/x",
      "/v2/interactions", "/api/interactions",
    ]) expect(isGeminiNativePath(path)).toBe(false);
  });

  test("existing classifications are unchanged", () => {
    expect(parseGeminiNativePath("/v1beta/models")).toEqual({ kind: "models", httpMethod: "GET" });
    expect(parseGeminiNativePath("/v1/models")).toBeUndefined();
    expect(parseGeminiNativePath("/v1/models/fx%2Fm1:generateContent")).toEqual({ kind: "method", httpMethod: "POST", model: "fx/m1", method: "generateContent" });
    expect(geminiRouteAllows(parseGeminiNativePath("/v1beta/models")!, "GET")).toBe(true);
    expect(geminiRouteAllows(parseGeminiNativePath("/v1beta/models")!, "POST")).toBe(false);
  });
});

describe("Gemini native path classifier: body admission", () => {
  test("generation, Interactions create and countTokens read a body under the shared allowance", () => {
    for (const path of ["/v1beta/models/p/m:generateContent", "/v1/models/p/m:streamGenerateContent", "/v1beta/interactions", "/v1beta/models/p/m:countTokens"]) {
      expect(isGeminiBodyPath(path)).toBe(true);
    }
    // countTokens reads a body but is not generation: it takes no turn slot and no request timeout override.
    expect(isGeminiGenerationPath("/v1beta/models/p/m:countTokens")).toBe(false);
    for (const path of ["/v1beta/models", "/v1beta/models/p/m", "/v1beta/models/p/m:embedContent", "/v1beta/interactions/ocx-int-0a1b"]) {
      expect(isGeminiBodyPath(path)).toBe(false);
    }
  });
});
