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
  looksLikeUntemplatedBugReport,
  shouldReopen,
  shouldEnforceClosure,
  labelForKind,
  isPlaceholderOnlyValue,
  isPlaceholder,
  isRawPlaceholder,
  countWords,
  hasConcreteDetail,
  rejectsWorkflowDispatchPullRequest,
  rejectsWorkflowDispatchNonDefaultBranch,
} = require("./issue-quality.cjs");

function featureBodyWithGoal(goal) {
  return [
    "### Area",
    "CLI",
    "### What are you trying to accomplish?",
    goal,
    "### What prevents this today?",
    "Port resets to 10100 after every ocx stop command.",
    "### What should OpenCodex do?",
    "Persist the last used port in config across restarts.",
    "### Example usage or interface",
    "ocx start --port 8080 && ocx stop && ocx start",
  ].join("\n");
}

function featureBodyWithExample(example) {
  return [
    "### What are you trying to accomplish?",
    "Route voice requests to a configured fallback provider when the primary quota is exhausted.",
    "### What prevents this today?",
    "Voice mode is hard-wired to the primary Codex quota and cannot switch providers.",
    "### What should OpenCodex do?",
    "Expose a setting to choose the fallback voice model and provider.",
    "### Example usage or interface",
    example,
  ].join("\n");
}

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
  it("keeps nested sub-headings and fenced heading text inside a section (#541)", () => {
    const body = [
      "### What are you trying to accomplish?",
      "Route Studio models through the user's WordPress.com account.",
      "### What prevents this today?",
      "The provider needs two wire formats and one shared OAuth identity.",
      "### What should OpenCodex do?",
      "Add a first-class provider with model-specific transport selection.",
      "### Example usage or interface",
      "#### CLI flow",
      "```bash",
      "# This heading-shaped shell comment must stay inside the fence",
      "ocx login wordpress-studio",
      "```",
      "#### Dashboard flow",
      "Providers -> WordPress Studio Code -> Log in",
      "### Alternatives or workarounds",
      "Use Studio directly.",
    ].join("\n");

    const example = extractSection(body, "Example usage or interface");
    assert.match(example, /^#### CLI flow/);
    assert.match(example, /# This heading-shaped shell comment/);
    assert.match(example, /#### Dashboard flow/);
    assert.doesNotMatch(example, /Alternatives or workarounds/);

    const result = validateIssue({ title: "Add WordPress Studio provider", body, labels: ["enhancement"] });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, true, `Expected valid but got reasons: ${result.reasons.join(", ")}`);
  });

  it("ignores markdown headings inside backtick and tilde fences when finding section boundaries (#541)", () => {
    for (const fence of ["```", "~~~~"]) {
      const body = [
        "### Example usage or interface",
        fence,
        "### pasted heading",
        "real example content",
        fence,
        "### Next sibling",
        "outside",
      ].join("\n");
      assert.equal(
        extractSection(body, "Example usage or interface"),
        [fence, "### pasted heading", "real example content", fence].join("\n"),
      );
    }
  });

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

  it("rejects issue #401-style low-effort feature with placeholder example", () => {
    const body = [
      "### Area",
      "Proxy and routing",
      "### What are you trying to accomplish?",
      "Quota for Chatgpt running out that can no longer use voice mode. Would like to change other model for that",
      "### What prevents this today?",
      "No usage without codex quota",
      "### What should OpenCodex do?",
      "Change another voice model",
      "### Example usage or interface",
      "NA",
    ].join("\n");
    const result = validateIssue({
      title: "Change voice chat to different model",
      body,
      labels: ["enhancement"],
    });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => r.includes("placeholder")));
    assert.ok(result.reasons.some((r) => r.includes("expected behaviour")));
  });

  it("rejects feature reports with placeholder example variants", () => {
    const placeholders = [
      "NA",
      "N/A",
      "_N/A_",
      "NA.",
      "N/A.",
      "Not applicable",
      "Not applicable.",
      "Not available!",
    ];
    for (const example of placeholders) {
      const body = [
        "### What are you trying to accomplish?",
        "Route voice requests to a configured fallback provider when the primary quota is exhausted.",
        "### What prevents this today?",
        "Voice mode is hard-wired to the primary Codex quota and cannot switch providers.",
        "### What should OpenCodex do?",
        "Expose a setting to choose the fallback voice model and provider.",
        "### Example usage or interface",
        example,
      ].join("\n");
      const result = validateIssue({ title: "Voice fallback routing", body, labels: ["enhancement"] });
      assert.equal(result.valid, false, `Expected placeholder example "${example}" to be invalid`);
      assert.ok(
        result.reasons.some((r) => r.includes("placeholder")),
        `Expected placeholder reason for "${example}", got: ${result.reasons.join("; ")}`,
      );
      assert.ok(!result.reasons.some((r) => r.includes("example usage")));
    }
  });

  it("reports blank example usage as missing, not placeholder", () => {
    const body = [
      "### What are you trying to accomplish?",
      "Route voice requests to a configured fallback provider when the primary quota is exhausted.",
      "### What prevents this today?",
      "Voice mode is hard-wired to the primary Codex quota and cannot switch providers.",
      "### What should OpenCodex do?",
      "Expose a setting to choose the fallback voice model and provider.",
      "### Example usage or interface",
      "",
    ].join("\n");
    const result = validateIssue({ title: "Voice fallback routing", body, labels: ["enhancement"] });
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => r.includes("example usage")));
    assert.ok(!result.reasons.some((r) => r.includes("placeholder")));
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

  it("rejects terse goal sections that only contain a keyword, digit, or punctuation", () => {
    const terseGoals = ["API", "provider", "1", "/", "use CLI", "route 1"];
    for (const goal of terseGoals) {
      const result = validateIssue({
        title: "Improve feature request quality",
        body: featureBodyWithGoal(goal),
        labels: ["enhancement"],
      });
      assert.equal(result.kind, "feature");
      assert.equal(result.valid, false, `Expected terse goal "${goal}" to be invalid`);
      assert.ok(
        result.reasons.some((r) => r.includes("too vague")),
        `Expected too vague reason for "${goal}", got: ${result.reasons.join(", ")}`,
      );
    }
  });

  it("rejects a single long non-CJK word as overly terse", () => {
    const terseGoals = [
      "провайдер",
      "маршрут",
      "πάροχος",
      "واجهة",
    ];
    for (const goal of terseGoals) {
      assert.equal(countWords(goal), 1, `Expected "${goal}" to count as one word`);
      const result = validateIssue({
        title: "Improve feature request quality",
        body: featureBodyWithGoal(goal),
        labels: ["enhancement"],
      });
      assert.equal(result.kind, "feature");
      assert.equal(result.valid, false, `Expected terse goal "${goal}" to be invalid`);
      assert.ok(
        result.reasons.some((r) => r.includes("too vague")),
        `Expected too vague reason for "${goal}", got: ${result.reasons.join(", ")}`,
      );
    }
  });

  it("counts mixed-script CJK text without inflating non-CJK letter length", () => {
    assert.equal(countWords("provider中"), 2);
    assert.equal(countWords("провайдер中"), 2);
    assert.equal(countWords("configuration中"), 2);
    assert.equal(countWords("中provider文"), 3);
  });

  it("rejects mixed-script CJK stubs that only inflate letter counts", () => {
    const terseGoals = ["provider中", "провайдер中", "configuration中"];
    for (const goal of terseGoals) {
      assert.ok(countWords(goal) < 8, `Expected "${goal}" to stay under 8 units`);
      const result = validateIssue({
        title: "Improve feature request quality",
        body: featureBodyWithGoal(goal),
        labels: ["enhancement"],
      });
      assert.equal(result.kind, "feature");
      assert.equal(result.valid, false, `Expected terse goal "${goal}" to be invalid`);
      assert.ok(
        result.reasons.some((r) => r.includes("too vague")),
        `Expected too vague reason for "${goal}", got: ${result.reasons.join(", ")}`,
      );
    }
  });

  it("accepts sufficiently detailed goal sections", () => {
    const detailedGoal =
      "Expose a dashboard setting to choose the fallback voice model and provider.";
    const detailedResult = validateIssue({
      title: "Voice fallback routing",
      body: featureBodyWithGoal(detailedGoal),
      labels: ["enhancement"],
    });
    assert.equal(detailedResult.kind, "feature");
    assert.equal(detailedResult.valid, true);
    assert.ok(countWords(detailedGoal) >= 8);
  });

  it("accepts a 6-7 word goal when it includes concrete technical detail", () => {
    const concreteGoal = "Route requests through the configured API provider.";
    assert.equal(countWords(concreteGoal), 7);
    assert.ok(countWords(concreteGoal) < 8);
    assert.ok(countWords(concreteGoal) >= 6);
    assert.equal(hasConcreteDetail(concreteGoal), true);

    const concreteResult = validateIssue({
      title: "Voice fallback routing",
      body: featureBodyWithGoal(concreteGoal),
      labels: ["enhancement"],
    });
    assert.equal(concreteResult.kind, "feature");
    assert.equal(concreteResult.valid, true);
  });

  it("rejects a 6-7 word goal that lacks concrete technical detail", () => {
    // Avoid keywords that count as concrete detail (api/provider/workflow/…).
    const vagueGoal = "Make this process easier for all users.";
    assert.equal(countWords(vagueGoal), 7);
    assert.equal(hasConcreteDetail(vagueGoal), false);

    const vagueResult = validateIssue({
      title: "Voice fallback routing",
      body: featureBodyWithGoal(vagueGoal),
      labels: ["enhancement"],
    });
    assert.equal(vagueResult.kind, "feature");
    assert.equal(vagueResult.valid, false);
    assert.ok(vagueResult.reasons.some((r) => r.includes("too vague")));
  });

  it("rejects fenced placeholder-only examples", () => {
    const fencedPlaceholders = [
      "```\nN/A\n```",
      "```text\nN/A\n```",
      "```json\nNot applicable.\n```",
      "~~~text\nN/A\n~~~",
    ];
    for (const example of fencedPlaceholders) {
      assert.equal(
        isPlaceholderOnlyValue(example),
        true,
        `Expected fenced placeholder to match: ${JSON.stringify(example)}`,
      );
      const result = validateIssue({
        title: "Voice fallback routing",
        body: featureBodyWithExample(example),
        labels: ["enhancement"],
      });
      assert.equal(result.valid, false, `Expected fenced placeholder to be invalid: ${JSON.stringify(example)}`);
      assert.ok(
        result.reasons.some((r) => r.includes("placeholder")),
        `Expected placeholder reason for ${JSON.stringify(example)}, got: ${result.reasons.join("; ")}`,
      );
    }
  });

  it("accepts real fenced examples that merely mention N/A", () => {
    const realExamples = [
      "```text\nThe API returns N/A when no provider is configured.\n```",
      '```json\n{"provider":"N/A","fallback":"anthropic"}\n```',
    ];
    for (const example of realExamples) {
      assert.equal(
        isPlaceholderOnlyValue(example),
        false,
        `Expected real example not to be placeholder-only: ${JSON.stringify(example)}`,
      );
      const result = validateIssue({
        title: "Voice fallback routing",
        body: featureBodyWithExample(example),
        labels: ["enhancement"],
      });
      assert.equal(
        result.valid,
        true,
        `Expected real fenced example to remain valid, got: ${result.reasons.join("; ")}`,
      );
    }
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

  it("accepts a legacy bug with N/A-style placeholders in Version and Operating system", () => {
    for (const placeholder of ["N/A", "NA", "Not applicable.", "Not available!"]) {
      const body = [
        "### Summary",
        "Proxy crashes on startup when streaming is enabled.",
        "### Reproduction",
        "Run ocx start and send any streaming request.",
        "### Version",
        placeholder,
        "### Operating system",
        placeholder,
      ].join("\n");
      const result = validateIssue({ title: "[Bug]: crash", body, labels: ["bug"] });
      assert.equal(result.kind, "bug");
      assert.equal(
        result.valid,
        true,
        `Expected legacy env placeholder "${placeholder}" to remain valid, got: ${result.reasons.join(", ")}`,
      );
      assert.ok(!result.reasons.some((r) => r.includes("Version")));
    }
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

  it("treats NA and not applicable as placeholders", () => {
    assert.equal(clean("NA"), "");
    assert.equal(clean("N/A"), "");
    assert.equal(clean("_N/A_"), "");
    assert.equal(clean("NA."), "");
    assert.equal(clean("N/A."), "");
    assert.equal(clean("not applicable"), "");
    assert.equal(clean("Not applicable."), "");
    assert.equal(clean("Not available!"), "");
  });

  it("does not treat sentences containing placeholder phrases as empty", () => {
    assert.equal(clean("This is N/A for voice mode today."), "This is N/A for voice mode today.");
    assert.equal(clean("Not applicable to Claude Code."), "Not applicable to Claude Code.");
  });

  it("shares one placeholder matcher across clean, isPlaceholder, and isRawPlaceholder", () => {
    const placeholders = [
      "No response",
      "NA",
      "N/A",
      "_N/A_",
      "NA.",
      "N/A.",
      "None",
      "Todo",
      "TBD",
      "Not applicable",
      "Not applicable.",
      "Not available!",
      "```\nN/A\n```",
      "```text\nN/A\n```",
      "```json\nNot applicable.\n```",
      "~~~text\nN/A\n~~~",
    ];
    for (const value of placeholders) {
      assert.equal(isPlaceholderOnlyValue(value), true, value);
      assert.equal(isPlaceholder(value), true, value);
      assert.equal(isRawPlaceholder(value), true, value);
      assert.equal(clean(value), "", value);
    }
    assert.equal(isPlaceholderOnlyValue("Route voice traffic to provider N/A fallback"), false);
    assert.equal(isPlaceholderOnlyValue("```text\nThe API returns N/A when no provider is configured.\n```"), false);
    assert.equal(isPlaceholderOnlyValue('```json\n{"provider":"N/A","fallback":"anthropic"}\n```'), false);
    assert.equal(isPlaceholder("use CLI"), false);
    assert.equal(isRawPlaceholder(""), false);
    assert.equal(isRawPlaceholder(null), false);
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

  it("soft-passes retitled feature reports that drop the [Feature]: prefix", () => {
    const body = [
      "### Concrete user workflow that fails",
      "User pastes an image in Codex App while a text-only routed model is selected and the App blocks upload.",
      "### Why this matters",
      "Vision sidecar is advertised but never reached from the App client path.",
      "### Verification",
      "Same proxy config works end-to-end in Claude Code with the sidecar describing the image.",
    ].join("\n");
    const result = validateIssue({
      title: "Vision sidecar unusable from Codex App",
      body,
      labels: ["enhancement"],
      storedKind: "feature",
    });
    assert.equal(result.kind, "feature");
    assert.equal(result.softPass, true);
  });

  it("soft-passes retitled bug reports with substantial non-English structure (#545)", () => {
    // Maintainer retitle removed `[Bug]:`; Korean structured body has no English
    // Summary/Reproduction headings but is clearly actionable.
    const body = [
      "## 환경",
      "- opencodex 2.7.41 (launchd, port 10100)",
      "- Claude Desktop 3P + Anthropic OAuth (Pro/Max)",
      "- Auto Mode classifier model = `claude-sonnet-5`",
      "",
      "## 증상",
      "Auto Mode classifier requests truncate at outputTokens=64 with max_output_tokens,",
      "then retry the same payload up to 5 times. Dashboard previously showed 502.",
      "",
      "## 재현",
      "1. `ocx login anthropic` and enable Claude Desktop 3P gateway key mode",
      "2. Enable Auto Mode and trigger a tool permission classifier turn",
      "3. Observe five identical 64-token incomplete terminals for one approval",
      "",
      "## 증거",
      "Inbound+outbound correlated captures show max_tokens:64 and stop_sequences preserved.",
    ].join("\n");
    const result = validateIssue({
      title: "Claude Desktop 3P Auto Mode classifier retries after 64-token Anthropic OAuth outputs",
      body,
      labels: ["bug", "provider-compatibility"],
      storedKind: "bug",
    });
    assert.equal(result.kind, "bug");
    assert.equal(result.softPass, true, `Expected soft-pass but got: ${result.reasons.join("; ")}`);
    assert.equal(result.valid, false);
  });

  it("does not soft-pass a single arbitrary rich heading (Codex #564)", () => {
    const result = validateIssue({
      title: "Something broke after upgrade",
      body: [
        "## Notes",
        "x".repeat(80),
      ].join("\n"),
      labels: ["bug"],
      storedKind: "bug",
    });
    assert.equal(result.kind, "bug");
    assert.equal(result.softPass, false);
    assert.equal(result.valid, false);
    assert.match(result.reasons.join(" "), /Summary and Reproduction are empty/);
  });

  it("does not soft-pass provider reports that only fill mapped metadata headings", () => {
    const result = validateIssue({
      title: "Provider X fails on Responses",
      body: [
        "### Provider or upstream service",
        "custom-openai-compatible gateway hosted on our internal mesh",
        "### OpenCodex version",
        "2.7.41",
        "### Endpoint or capability",
        "`POST /v1/responses` with streaming tool calls",
        "## Extra notes",
        "We see intermittent 502s after rotating the upstream API key for this gateway.",
      ].join("\n"),
      labels: ["provider-compatibility"],
      storedKind: "provider-compatibility",
    });
    assert.equal(result.kind, "provider-compatibility");
    assert.equal(result.softPass, false);
    assert.equal(result.valid, false);
    assert.match(result.reasons.join(" "), /current behaviour|expected behaviour/i);
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

// ---------------------------------------------------------------------------
// Freeform / non-template bypass (e.g. issue #521)
// ---------------------------------------------------------------------------

describe("validateIssue - freeform / non-template", () => {
  it("rejects a plain freeform body that previously skipped validation", () => {
    const result = validateIssue({
      title: "How do I configure?",
      body: "Just a random question about setup.",
      labels: [],
    });
    assert.equal(result.kind, null);
    assert.equal(result.valid, false);
    assert.equal(result.softPass, false);
    assert.ok(result.reasons.some((r) => /recognized issue template/i.test(r)));
    assert.ok(result.guidance.some((g) => /Bug report|Feature request/i.test(g)));
  });

  it("rejects a #521-shaped Description/Reproduction/Log entry body with a clear message", () => {
    const body = [
      "### Description",
      "Proxy returns 502 when streaming is enabled on Windows.",
      "### Reproduction",
      "1. ocx start",
      "2. Send a streaming request",
      "3. Observe 502",
      "### Log entry",
      "```",
      "upstream connect error or disconnect/reset before headers",
      "```",
    ].join("\n");
    assert.equal(
      detectIssueKind({ title: "Proxy 502 on streaming", body, labels: [] }),
      null,
      "near-miss headings must not silently classify as a structured bug",
    );
    assert.equal(looksLikeUntemplatedBugReport({ title: "Proxy 502 on streaming", body }), true);

    const result = validateIssue({
      title: "Proxy 502 on streaming",
      body,
      labels: [],
    });
    assert.equal(result.kind, null);
    assert.equal(result.valid, false);
    assert.ok(
      result.reasons.some((r) => /bug report/i.test(r) && /template/i.test(r)),
      `Expected bug-template reason, got: ${result.reasons.join("; ")}`,
    );
    assert.ok(
      result.guidance.some((g) => /Client or integration|Summary|Reproduction/i.test(g)),
      `Expected template-heading guidance, got: ${result.guidance.join("; ")}`,
    );
  });

  it("still detects and validates a real structured bug as before", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Summary",
      "Proxy segfaults on ARM64 when streaming is enabled.",
      "### Reproduction",
      "ocx start on Raspberry Pi 4, send any streaming request.",
      "### Version",
      "2.7.30",
      "### Operating system",
      "Debian 12 aarch64",
    ].join("\n");
    const result = validateIssue({
      title: "Segfault on ARM64 streaming",
      body,
      labels: ["bug"],
    });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, true);
  });

  it("does not treat Summary+Reproduction alone as a bug without prefix or label", () => {
    // Existing anti-false-positive rule; freeform gate still fails these as untemplated.
    const body = [
      "### Summary",
      "Something went wrong in the proxy.",
      "### Reproduction",
      "Run ocx start.",
    ].join("\n");
    assert.equal(detectIssueKind({ title: "Something went wrong", body, labels: [] }), null);
    const result = validateIssue({ title: "Something went wrong", body, labels: [] });
    assert.equal(result.kind, null);
    assert.equal(result.valid, false);
  });

  it("keeps label-backed storedKind validation for enhancement freeform", () => {
    // Workflow passes storedKind from the enhancement label; empty feature form still fails.
    const result = validateIssue({
      title: "How do I configure?",
      body: "Just a random question about setup.",
      labels: ["enhancement"],
      storedKind: "feature",
    });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => /missing or empty/i.test(r)));
  });
});

// ---------------------------------------------------------------------------
// workflow_dispatch guards
// ---------------------------------------------------------------------------

describe("rejectsWorkflowDispatchPullRequest", () => {
  it("rejects pull request numbers on workflow_dispatch", () => {
    assert.equal(
      rejectsWorkflowDispatchPullRequest({ pull_request: {} }, 423, "workflow_dispatch"),
      "#423 is a pull request. This workflow only accepts issue numbers.",
    );
  });

  it("allows issues and non-dispatch events", () => {
    assert.equal(rejectsWorkflowDispatchPullRequest({ pull_request: {} }, 423, "issues"), null);
    assert.equal(rejectsWorkflowDispatchPullRequest({}, 42, "workflow_dispatch"), null);
  });
});

describe("rejectsWorkflowDispatchNonDefaultBranch", () => {
  it("rejects workflow_dispatch runs that are not on the default branch", () => {
    assert.equal(
      rejectsWorkflowDispatchNonDefaultBranch(
        "workflow_dispatch",
        "refs/heads/fix/issue-quality-low-effort-reports",
        "main",
      ),
      "workflow_dispatch must run from the default branch (main); selected ref was refs/heads/fix/issue-quality-low-effort-reports.",
    );
  });

  it("allows default-branch dispatches and normal issue events", () => {
    assert.equal(
      rejectsWorkflowDispatchNonDefaultBranch("workflow_dispatch", "refs/heads/main", "main"),
      null,
    );
    assert.equal(
      rejectsWorkflowDispatchNonDefaultBranch(
        "issues",
        "refs/heads/fix/issue-quality-low-effort-reports",
        "main",
      ),
      null,
    );
  });
});
