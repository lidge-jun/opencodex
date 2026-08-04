import { expect, test } from "bun:test";
import { speedLabel } from "../src/pages/logs-speed-label";

function entry(fields: {
  requestedSpeedLabel?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
}): { requestedSpeedLabel?: string } {
  return fields;
}

test("a request that asked for Fast is labelled Fast", () => {
  expect(speedLabel(entry({ requestedSpeedLabel: "fast" }))).toBe("fast");
});

test("the request wins even when no global tier is configured", () => {
  expect(speedLabel(entry({
    requestedSpeedLabel: "fast",
    modelSupportsServiceTier: true,
  }))).toBe("fast");
});

test("a Standard request is not relabelled Fast by the global setting (#689)", () => {
  // Codex omits the `default` sentinel from the outbound request, so a Standard
  // task arrives with no requestedSpeedLabel. The global setting may say Fast
  // because Fast was picked in some OTHER task — that is not this request.
  expect(speedLabel(entry({
    modelSupportsServiceTier: true,
    configuredSpeedLabel: "fast",
  }))).toBeUndefined();
});

test("no request label and no configured label stays unlabelled", () => {
  expect(speedLabel(entry({}))).toBeUndefined();
  expect(speedLabel(entry({ modelSupportsServiceTier: false }))).toBeUndefined();
});

test("an empty request label is not treated as a tier", () => {
  expect(speedLabel(entry({ requestedSpeedLabel: "" }))).toBeUndefined();
});
