import { describe, expect, test } from "bun:test";
import { modelInList } from "../src/types";

describe("modelInList", () => {
  test("matches exact ids", () => {
    expect(modelInList(["glm-5.2", "auto"], "glm-5.2")).toBe(true);
    expect(modelInList(["glm-5.2"], "grok-4.5")).toBe(false);
  });

  test("matches Ollama-style :size family tags", () => {
    expect(modelInList(["gpt-oss"], "gpt-oss:120b")).toBe(true);
    expect(modelInList(["gpt-oss"], "gpt-oss")).toBe(true);
  });

  test("matches trailing-* prefix entries", () => {
    expect(modelInList(["composer-*"], "composer-1")).toBe(true);
    expect(modelInList(["composer-*"], "composer-2.5")).toBe(true);
    expect(modelInList(["composer-*"], "composer-2.5-fast")).toBe(true);
    expect(modelInList(["composer-*"], "composer-9-future")).toBe(true);
    expect(modelInList(["composer-*"], "grok-composer-2.5-fast")).toBe(false);
    expect(modelInList(["*"], "anything")).toBe(false);
  });
});
