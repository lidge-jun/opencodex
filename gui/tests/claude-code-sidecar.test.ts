import { expect, test } from "bun:test";
import {
  applySidecarBackendChange,
  applySidecarModelChange,
  serializeSidecarOverride,
  sidecarSelectValue,
} from "../src/pages/claude-code-sidecar";

test("Inherit → Auto remains Auto (empty draft) and keeps a selectable override", () => {
  const draft = applySidecarBackendChange(undefined, "auto");
  expect(draft).toEqual({ backend: undefined });
  expect(sidecarSelectValue(draft)).toBe("auto");
  // Model input is enabled whenever an override object exists.
  expect(draft).toBeTruthy();
});

test("Entering a model under Auto survives serialize (save payload)", () => {
  let override = applySidecarBackendChange(undefined, "auto");
  override = applySidecarModelChange(override, "  gpt-4o-mini  ");
  expect(sidecarSelectValue(override)).toBe("auto");
  expect(serializeSidecarOverride(override)).toEqual({
    backend: null,
    model: "gpt-4o-mini",
  });
});

test("Empty Auto serializes as null (reloads as Inherit)", () => {
  expect(serializeSidecarOverride({ backend: undefined })).toBeNull();
  expect(serializeSidecarOverride({ backend: undefined, model: "" })).toBeNull();
  expect(serializeSidecarOverride({ backend: undefined, model: "   " })).toBeNull();
  expect(serializeSidecarOverride({})).toBeNull();
});

test("Switching back to Inherit clears the override", () => {
  const withModel = applySidecarModelChange(
    applySidecarBackendChange(undefined, "auto"),
    "gpt-4o",
  );
  expect(applySidecarBackendChange(withModel, "inherit")).toBeUndefined();
  expect(sidecarSelectValue(undefined)).toBe("inherit");
  expect(serializeSidecarOverride(undefined)).toBeNull();
});

test("Switching Auto ↔ OpenAI ↔ Anthropic preserves the model", () => {
  let override = applySidecarModelChange(
    applySidecarBackendChange(undefined, "auto"),
    "claude-sonnet-4",
  );
  override = applySidecarBackendChange(override, "openai")!;
  expect(override).toEqual({ backend: "openai", model: "claude-sonnet-4" });
  override = applySidecarBackendChange(override, "anthropic")!;
  expect(override).toEqual({ backend: "anthropic", model: "claude-sonnet-4" });
  override = applySidecarBackendChange(override, "auto")!;
  expect(override).toEqual({ backend: undefined, model: "claude-sonnet-4" });
  expect(sidecarSelectValue(override)).toBe("auto");
});

test("Explicit backends serialize even with an empty model", () => {
  expect(serializeSidecarOverride({ backend: "openai", model: "" })).toEqual({
    backend: "openai",
    model: "",
  });
});

test("Explicit backends trim whitespace-padded models before persist", () => {
  expect(serializeSidecarOverride({ backend: "openai", model: "  gpt-4o  " })).toEqual({
    backend: "openai",
    model: "gpt-4o",
  });
  expect(serializeSidecarOverride({ backend: "anthropic", model: "  claude-sonnet-4  " })).toEqual({
    backend: "anthropic",
    model: "claude-sonnet-4",
  });
});
