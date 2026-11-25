import { expect, test } from "bun:test";
import { buildVideoTool } from "../../src/images/synthetic-tool";

function properties(model: string): Record<string, any> {
  return (buildVideoTool(model).parameters as any).properties;
}

test("video tools expose only supported model capabilities", () => {
  const full = properties("grok-imagine-video-1.5");
  expect(full.resolution.enum).toContain("1080p");
  expect(full.aspect_ratio.enum).toContain("21:9");
  expect(full.keyframes.maxItems).toBe(4);
  expect(full.reference_images.maxItems).toBe(14);
  expect(full.last_frame).toBeDefined();
  const lite = properties("grok-imagine-video-1.5-lite");
  expect(lite.image).toBeDefined();
  expect(lite.last_frame).toBeUndefined();
  expect(properties("grok-imagine-video").reference_images.maxItems).toBe(7);
  const other = properties("custom");
  expect(other.resolution.enum).toEqual(["480p", "720p"]);
  expect(other.aspect_ratio.enum).toHaveLength(7);
  expect(other.image).toBeUndefined();
});
