import { expect, test } from "bun:test";
import {
  DEFAULT_MAX_DESCRIPTIONS_PER_TURN,
  DEFAULT_VISION_TIMEOUT_MS,
  MAX_VISION_TIMEOUT_MS,
  MIN_VISION_TIMEOUT_MS,
} from "../src/vision";
import {
  VISION_MAX_DESCRIPTIONS_DEFAULT,
  VISION_TIMEOUT_MS_DEFAULT,
  VISION_TIMEOUT_MS_MAX,
  VISION_TIMEOUT_MS_MIN,
} from "../gui/src/pages/dashboard-shared";

test("Dashboard timeout bounds are the runtime vision sidecar contract", () => {
  expect(VISION_TIMEOUT_MS_MIN).toBe(MIN_VISION_TIMEOUT_MS);
  expect(VISION_TIMEOUT_MS_MAX).toBe(MAX_VISION_TIMEOUT_MS);
  expect(VISION_TIMEOUT_MS_DEFAULT).toBe(DEFAULT_VISION_TIMEOUT_MS);
  expect(VISION_MAX_DESCRIPTIONS_DEFAULT).toBe(DEFAULT_MAX_DESCRIPTIONS_PER_TURN);
});
