import { describe, expect, test } from "bun:test";
import { isImageGenName, extractHostedImageGeneration, buildImageTool } from "../../src/images/synthetic-tool";

describe("isImageGenName", () => {
  test("'image_gen' → true", () => {
    expect(isImageGenName("image_gen")).toBe(true);
  });

  test("'IMAGE_GENERATION' → true (case insensitive)", () => {
    expect(isImageGenName("IMAGE_GENERATION")).toBe(true);
  });

  test("'imagegen' → true", () => {
    expect(isImageGenName("imagegen")).toBe(true);
  });

  test("'not_image' → false", () => {
    expect(isImageGenName("not_image")).toBe(false);
  });
});

describe("extractHostedImageGeneration", () => {
  test("type 'image_generation' → returns toolNames with that name", () => {
    const result = extractHostedImageGeneration([{ type: "image_generation" }]);
    expect(result).toBeDefined();
    expect(result!.toolNames.has("image_generation")).toBe(true);
  });

  test("function tool with 'image_gen' name → returns with that name", () => {
    const result = extractHostedImageGeneration([
      { type: "function", function: { name: "image_gen" } },
    ]);
    expect(result).toBeDefined();
    expect(result!.toolNames.has("image_gen")).toBe(true);
  });

  test("no matching tools → undefined", () => {
    expect(
      extractHostedImageGeneration([{ type: "function", function: { name: "shell" } }]),
    ).toBeUndefined();
  });

  test("undefined → undefined", () => {
    expect(extractHostedImageGeneration(undefined)).toBeUndefined();
  });
});

describe("buildImageTool", () => {
  test("has name 'image_gen' and imageGeneration flag", () => {
    const tool = buildImageTool();
    expect(tool.name).toBe("image_gen");
    expect(tool.imageGeneration).toBe(true);
  });
});
