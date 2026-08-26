import { describe, expect, test } from "bun:test";
import { modelDisplayNameValidationKey } from "../src/pages/models-shared";

describe("discovered model display name validation", () => {
  test("accepts a safe label at both ordinary and maximum length", () => {
    expect(modelDisplayNameValidationKey("Grok 4.6")).toBeNull();
    expect(modelDisplayNameValidationKey("A".repeat(128))).toBeNull();
  });

  test("rejects values that the management API cannot persist", () => {
    expect(modelDisplayNameValidationKey("   ")).toBe("models.displayNameRequired");
    expect(modelDisplayNameValidationKey("Grok/4.6")).toBe("models.displayNameNoSlash");
    expect(modelDisplayNameValidationKey("Grok\n4.6")).toBe("models.displayNameNoControl");
    expect(modelDisplayNameValidationKey("A".repeat(129))).toBe("models.displayNameTooLong");
  });
});
