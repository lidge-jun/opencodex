"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateIssue } = require("./issue-quality.cjs");

test("accepts #1162-shaped bug evidence without literal Reproduction/Version/OS headings", () => {
  const result = validateIssue({
    title: "[Bug]: Cursor Claude-family models fail after stream start while non-Claude models pass",
    labels: ["bug"],
    body: `
### Client or integration
Claude Code

### Summary
Cursor Claude-family models deterministically fail through the Claude Code path after the stream starts, while non-Claude Cursor models complete normally using the same provider and installation.

### Environment
- OpenCodex: 2.10.2
- OS: Linux (Ubuntu x64)
- Claude Code: 1.0.88

### What fails / what passes
- \`cursor/claude-sonnet-4.5\` -> FAIL with \`resource_exhausted\` after stream start.
- \`cursor/grok-4.5\` -> PASS using the same request path.

### Debug evidence (ocx debug provider)
Run \`ocx debug provider cursor\` and send the same request through the Claude Code integration.

\`\`\`text
Provider error: resource_exhausted after stream start
request failed after the first streamed frame
\`\`\`
`,
  });

  assert.equal(result.valid, true, result.reasons.join("\n"));
});

test("accepts emphasized Environment keys", () => {
  const result = validateIssue({
    title: "[Bug]: Cursor request fails after stream start",
    labels: ["bug"],
    body: `
### Client or integration
Claude Code

### Summary
The Cursor request fails after streaming starts through the Claude Code integration.

### Environment
- **OpenCodex**: 2.10.2
- **OS**: Linux (Ubuntu x64)

### Debug evidence
Run ocx debug provider cursor; the request fails with \`resource_exhausted\` after stream start.
`,
  });

  assert.equal(result.valid, true, result.reasons.join("\n"));
});

test("does not duplicate case-insensitive reproduction aliases", () => {
  const repeated = "Run `ocx start` and observe the proxy error after the request fails.";
  const result = validateIssue({
    title: "[Bug]: Proxy request fails",
    labels: ["bug"],
    body: `
### Client or integration
Claude Code

### Summary
${repeated}

### Environment
- OpenCodex: 2.10.2
- OS: Linux

### Steps to Reproduce
${repeated}
`,
  });

  assert.equal(result.valid, false);
  assert.match(result.reasons.join("\n"), /same content/i);
});

test("does not treat vague alternative headings as actionable reproduction", () => {
  const result = validateIssue({
    title: "[Bug]: Cursor model does not work",
    labels: ["bug"],
    body: `
### Client or integration
Claude Code

### Summary
The selected Cursor model does not complete a request through the Claude Code integration.

### Environment
- OpenCodex: 2.10.2
- OS: Linux

### What fails / what passes
It does not work.
`,
  });

  assert.equal(result.valid, false);
  assert.match(result.reasons.join("\n"), /Reproduction/i);
});

test("still rejects an unknown OpenCodex version from Environment", () => {
  const result = validateIssue({
    title: "[Bug]: Cursor request fails",
    labels: ["bug"],
    body: `
### Client or integration
Claude Code

### Summary
A Cursor request fails after the proxy starts streaming a response through Claude Code.

### Environment
- OpenCodex: unknown
- OS: Linux

### Debug evidence
Run \`ocx debug provider cursor\`; it returns \`resource_exhausted\` after stream start.
`,
  });

  assert.equal(result.valid, false);
  assert.match(result.reasons.join("\n"), /Version/i);
});

test("still rejects missing OS metadata from Environment", () => {
  const result = validateIssue({
    title: "[Bug]: Cursor request fails",
    labels: ["bug"],
    body: `
### Client or integration
Claude Code

### Summary
A Cursor request fails after the proxy starts streaming a response through Claude Code.

### Environment
- OpenCodex: 2.10.2

### Debug evidence
Run \`ocx debug provider cursor\`; it returns \`resource_exhausted\` after stream start.
`,
  });

  assert.equal(result.valid, false);
  assert.match(result.reasons.join("\n"), /Operating system/i);
});
