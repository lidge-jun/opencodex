"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  clean,
  normalise,
  canonicalise,
  extractSection,
  detectIssueKind,
  validateIssue,
  shouldReopen,
  shouldEnforceClosure,
  labelForKind,
} = require("./issue-quality.cjs");

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("detectIssueKind", () => {
  it("detects new feature form without [Feature]: prefix", () => {
    const body = [
      "### Area",
      "Proxy and routing",
      "### What are you trying to accomplish?",
      "Route requests to a fallback provider.",
      "### What prevents this today?",
      "No fallback support.",
      "### What should OpenCodex do?",
      "Fall back automatically.",
      "### Example usage or interface",
      "ocx config set routing.fallback anthropic",
    ].join("\n");
    assert.equal(detectIssueKind({ title: "Add fallback routing", body, labels: ["enhancement"] }), "feature");
  });

  it("detects legacy feature form with [Feature]: prefix", () => {
    const body = [
      "### Problem to solve",
      "I want opencodex to support streaming.",
      "### Proposed solution",
      "Add SSE passthrough.",
    ].join("\n");
    assert.equal(detectIssueKind({ title: "[Feature]: streaming support", body, labels: ["enhancement"] }), "feature");
  });

  it("detects new bug form without [Bug]: prefix", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "Proxy and routing",
      "### Summary",
      "Proxy crashes on startup.",
      "### Reproduction",
      "1. ocx start",
      "### Version",
      "2.7.31",
      "### Operating system",
      "Windows 11",
    ].join("\n");
    assert.equal(detectIssueKind({ title: "Proxy crashes", body, labels: ["bug"] }), "bug");
  });

  it("detects legacy bug form with [Bug]: prefix", () => {
    const body = [
      "### Summary",
      "The proxy returns 502.",
      "### Reproduction",
      "Send a request to /v1/responses.",
    ].join("\n");
    assert.equal(detectIssueKind({ title: "[Bug]: 502 on responses", body, labels: ["bug"] }), "bug");
  });

  it("detects provider compatibility form", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Provider or upstream service",
      "anthropic",
      "### OpenCodex version",
      "2.7.31",
      "### Endpoint or capability",
      "/v1/messages",
      "### Current behaviour",
      "Returns 400.",
      "### Expected behaviour",
      "Returns 200 with a message.",
      "### Minimal redacted request or reproduction",
      "curl ...",
      "### Actual response or error",
      "400 Bad Request",
      "### Upstream documentation",
      "https://docs.anthropic.com/en/api/messages",
    ].join("\n");
    assert.equal(detectIssueKind({ title: "Anthropic messages 400", body, labels: ["enhancement"] }), "provider-compatibility");
  });

  it("detects documentation form", () => {
    const body = [
      "### Documentation problem type",
      "Missing documentation",
      "### Documentation location",
      "docs/providers.md",
      "### What is wrong or missing?",
      "No mention of the xai provider.",
      "### What should the documentation explain instead?",
      "How to configure xai.",
    ].join("\n");
    assert.equal(detectIssueKind({ title: "Missing xai docs", body, labels: ["documentation"] }), "documentation");
  });

  it("returns null for unrelated issue with manually applied enhancement label", () => {
    const body = "Just a random question about setup.";
    assert.equal(detectIssueKind({ title: "How do I configure?", body, labels: ["enhancement"] }), null);
  });

  it("uses stored bot kind when headings are removed", () => {
    const body = "Some edited text without headings.";
    assert.equal(detectIssueKind({ title: "My issue", body, labels: [], storedKind: "feature" }), "feature");
  });
});

// ---------------------------------------------------------------------------
// Validation: feature
// ---------------------------------------------------------------------------

describe("validateIssue - feature", () => {
  it("rejects issue #208-style duplicate content", () => {
    const repeated = "Add support for streaming responses in the proxy";
    const body = [
      "### What are you trying to accomplish?",
      repeated,
      "### What prevents this today?",
      repeated,
      "### What should OpenCodex do?",
      repeated,
      "### Example usage or interface",
      repeated,
    ].join("\n");
    const result = validateIssue({ title: repeated, body, labels: ["enhancement"] });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.length > 0);
  });

  it("accepts a concise but actionable feature", () => {
    const body = [
      "### Area",
      "CLI",
      "### What are you trying to accomplish?",
      "Pin the proxy port across restarts.",
      "### What prevents this today?",
      "Port resets to 10100 after ocx stop.",
      "### What should OpenCodex do?",
      "Remember the last used port in config.",
      "### Example usage or interface",
      "ocx start --port 8080 && ocx stop && ocx start  # still 8080",
    ].join("\n");
    const result = validateIssue({ title: "Persist port across restarts", body, labels: ["enhancement"] });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, true);
  });

  it("accepts a valid legacy feature request without blocker/example headings", () => {
    const body = [
      "### Problem to solve",
      "No way to set a custom timeout per provider in the proxy config.",
      "### Proposed solution",
      "Add a per-provider timeout field in the config JSON.",
    ].join("\n");
    const result = validateIssue({ title: "[Feature]: per-provider timeout", body, labels: ["enhancement"] });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, true, `Expected valid but got reasons: ${result.reasons.join(", ")}`);
  });

  it("accepts a detailed CJK submission", () => {
    const body = [
      "### Area",
      "Proxy and routing",
      "### What are you trying to accomplish?",
      "\u4ee3\u7406\u670d\u52a1\u5668\u9700\u8981\u652f\u6301\u591a\u4e2a\u4e0a\u6e38\u63d0\u4f9b\u5546\u7684\u81ea\u52a8\u6545\u969c\u8f6c\u79fb\uff0c\u5f53\u4e3b\u63d0\u4f9b\u5546\u8fd4\u56de\u9519\u8bef\u65f6\u81ea\u52a8\u5207\u6362\u5230\u5907\u7528\u63d0\u4f9b\u5546\u3002",
      "### What prevents this today?",
      "\u76ee\u524d\u4ee3\u7406\u4e0d\u652f\u6301\u6545\u969c\u8f6c\u79fb\uff0c\u9700\u8981\u624b\u52a8\u91cd\u542f\u5e76\u66f4\u6539\u914d\u7f6e\u3002",
      "### What should OpenCodex do?",
      "\u5f53\u4e3b\u63d0\u4f9b\u5546\u8fd4\u56de 5xx \u6216\u8d85\u65f6\u65f6\uff0c\u81ea\u52a8\u5c06\u8bf7\u6c42\u8f6c\u53d1\u5230\u914d\u7f6e\u7684\u5907\u7528\u63d0\u4f9b\u5546\u3002",
      "### Example usage or interface",
      "```json\n{\"routing\":{\"fallback_provider\":\"anthropic\"}}\n```",
    ].join("\n");
    const result = validateIssue({ title: "\u652f\u6301\u591a\u63d0\u4f9b\u5546\u6545\u969c\u8f6c\u79fb", body, labels: ["enhancement"] });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// Validation: bug
// ---------------------------------------------------------------------------

describe("validateIssue - bug", () => {
  it("rejects an empty bug report", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "CLI",
      "### Summary",
      "No response",
      "### Reproduction",
      "No response",
      "### Version",
      "No response",
      "### Operating system",
      "No response",
    ].join("\n");
    const result = validateIssue({ title: "Bug", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
  });

  it("accepts a terse real crash report", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "Proxy and routing",
      "### Summary",
      "Proxy segfaults on ARM64 when streaming is enabled.",
      "### Reproduction",
      "ocx start on Raspberry Pi 4, send any streaming request.",
      "### Version",
      "2.7.30",
      "### Operating system",
      "Debian 12 aarch64",
      "### Logs or error output",
      "```",
      "SIGSEGV at 0x0000 in bun_runtime",
      "```",
    ].join("\n");
    const result = validateIssue({ title: "Segfault on ARM64 streaming", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, true);
  });

  it("accepts a valid legacy bug report without version/OS headings", () => {
    const body = [
      "### Summary",
      "The proxy crashes when streaming is enabled.",
      "### Reproduction",
      "Run ocx start and send a streaming request.",
    ].join("\n");
    const result = validateIssue({ title: "[Bug]: crash on streaming", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, true, `Expected valid but got reasons: ${result.reasons.join(", ")}`);
  });

  it("accepts a legacy bug with _No response_ in old optional env fields", () => {
    const body = [
      "### Summary",
      "Proxy crashes on startup.",
      "### Reproduction",
      "Run ocx start.",
      "### Version",
      "_No response_",
      "### OS",
      "_No response_",
    ].join("\n");
    const result = validateIssue({ title: "[Bug]: crash", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, true, `Expected valid but got: ${result.reasons.join(", ")}`);
  });

  it("rejects a new-form bug where env fields were actively cleared", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Summary",
      "Proxy crashes.",
      "### Reproduction",
      "Run ocx start.",
      "### Version",
      "",
      "### Operating system",
      "",
    ].join("\n");
    const result = validateIssue({ title: "Crash", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => r.includes("Version")));
  });
});

// ---------------------------------------------------------------------------
// Validation: provider-compatibility
// ---------------------------------------------------------------------------

describe("validateIssue - provider-compatibility", () => {
  it("rejects when request and response are both absent", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Provider or upstream service",
      "mistral",
      "### OpenCodex version",
      "2.7.31",
      "### Endpoint or capability",
      "/v1/chat/completions",
      "### Current behaviour",
      "Returns 500.",
      "### Expected behaviour",
      "Returns 200.",
      "### Minimal redacted request or reproduction",
      "No response",
      "### Actual response or error",
      "No response",
      "### Upstream documentation",
      "https://docs.mistral.ai/api/",
    ].join("\n");
    const result = validateIssue({ title: "Mistral 500", body, labels: ["enhancement"] });
    assert.equal(result.kind, "provider-compatibility");
    assert.equal(result.valid, false);
  });

  it("accepts a complete provider compatibility report", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Provider or upstream service",
      "anthropic",
      "### OpenCodex version",
      "2.7.31",
      "### Endpoint or capability",
      "/v1/messages",
      "### Current behaviour",
      "Proxy strips the system field from the request.",
      "### Expected behaviour",
      "Proxy preserves the system field as documented.",
      "### Minimal redacted request or reproduction",
      "curl -X POST http://localhost:10100/v1/messages -d '{\"model\":\"claude-sonnet-4-20250514\",\"system\":\"You are helpful.\",\"messages\":[]}'",
      "### Actual response or error",
      "400: system is required",
      "### Upstream documentation",
      "https://docs.anthropic.com/en/api/messages",
    ].join("\n");
    const result = validateIssue({ title: "System field stripped", body, labels: ["enhancement"] });
    assert.equal(result.kind, "provider-compatibility");
    assert.equal(result.valid, true);
  });

  it("rejects provider compat report when provider/endpoint fields are cleared", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Provider or upstream service",
      "",
      "### OpenCodex version",
      "2.7.31",
      "### Endpoint or capability",
      "",
      "### Current behaviour",
      "Returns 400.",
      "### Expected behaviour",
      "Returns 200.",
      "### Minimal redacted request or reproduction",
      "curl ...",
      "### Actual response or error",
      "400 Bad Request",
      "### Upstream documentation",
      "https://docs.example.com",
    ].join("\n");
    const result = validateIssue({ title: "400 error", body, labels: ["provider-compatibility"] });
    assert.equal(result.kind, "provider-compatibility");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => r.includes("provider")));
  });
});

// ---------------------------------------------------------------------------
// Validation: documentation
// ---------------------------------------------------------------------------

describe("validateIssue - documentation", () => {
  it("rejects an empty documentation report", () => {
    const body = [
      "### Documentation problem type",
      "Missing documentation",
      "### Documentation location",
      "No response",
      "### What is wrong or missing?",
      "No response",
      "### What should the documentation explain instead?",
      "No response",
    ].join("\n");
    const result = validateIssue({ title: "Docs", body, labels: ["documentation"] });
    assert.equal(result.kind, "documentation");
    assert.equal(result.valid, false);
  });

  it("accepts a complete documentation correction", () => {
    const body = [
      "### Documentation problem type",
      "Incorrect documentation",
      "### Documentation location",
      "https://lidge-jun.github.io/opencodex/providers/",
      "### What is wrong or missing?",
      "The page says kimi uses /v1/chat/completions but it actually uses /v1/responses.",
      "### What should the documentation explain instead?",
      "Update the endpoint to /v1/responses and add a note about the model discovery step.",
    ].join("\n");
    const result = validateIssue({ title: "Wrong kimi endpoint in docs", body, labels: ["documentation"] });
    assert.equal(result.kind, "documentation");
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe("normalisation", () => {
  it("treats 'No response' as empty", () => {
    assert.equal(clean("No response"), "");
    assert.equal(clean("_No response_"), "");
  });

  it("strips HTML comments", () => {
    assert.equal(clean("Hello <!-- hidden --> world"), "Hello  world");
  });

  it("normalises punctuation and capitalisation", () => {
    assert.equal(normalise("Hello, World!"), normalise("hello world"));
  });

  it("removes filler phrases", () => {
    const a = canonicalise("I want to add streaming support");
    const b = canonicalise("add streaming support");
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// extractSection
// ---------------------------------------------------------------------------

describe("extractSection", () => {
  it("extracts content between headings", () => {
    const body = "### Summary\nProxy crashes.\n### Reproduction\nRun ocx start.";
    assert.equal(extractSection(body, "Summary"), "Proxy crashes.");
    assert.equal(extractSection(body, "Reproduction"), "Run ocx start.");
  });

  it("returns null for missing sections", () => {
    assert.equal(extractSection("### Summary\nHello", "Reproduction"), null);
  });
});

// ---------------------------------------------------------------------------
// Closure ownership (shouldReopen)
// ---------------------------------------------------------------------------

describe("shouldReopen", () => {
  const baseBotState = {
    version: 2,
    active: true,
    kind: "feature",
    closedAt: "2026-07-20T10:00:00Z",
    stateReason: "not_planned",
  };

  it("allows reopen when timestamps and state match", () => {
    const issue = { state: "closed", closed_at: "2026-07-20T10:00:00Z", state_reason: "not_planned" };
    assert.equal(shouldReopen(baseBotState, issue, false), true);
  });

  it("forbids reopen when timestamp differs", () => {
    const issue = { state: "closed", closed_at: "2026-07-21T12:00:00Z", state_reason: "not_planned" };
    assert.equal(shouldReopen(baseBotState, issue, false), false);
  });

  it("forbids reopen when state reason differs", () => {
    const issue = { state: "closed", closed_at: "2026-07-20T10:00:00Z", state_reason: "completed" };
    assert.equal(shouldReopen(baseBotState, issue, false), false);
  });

  it("forbids reopen when bot state is inactive", () => {
    const inactive = { ...baseBotState, active: false };
    const issue = { state: "closed", closed_at: "2026-07-20T10:00:00Z", state_reason: "not_planned" };
    assert.equal(shouldReopen(inactive, issue, false), false);
  });

  it("returns false when issue is already open", () => {
    const issue = { state: "open", closed_at: null, state_reason: null };
    assert.equal(shouldReopen(baseBotState, issue, false), false);
  });

  it("forbids reopen on maintainer override", () => {
    const issue = { state: "closed", closed_at: "2026-07-20T10:00:00Z", state_reason: "not_planned" };
    assert.equal(shouldReopen(baseBotState, issue, true), false);
  });

  it("forbids reopen when a human closed the issue (closed_by is not the bot)", () => {
    const issue = {
      state: "closed",
      closed_at: "2026-07-20T10:00:00Z",
      state_reason: "not_planned",
      closed_by: "lidge-jun",
    };
    assert.equal(shouldReopen(baseBotState, issue, false), false);
  });

  it("allows reopen when the bot is the recorded closer", () => {
    const issue = {
      state: "closed",
      closed_at: "2026-07-20T10:00:00Z",
      state_reason: "not_planned",
      closed_by: "github-actions[bot]",
    };
    assert.equal(shouldReopen(baseBotState, issue, false), true);
  });
});

describe("shouldEnforceClosure", () => {
  it("enforces when there is no bot state yet", () => {
    assert.equal(shouldEnforceClosure(null), true);
  });

  it("enforces while the bot still owns an active closure", () => {
    assert.equal(
      shouldEnforceClosure({
        version: 2,
        active: true,
        kind: "feature",
        closedAt: "2026-07-20T10:00:00Z",
        stateReason: "not_planned",
      }),
      true,
    );
  });

  it("does not enforce after a maintainer override", () => {
    assert.equal(
      shouldEnforceClosure({
        version: 2,
        active: false,
        kind: "feature",
        closedAt: "2026-07-20T10:00:00Z",
        stateReason: "not_planned",
        maintainerOverride: true,
      }),
      false,
    );
  });

  it("still enforces after a normal active:false without maintainer override", () => {
    assert.equal(
      shouldEnforceClosure({
        version: 2,
        active: false,
        kind: "feature",
        closedAt: "2026-07-20T10:00:00Z",
        stateReason: "not_planned",
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Translated / soft-pass / labels
// ---------------------------------------------------------------------------

describe("translated feature headings and soft-pass", () => {
  it("accepts Goal / Problem + Expected behaviour as a valid feature", () => {
    const body = [
      "### Goal / Problem",
      "Codex App rejects image paste for noVisionModels before the vision sidecar can run.",
      "### Expected behaviour",
      "Catalog should advertise image input when the vision sidecar covers the model.",
      "### Environment",
      "opencodex 2.7.36 on macOS with Codex App.",
    ].join("\n");
    const result = validateIssue({
      title: "[Feature]: Auto-advertise image inputModalities for noVisionModels",
      body,
      labels: [],
    });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, true, `Expected valid but got: ${result.reasons.join("; ")}`);
    assert.equal(result.softPass, false);
  });

  it("soft-passes [Feature]: with rich custom headings outside the alias map", () => {
    const body = [
      "### Concrete user workflow that fails",
      "User pastes an image in Codex App while a text-only routed model is selected and the App blocks upload.",
      "### Why this matters",
      "Vision sidecar is advertised but never reached from the App client path.",
      "### Verification",
      "Same proxy config works end-to-end in Claude Code with the sidecar describing the image.",
    ].join("\n");
    const result = validateIssue({
      title: "[Feature]: Vision sidecar unusable from Codex App",
      body,
      labels: [],
    });
    assert.equal(result.kind, "feature");
    assert.equal(result.softPass, true);
    assert.equal(result.valid, false);
  });

  it("still rejects empty [Feature]: bodies", () => {
    const result = validateIssue({
      title: "[Feature]: do something cool",
      body: "please add this",
      labels: [],
    });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, false);
    assert.equal(result.softPass, false);
  });

  it("does not treat a title containing problem as a bug", () => {
    assert.equal(
      detectIssueKind({
        title: "Problem with documentation wording",
        body: "The docs are confusing about install.",
        labels: [],
      }),
      null,
    );
  });

  it("does not soft-pass long unstructured bodies without headings", () => {
    const result = validateIssue({
      title: "[Feature]: please add thing",
      body: "x".repeat(250),
      labels: [],
    });
    assert.equal(result.kind, "feature");
    assert.equal(result.softPass, false);
    assert.equal(result.valid, false);
  });

  it("does not classify Expected behaviour + Example as feature without a feature hint", () => {
    assert.equal(
      detectIssueKind({
        title: "Something broke in the proxy",
        body: [
          "### Expected behaviour",
          "Proxy should return 200.",
          "### Example",
          "curl localhost:10100/v1/responses",
        ].join("\n"),
        labels: [],
      }),
      null,
    );
  });

  it("classifies alias headings as feature when a goal heading is present", () => {
    assert.equal(
      detectIssueKind({
        title: "Advertise image input for sidecar models",
        body: [
          "### Goal / Problem",
          "App blocks images before the sidecar runs.",
          "### Expected behaviour",
          "Catalog should advertise image input.",
        ].join("\n"),
        labels: [],
      }),
      "feature",
    );
  });

  it("lets a strong bug form override a stale stored feature kind", () => {
    const result = validateIssue({
      title: "Crash on start",
      body: [
        "### Client or integration",
        "Codex CLI",
        "### Summary",
        "Proxy segfaults on ARM64 when streaming is enabled.",
        "### Reproduction",
        "ocx start on Raspberry Pi 4, send any streaming request.",
        "### Version",
        "2.7.36",
        "### Operating system",
        "Linux",
      ].join("\n"),
      labels: ["bug"],
      storedKind: "feature",
    });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, true, `Expected valid bug but got: ${result.reasons.join("; ")}`);
  });

  it("accepts US spelling Expected behavior as a behaviour alias", () => {
    const result = validateIssue({
      title: "[Feature]: Auto-advertise image inputModalities",
      body: [
        "### Goal / Problem",
        "App blocks images before the vision sidecar can run.",
        "### Expected behavior",
        "Catalog should advertise image input when the sidecar covers the model.",
      ].join("\n"),
      labels: [],
    });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, true, `Expected valid but got: ${result.reasons.join("; ")}`);
  });

  it("does not treat enhancement + non-goal aliases as a feature detect hit", () => {
    assert.equal(
      detectIssueKind({
        title: "Something odd in the proxy",
        body: [
          "### Current limitation",
          "No fallback provider today for upstream 5xx responses.",
          "### Expected behaviour",
          "Auto failover to a backup provider.",
        ].join("\n"),
        labels: ["enhancement"],
      }),
      null,
    );
  });

  it("does not let a weak title-prefix detection override stored documentation kind", () => {
    assert.equal(
      detectIssueKind({
        title: "[Feature]: rewrite the docs",
        body: "Still working on the write-up.",
        labels: [],
        storedKind: "documentation",
      }),
      "documentation",
    );
  });
});

describe("labelForKind", () => {
  it("maps kinds to triage labels", () => {
    assert.equal(labelForKind("bug"), "bug");
    assert.equal(labelForKind("feature"), "enhancement");
    assert.equal(labelForKind("documentation"), "documentation");
    assert.equal(labelForKind("provider-compatibility"), "provider-compatibility");
    assert.equal(labelForKind(null), null);
    assert.equal(labelForKind("unknown"), null);
  });
});
