import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("does not promote global active on session-scoped failover", () => {
    const source = readFileSync(new URL("../src/server/responses/core.ts", import.meta.url), "utf8");
    const start = source.indexOf("resolveAntigravityAccountForSession(antigravitySessionKey)");
    const end = source.indexOf('if (route.providerName === "kiro")', start);
    const initialSelection = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(initialSelection).toContain("bindAntigravityProject");
    expect(initialSelection).not.toContain('setActiveAccount("google-antigravity"');
  });

  test("429 carousel does not promote global active on hop", () => {
    const source = readFileSync(new URL("../src/server/responses/core.ts", import.meta.url), "utf8");
    const start = source.indexOf("rotateAntigravityAccountOn429(antigravityAccountId");
    const end = source.indexOf("// Unknown provenance is deliberately fail-soft", start);
    const carousel = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(carousel).toContain("rotateAntigravityAccountOn429");
    expect(carousel).not.toContain('setActiveAccount("google-antigravity"');
  });

  test("threads Antigravity accountId into image and web-search sidecar fetches", () => {
    const source = readFileSync(new URL("../src/server/responses/core.ts", import.meta.url), "utf8");
    const imageCall = source.slice(
      source.indexOf("const imgResponse = await runWithImageBridge({"),
      source.indexOf("const wsResponse = await runWithWebSearch({"),
    );
    const webSearchCall = source.slice(
      source.indexOf("const wsResponse = await runWithWebSearch({"),
      source.indexOf("if (wsResponse.body)"),
    );

    expect(imageCall).toContain("accountId: antigravityAccountId");
    expect(webSearchCall).toContain("accountId: antigravityAccountId");
  });
});
