import { describe, expect, test } from "bun:test";
import { bindAntigravityProject } from "../src/oauth/antigravity-routing";

const MISSING_PROJECT_MESSAGE =
  "Antigravity requires a discovered Cloud Code Assist project id (re-run `ocx login google-antigravity`).";

describe("bindAntigravityProject", () => {
  test("fails closed when the current credential has no projectId", () => {
    const previous = {
      apiKey: "token-a",
      googleMode: "cloud-code-assist" as const,
      project: "project-from-previous-account",
    };

    const bound = bindAntigravityProject(previous, undefined);

    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error("expected fail-closed bind");
    expect(bound.status).toBe(400);
    expect(bound.type).toBe("invalid_request_error");
    expect(bound.message).toBe(MISSING_PROJECT_MESSAGE);
    expect(previous.project).toBe("project-from-previous-account");
  });

  test("fails closed for an empty projectId instead of keeping the previous project", () => {
    const previous = { project: "project-from-previous-account" };

    const bound = bindAntigravityProject(previous, "");

    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error("expected fail-closed bind");
    expect(bound.status).toBe(400);
    expect(bound.type).toBe("invalid_request_error");
    expect(bound.message).toBe(MISSING_PROJECT_MESSAGE);
    expect(previous.project).toBe("project-from-previous-account");
  });

  test("overwrites a previous account project with the current credential project", () => {
    const previous = {
      apiKey: "token-b",
      googleMode: "cloud-code-assist" as const,
      project: "project-from-previous-account",
    };

    const bound = bindAntigravityProject(previous, "project-from-current-account");

    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error("expected successful bind");
    expect(bound.provider.project).toBe("project-from-current-account");
    expect(bound.provider.apiKey).toBe("token-b");
    expect(previous.project).toBe("project-from-previous-account");
  });

  test("assigns the current credential project when the provider had none", () => {
    const previous = { apiKey: "token-c", googleMode: "cloud-code-assist" as const };

    const bound = bindAntigravityProject(previous, "project-from-current-account");

    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error("expected successful bind");
    expect(bound.provider.project).toBe("project-from-current-account");
  });
});
