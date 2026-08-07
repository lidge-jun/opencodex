import { describe, expect, test } from "bun:test";
import {
  PUBLIC_MODEL_PREVIEW_PLACEHOLDER,
  canCopyPublicModelId,
} from "../gui/src/combo-public-model";

describe("public model preview copy guard", () => {
  test("rejects empty and the draft placeholder", () => {
    expect(canCopyPublicModelId("")).toBe(false);
    expect(canCopyPublicModelId("   ")).toBe(false);
    expect(canCopyPublicModelId(PUBLIC_MODEL_PREVIEW_PLACEHOLDER)).toBe(false);
  });

  test("allows real client-facing model ids", () => {
    expect(canCopyPublicModelId("combo/main")).toBe(true);
    expect(canCopyPublicModelId("team/balanced")).toBe(true);
  });
});
