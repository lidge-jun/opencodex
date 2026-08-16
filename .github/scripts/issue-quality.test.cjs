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
  AREA_LABELS,
  mapAreaFieldToLabels,
  detectAreaLabels,
  isPlaceholderOnlyValue,
  isPlaceholder,
  isRawPlaceholder,
  isUnusableVersion,
  stripMediaTokens,
  isMediaOnly,
  countWords,
  hasConcreteDetail,
  hasActionableReproductionDetail,
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

  it("rejects an image-only goal section that hides repeated prose (#1098)", () => {
    // Regression for #1098: an HTML <img> in the goal section made the goal
    // look non-empty, so the repeated identical sentences in the other three
    // sections were not caught as duplicates and the issue passed validation.
    const repeated =
      "It is hoped that the usage query will support time-based queries and statistics, as well as key-based queries and statistics";
    const img =
      '<img width="2474" height="1071" alt="Image" src="https://github.com/user-attachments/assets/17ea27a8-cec6-4591-aa09-a0ce36f1211f" />';
    const body = [
      "### Area",
      "CLI",
      "### What are you trying to accomplish?",
      img,
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
    assert.ok(
      result.reasons.some((r) => /missing or empty/i.test(r)),
      `Expected missing/empty reason, got: ${result.reasons.join("; ")}`,
    );
    assert.ok(
      result.reasons.some((r) => /same content/i.test(r)),
      `Expected duplicate-content reason, got: ${result.reasons.join("; ")}`,
    );
    assert.ok(
      result.reasons.some((r) => /repeat the issue title/i.test(r)),
      `Expected repeated-title reason, got: ${result.reasons.join("; ")}`,
    );
  });

  it("rejects a markdown-image-only goal section with repeated prose (#1098)", () => {
    const repeated =
      "It is hoped that the usage query will support time-based queries and statistics, as well as key-based queries and statistics";
    const mdImg = "![Image](https://github.com/user-attachments/assets/17ea27a8-cec6-4591-aa09-a0ce36f1211f)";
    const body = [
      "### What are you trying to accomplish?",
      mdImg,
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
    assert.ok(
      result.reasons.some((r) => /missing or empty/i.test(r)),
      `Expected missing/empty reason, got: ${result.reasons.join("; ")}`,
    );
  });

  it("rejects a markdown image with bracketed alt text in the goal (#1098)", () => {
    const repeated =
      "It is hoped that the usage query will support time-based queries and statistics, as well as key-based queries and statistics";
    // GitHub permits balanced brackets inside image alt text, e.g.
    // ![Image [screenshot]](url). The stripper must still treat it as
    // media-only so it cannot hide repeated prose.
    const mdImg = "![Image [screenshot]](https://example.com/x.png)";
    const body = [
      "### What are you trying to accomplish?",
      mdImg,
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
    assert.ok(
      result.reasons.some((r) => /missing or empty/i.test(r)),
      `Expected missing/empty reason, got: ${result.reasons.join("; ")}`,
    );
  });

  it("rejects a markdown image whose URL contains balanced parentheses (#1098)", () => {
    const repeated =
      "It is hoped that the usage query will support time-based queries and statistics, as well as key-based queries and statistics";
    // Markdown destinations may contain balanced parentheses, e.g.
    // ![diagram](https://example.com/image_(final).png). The stripper must
    // still treat it as media-only so it cannot hide repeated prose.
    const mdImg = "![diagram](https://example.com/image_(final).png)";
    const body = [
      "### What are you trying to accomplish?",
      mdImg,
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
    assert.ok(
      result.reasons.some((r) => /missing or empty/i.test(r)),
      `Expected missing/empty reason, got: ${result.reasons.join("; ")}`,
    );
  });

  it("preserves a goal section that mixes an image with real text", () => {
    const goal = [
      "![Screenshot](https://example.com/shot.png)",
      "Route voice requests to a configured fallback provider when the primary quota is exhausted.",
    ].join("\n");
    const result = validateIssue({
      title: "Voice fallback routing",
      body: featureBodyWithGoal(goal),
      labels: ["enhancement"],
    });
    assert.equal(result.kind, "feature");
    assert.equal(result.valid, true);
  });

  it("treats image/media-only sections as empty via isMediaOnly", () => {
    assert.equal(isMediaOnly('<img src="x.png" />'), true);
    assert.equal(isMediaOnly("![alt](https://example.com/x.png)"), true);
    assert.equal(isMediaOnly("![alt [with bracket]](https://example.com/x.png)"), true);
    assert.equal(isMediaOnly("![diagram](https://example.com/image_(final).png)"), true);
    assert.equal(isMediaOnly('![alt](https://example.com/image_(final).png "title")'), true);
    assert.equal(isMediaOnly("![bad](https://example.com/a)b.png)"), false);
    assert.equal(isMediaOnly("\\![escaped](url)"), false);
    // Reference-style images (Codex bot finding): inline ref + definition.
    assert.equal(isMediaOnly("![Image][shot]\n\n[shot]: https://example.com/x.png"), true);
    assert.equal(isMediaOnly("![Image][]\n\n[Image]: https://example.com/x.png"), true);
    assert.equal(isMediaOnly("![Image][shot]\n\n[shot]: https://example.com/x.png\ncaption"), false);
    // Fallback prose inside media blocks is preserved (Codex bot finding).
    assert.equal(
      isMediaOnly("<video controls>Route voice requests through the configured fallback provider when quota is exhausted.</video>"),
      false,
    );
    assert.equal(isMediaOnly('<audio src="a.mp3"></audio>'), true);
    assert.equal(isMediaOnly("<picture>Fallback image description</picture>"), false);
    // Indented code blocks render as literal code, not images (Codex bot finding).
    assert.equal(isMediaOnly("    ![provider status](https://example.com/status.png)"), false);
    assert.equal(isMediaOnly("\t![provider status](https://example.com/status.png)"), false);
    // HTML media inside indented code is also literal code (CodeRabbit finding).
    assert.equal(isMediaOnly('    <img src="x.png">'), false);
    assert.equal(isMediaOnly('    <video src="v.mp4"></video>'), false);
    assert.equal(isMediaOnly('\t<img src="x.png">'), false);
    // Reference labels with nested alt brackets (CodeRabbit finding).
    assert.equal(isMediaOnly("![Image [screenshot]][shot]\n\n[shot]: https://example.com/x.png"), true);
    assert.equal(
      isMediaOnly("![Image [screenshot]][shot]\n\n[shot]: https://example.com/x.png\ncaption"),
      false,
    );
    assert.equal(isMediaOnly('<picture><source srcset="x.webp"><img src="x.png"></picture>'), true);
    assert.equal(isMediaOnly('<video>No response</video>'), true);
    assert.equal(isMediaOnly('<audio> _No response_ </audio>'), true);
    assert.equal(isMediaOnly('<video><p><em>No response</em></p></video>'), true);
    assert.equal(clean('<video>No response</video>'), "");
    for (const caption of [
      "TBD",
      "N/A",
      "None",
      "설명 없음",
      "🎬",
      "demo.mp4",
      "https://example.com/demo.mp4",
    ]) {
      const media = `<video>${caption}</video>`;
      assert.equal(stripMediaTokens(media), media, `caption must survive: ${caption}`);
      assert.equal(isMediaOnly(media), false, `caption must be substantive: ${caption}`);
      assert.equal(clean(media), media, `caption must survive cleaning: ${caption}`);
    }
    assert.equal(
      isMediaOnly('<picture>\n    <source srcset="x.webp">\n    <img src="x.png">\n</picture>'),
      true,
    );
    assert.equal(
      isMediaOnly('<video>\n    <source src="clip.mp4">\n    Real fallback caption\n</video>'),
      false,
    );
    assert.equal(
      isMediaOnly([
        "<picture",
        '    data-kind="responsive"',
        ">",
        '    <source srcset="x.webp">',
        '    <img src="x.png">',
        "</picture>",
      ].join("\n")),
      true,
    );
    assert.equal(isMediaOnly('<video src="clip.mp4"></video>'), true);
    assert.equal(isMediaOnly('<img src="x.png" />\nCaption text'), false);
    assert.equal(isMediaOnly("Some real description."), false);
    assert.equal(stripMediaTokens('<img src="x.png" />').trim(), "");
    assert.equal(stripMediaTokens('![alt](url "title")').trim(), "");
    assert.equal(stripMediaTokens('before ![alt](url) after').replace(/\s+/g, " ").trim(), "before after");

    const fencedMediaExample = [
      "```html",
      "<video>No response</video>",
      "```",
    ].join("\n");
    assert.equal(stripMediaTokens(fencedMediaExample), fencedMediaExample);
    assert.equal(isMediaOnly(fencedMediaExample), false);

    const protectedAroundMedia = [
      "    ![before](url)",
      "<video>",
      '    <source src="clip.mp4">',
      "</video>",
      "    ![after](url)",
    ].join("\n");
    const strippedAroundMedia = stripMediaTokens(protectedAroundMedia);
    assert.ok(strippedAroundMedia.includes("    ![before](url)"));
    assert.ok(strippedAroundMedia.includes("    ![after](url)"));
    assert.equal(strippedAroundMedia.includes("<video>"), false);
    assert.equal(strippedAroundMedia.includes("<source"), false);
    assert.equal(strippedAroundMedia.includes("\u0000"), false);
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
        result.reasons.some((r) => r.includes("too vague") || /missing or empty/i.test(r)),
        `Expected too vague or empty reason for "${goal}", got: ${result.reasons.join(", ")}`,
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

  it("treats only commands, errors, paths, or exact actions as actionable reproduction detail", () => {
    assert.equal(hasActionableReproductionDetail("1. choose model deepseek\n2. send a message in codex plugin"), false);
    assert.equal(hasActionableReproductionDetail("I want to work with deepseek in VSCode, but it dont reply"), false);
    assert.equal(hasActionableReproductionDetail("1. ocx start --port 10100\n2. Send a request"), true);
    assert.equal(hasActionableReproductionDetail("Run ocx start and send any streaming request."), true);
    assert.equal(hasActionableReproductionDetail("ocx start on Raspberry Pi 4, send any streaming request."), true);
    assert.equal(hasActionableReproductionDetail("send a request"), false);
    assert.equal(hasActionableReproductionDetail("make a call"), false);
    assert.equal(hasActionableReproductionDetail("post a command"), false);
    assert.equal(hasActionableReproductionDetail("make an API call"), true);
    assert.equal(hasActionableReproductionDetail("send an HTTP request"), true);
    assert.equal(hasActionableReproductionDetail("send a request to /v1/responses"), true);
    assert.equal(hasActionableReproductionDetail("The proxy returns HTTP 502 after the first streaming chunk."), true);
    assert.equal(hasActionableReproductionDetail("Paste ~/.codex/config.toml, then restart the proxy."), true);
    assert.equal(hasActionableReproductionDetail("```\n\n```"), false);
    assert.equal(hasActionableReproductionDetail("~~~\n\n~~~"), false);
    assert.equal(hasActionableReproductionDetail("```\nSIGSEGV at 0x0000\n```"), true);
  });

  it("bounds long non-matching reproduction path tokens", () => {
    const startedAt = performance.now();
    assert.equal(hasActionableReproductionDetail(`${"a".repeat(60_000)}.unknown`), false);
    assert.ok(performance.now() - startedAt < 500, "actionable reproduction check took too long");
    assert.equal(hasActionableReproductionDetail("CONFIG.JSON"), true);
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

  it("rejects a bug with Summary filled but Reproduction empty", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "CLI",
      "### Summary",
      "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
      "### Reproduction",
      "No response",
      "### Version",
      "2.7.42",
      "### Operating system",
      "macOS",
    ].join("\n");
    const result = validateIssue({ title: "Open Codex Error", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => /Reproduction is empty/i.test(r)));
    assert.ok(!result.reasons.some((r) => /Summary is empty/i.test(r)));
  });

  it("rejects a bug whose Reproduction is only an ellipsis (#598)", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "CLI",
      "### Summary",
      "{\"detail\":\"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.\"}",
      "### Reproduction",
      "...",
      "### Version",
      "2.7.42",
      "### Operating system",
      "mac os",
    ].join("\n");
    const result = validateIssue({ title: "Open Codex Error", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => /Reproduction is empty/i.test(r)));
  });

  it("rejects a bug with Reproduction filled but Summary empty", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "CLI",
      "### Summary",
      "",
      "### Reproduction",
      "1. Run ocx start\n2. Send a request",
      "### Version",
      "2.7.42",
      "### Operating system",
      "macOS",
    ].join("\n");
    const result = validateIssue({ title: "Crash", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => /Summary is empty/i.test(r)));
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

  it("rejects unknown / don't-know Version values (#624)", () => {
    const versions = [
      "Unknown",
      "Uknown",
      "unkown",
      "Don't know",
      "dont know",
      "idk",
      "모름",
      "잘 모름",
      "?",
      "???",
    ];
    for (const version of versions) {
      const body = [
        "### Client or integration",
        "Codex CLI",
        "### Area",
        "CLI",
        "### Summary",
        "The OpenCodex proxy keeps dropping the Codex CLI connection mid-request.",
        "### Reproduction",
        "1. ocx start --port 10100",
        "2. Send any Codex CLI request through the proxy",
        "3. Observe the connection drop",
        "### Version",
        version,
        "### Operating system",
        "Windows 11",
      ].join("\n");
      const result = validateIssue({
        title: "Unexpected interruption continues to occur",
        body,
        labels: ["bug"],
      });
      assert.equal(result.kind, "bug");
      assert.equal(
        result.valid,
        false,
        `Expected unusable Version "${version}" to be invalid, got: ${result.reasons.join("; ")}`,
      );
      assert.ok(
        result.reasons.some((r) => /Version/i.test(r) && /unknown|missing/i.test(r)),
        `Expected Version unknown/missing reason for "${version}", got: ${result.reasons.join("; ")}`,
      );
    }
  });

  it("rejects issue #624-style low-effort new-form bug", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "CLI",
      "### Summary",
      "CLI로 확인해봤는데 오픈코덱스 프록시가 중간에 자꾸 연결이 끊어져서 그런거라고 합니다.",
      "",
      "수정 바랍니다.",
      "### Reproduction",
      "예기치않게중단됨",
      "### Version",
      "모름",
      "### Operating system",
      "윈11",
      "### Provider and model",
      "_No response_",
      "### Logs or error output",
      "```shell",
      "",
      "```",
    ].join("\n");
    const result = validateIssue({
      title: "Unexpected interruption continues to occur",
      body,
      labels: ["bug"],
    });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => /Version/i.test(r)));
    assert.ok(result.reasons.some((r) => /Reproduction/i.test(r) && /vague|empty/i.test(r)));
  });

  it("rejects a new-form bug with a usable Version but placeholder OS", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "CLI",
      "### Summary",
      "Proxy returns 502 when streaming is enabled on Windows.",
      "### Reproduction",
      "1. ocx start",
      "2. Send a streaming /v1/responses request",
      "### Version",
      "2.7.42",
      "### Operating system",
      "No response",
    ].join("\n");
    const result = validateIssue({ title: "Streaming 502", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => /Operating system/i.test(r)));
  });

  it("rejects a new-form bug when the Version heading was removed", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "CLI",
      "### Summary",
      "Proxy returns 502 when streaming is enabled on Windows.",
      "### Reproduction",
      "1. ocx start",
      "2. Send a streaming /v1/responses request",
      "### Operating system",
      "Windows 11",
    ].join("\n");
    const result = validateIssue({ title: "Streaming 502", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => /Version/i.test(r) && /missing/i.test(r)));
  });

  it("rejects a new-form bug when the Operating system heading was removed", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "CLI",
      "### Summary",
      "Proxy returns 502 when streaming is enabled on Windows.",
      "### Reproduction",
      "1. ocx start",
      "2. Send a streaming /v1/responses request",
      "### Version",
      "2.7.42",
    ].join("\n");
    const result = validateIssue({ title: "Streaming 502", body, labels: ["bug"] });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => /Operating system/i.test(r) && /missing/i.test(r)));
  });

  it("rejects a new-form bug whose Reproduction is only a vague phrase", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "CLI",
      "### Summary",
      "The OpenCodex proxy keeps dropping the Codex CLI connection mid-request.",
      "### Reproduction",
      "Unexpected interruption",
      "### Version",
      "2.7.42",
      "### Operating system",
      "Windows 11",
    ].join("\n");
    const result = validateIssue({
      title: "Unexpected interruption continues to occur",
      body,
      labels: ["bug"],
    });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => /Reproduction/i.test(r) && /vague/i.test(r)));
  });

  it("rejects a #977-shaped bug with product keywords but no actionable reproduction", () => {
    const body = [
      "### Client or integration",
      "Other",
      "### Area",
      "Proxy and routing",
      "### Summary",
      "I want to work with deepseek in VSCode, but it dont reply,just thinking",
      "### Reproduction",
      "1.choose model deepseek",
      "2.send a message in codex plugin",
      "### Version",
      "2.10.0",
      "### Operating system",
      "Ubuntu 24.04",
      "### Provider and model",
      "deepseek",
    ].join("\n");
    const result = validateIssue({
      title: "Dont work in VSCode Codex plugin",
      body,
      labels: ["bug", "proxy"],
    });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(
      result.reasons.some((r) => /Reproduction/i.test(r) && /vague/i.test(r)),
      `Expected a vague Reproduction reason, got: ${result.reasons.join("; ")}`,
    );
    assert.ok(
      result.guidance.some((g) => /commands|steps/i.test(g)),
      `Expected reproduction guidance, got: ${result.guidance.join("; ")}`,
    );
  });

  it("rejects unknown Operating system stand-ins on the new bug form", () => {
    const body = [
      "### Client or integration",
      "Codex CLI",
      "### Area",
      "CLI",
      "### Summary",
      "The OpenCodex proxy keeps dropping the Codex CLI connection mid-request.",
      "### Reproduction",
      "1. ocx start --port 10100",
      "2. Send any Codex CLI request through the proxy",
      "3. Observe the connection drop",
      "### Version",
      "2.7.42",
      "### Operating system",
      "Unknown",
    ].join("\n");
    const result = validateIssue({
      title: "Unexpected interruption continues to occur",
      body,
      labels: ["bug"],
    });
    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => /Operating system/i.test(r)));
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

  it("detects unusable Version stand-ins without treating them as generic placeholders", () => {
    for (const value of ["Unknown", "Uknown", "모름", "idk", "don't know"]) {
      assert.equal(isUnusableVersion(value), true, value);
      assert.equal(isPlaceholderOnlyValue(value), false, value);
    }
    for (const value of ["2.7.42", "N/A", "No response", "main@abc1234"]) {
      assert.equal(isUnusableVersion(value), false, value);
    }
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
    assert.equal(clean("<!--\nhidden issue text"), "");
    assert.equal(clean("<!-- hidden -->\nVisible text"), "Visible text");
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

// ---------------------------------------------------------------------------
// Orthogonal area labels
// ---------------------------------------------------------------------------

describe("mapAreaFieldToLabels", () => {
  it("maps canonical Area dropdown values", () => {
    assert.deepEqual(mapAreaFieldToLabels("CLI"), ["cli"]);
    assert.deepEqual(mapAreaFieldToLabels("Proxy and routing"), ["proxy"]);
    assert.deepEqual(mapAreaFieldToLabels("Dashboard"), ["gui"]);
    assert.deepEqual(mapAreaFieldToLabels("Provider adapter"), ["provider"]);
    assert.deepEqual(mapAreaFieldToLabels("Provider adapters"), ["provider"]);
    assert.deepEqual(mapAreaFieldToLabels("Authentication and account pool"), ["account-pool"]);
    assert.deepEqual(mapAreaFieldToLabels("Catalog / models"), ["catalog"]);
    assert.deepEqual(mapAreaFieldToLabels("Streaming"), ["streaming"]);
    assert.deepEqual(mapAreaFieldToLabels("Tools / MCP / web search"), ["tools"]);
    assert.deepEqual(mapAreaFieldToLabels("Installation or packaging"), ["install"]);
    assert.deepEqual(mapAreaFieldToLabels("Service lifecycle"), ["service"]);
    assert.deepEqual(mapAreaFieldToLabels("Platform (Windows / macOS / Linux)"), ["platform"]);
    assert.deepEqual(mapAreaFieldToLabels("Documentation"), []);
  });

  it("maps legacy Service lifecycle wording and ignores Other / Multiple areas", () => {
    assert.deepEqual(mapAreaFieldToLabels("Service lifecycle (config injection)"), ["service"]);
    assert.deepEqual(mapAreaFieldToLabels("Other"), []);
    assert.deepEqual(mapAreaFieldToLabels("Multiple areas"), []);
    assert.deepEqual(mapAreaFieldToLabels(""), []);
    assert.deepEqual(mapAreaFieldToLabels(null), []);
  });

  it("exposes metadata for every non-documentation area label", () => {
    for (const name of Object.keys(AREA_LABELS)) {
      assert.ok(AREA_LABELS[name].color, name);
      assert.ok(AREA_LABELS[name].description, name);
    }
  });
});

describe("detectAreaLabels", () => {
  it("applies Area mapping plus orthogonal heuristics", () => {
    const labels = detectAreaLabels({
      title: "Pool failover stalls on SSE without terminal frame",
      body: [
        "### Area",
        "Authentication and account pool",
        "### Summary",
        "Account pool failover waits forever when the upstream SSE stream ends without a terminal frame.",
      ].join("\n"),
      labels: ["bug"],
    });
    assert.ok(labels.includes("account-pool"));
    assert.ok(labels.includes("streaming"));
  });

  it("adds provider for provider-compatibility form and label", () => {
    const fromLabel = detectAreaLabels({
      title: "AgentRouter Anthropic streams can end without terminal SSE frames",
      body: "### Summary\nStream ends early.",
      labels: ["provider-compatibility"],
    });
    assert.ok(fromLabel.includes("provider"));
    assert.ok(fromLabel.includes("streaming"));

    const fromHeading = detectAreaLabels({
      title: "Custom relay rejects tool_calls",
      body: [
        "### Provider or upstream service",
        "Volcengine Ark",
        "### Current behaviour",
        "tool_calls with empty content return 400.",
      ].join("\n"),
      labels: [],
    });
    assert.ok(fromHeading.includes("provider"));
    assert.ok(fromHeading.includes("tools"));
  });

  it("runs heuristics for Multiple areas / Other without inventing per-provider labels", () => {
    const labels = detectAreaLabels({
      title: "Dashboard ACL hardening blocks management API on Windows",
      body: [
        "### Area",
        "Multiple areas",
        "### Summary",
        "Management API fails closed when icacls hardening cannot be verified.",
      ].join("\n"),
      labels: ["bug"],
    });
    assert.ok(labels.includes("gui"), `got ${labels.join(",")}`);
    assert.ok(labels.includes("platform"), `got ${labels.join(",")}`);
    assert.ok(labels.includes("proxy"), `got ${labels.join(",")}`);
    assert.equal(labels.includes("kiro"), false);
    assert.equal(labels.includes("gemini"), false);
    assert.equal(labels.includes("windows"), false);
  });

  it("does not map Documentation Area onto the documentation kind label", () => {
    const labels = detectAreaLabels({
      title: "Codex Auth UI/docs conflate usage-based switching",
      body: ["### Area", "Documentation", "### Summary", "Docs misdefine new session."].join("\n"),
      labels: ["enhancement"],
    });
    assert.equal(labels.includes("documentation"), false);
    assert.equal(labels.includes("docs"), false);
  });

  it("ignores Operating system metadata for platform heuristics", () => {
    const labels = detectAreaLabels({
      title: "Dashboard shows empty providers tab",
      body: [
        "### Area",
        "Dashboard",
        "### Summary",
        "Providers tab is blank after login.",
        "### Operating system",
        "Windows 11",
        "### Reproduction",
        "1. Open the dashboard",
      ].join("\n"),
      labels: ["bug"],
    });
    assert.ok(labels.includes("gui"));
    assert.equal(labels.includes("platform"), false);
  });

  it("uses heuristicBody translation text when Area is Other", () => {
    const labels = detectAreaLabels({
      title: "问题报告",
      body: ["### Area", "Other", "### Summary", "原始描述"].join("\n"),
      heuristicBody: [
        "### Area",
        "Other",
        "### Summary",
        "Account pool failover fails when refresh token is already used.",
      ].join("\n"),
      labels: ["bug"],
    });
    assert.ok(labels.includes("account-pool"), `got ${labels.join(",")}`);
  });

  it("matches truncated streaming wording via truncat stem", () => {
    const labels = detectAreaLabels({
      title: "Upstream streaming response truncated mid-turn",
      body: ["### Area", "Other", "### Summary", "The streaming response was truncated."].join("\n"),
      labels: ["bug"],
    });
    assert.ok(labels.includes("streaming"), `got ${labels.join(",")}`);
  });
});

describe("clean() respects fenced code (regression)", () => {
  it("keeps section text that follows a comment-like literal in a fence", () => {
    // A `<!--` inside a code sample is literal text under GFM. Stripping
    // comments before fences let it run to EOF and swallow the rest of the
    // section, so a valid issue was rejected as too vague to act on.
    const goal = [
      "```html",
      "<!-- literal unclosed-comment example",
      "```",
      "",
      "The provider catalog fails to load on startup and blocks routing.",
    ].join("\n");

    assert.ok(clean(goal).includes("provider catalog fails to load"));
  });

  it("still strips a real HTML comment outside code", () => {
    assert.equal(clean("<!-- hidden -->").trim(), "");
  });
});

describe("code-region scanning is GFM-correct and linear (regression)", () => {
  it("honors a closing fence longer than its opener", () => {
    // GFM allows the closing fence to be longer. Requiring an exact-length
    // match left the block unterminated, so the comment inside it ran to EOF
    // and swallowed the visible section below.
    const goal = ["```html", "<!-- literal example", "````", "", "The catalog fails to load."].join("\n");
    assert.ok(clean(goal).includes("The catalog fails to load."));
  });

  it("honors a code span containing a line ending", () => {
    const goal = ["`first", "second`", "", "The catalog fails to load."].join("\n");
    assert.ok(clean(goal).includes("The catalog fails to load."));
  });

  it("stays linear on adversarial input", () => {
    // The previous masker combined a variable-length delimiter capture, a lazy
    // whole-input scan and a backreference. A 60k-character body took ~10.5s
    // inside an automation trust boundary anyone can post to.
    const started = Date.now();
    clean("```html\n" + "x".repeat(60000) + "\n");
    clean("`a`".repeat(20000));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `code-region scan took ${elapsed}ms; expected a linear scan`);
  });
});
