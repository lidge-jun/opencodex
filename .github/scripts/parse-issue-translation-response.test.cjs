"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "parse-issue-translation-response.cjs");
const { parseAiResponse, scrubLine } = require("./parse-issue-translation-response.cjs");

function runParser(aiResponse) {
  const outFile = path.join(
    os.tmpdir(),
    `ocx-parse-out-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  fs.writeFileSync(outFile, "");
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      AI_RESPONSE: aiResponse,
      GITHUB_OUTPUT: outFile,
    },
    encoding: "utf8",
  });
  const output = fs.readFileSync(outFile, "utf8");
  fs.unlinkSync(outFile);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output };
}

function parseOutputs(raw) {
  const lines = String(raw || "").split("\n");
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const delimMatch = line.match(/^([A-Za-z0-9_]+)<<(.+)$/);
    if (delimMatch) {
      const [, key, delim] = delimMatch;
      const body = [];
      i += 1;
      while (i < lines.length && lines[i] !== delim) {
        body.push(lines[i]);
        i += 1;
      }
      out[key] = body.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("parseAiResponse", () => {
  it("parses plain JSON objects", () => {
    assert.deepEqual(parseAiResponse('{"requires_translation":false}'), {
      requires_translation: false,
    });
  });

  it("parses fenced JSON", () => {
    const raw = "```json\n{\"requires_translation\":true,\"translated_title\":\"T\"}\n```";
    assert.equal(parseAiResponse(raw).translated_title, "T");
  });

  it("rejects invalid JSON, empty input, and arrays", () => {
    assert.equal(parseAiResponse(""), null);
    assert.equal(parseAiResponse("{"), null);
    assert.equal(parseAiResponse("[1]"), null);
  });
});

describe("parse-issue-translation-response process", () => {
  it("writes translated outputs for requires_translation=true", () => {
    const { status, output } = runParser(JSON.stringify({
      requires_translation: true,
      detected_language: "German",
      translated_title: "Proxy does not start",
      translated_body: "The proxy does not start.",
    }));
    assert.equal(status, 0);
    const parsed = parseOutputs(output);
    assert.equal(parsed.requires_translation, "true");
    assert.equal(parsed.detected_language, "German");
    assert.equal(parsed.translated_title, "Proxy does not start");
    assert.equal(parsed.translated_body, "The proxy does not start.");
  });

  it("writes English path without translation fields", () => {
    const { status, output } = runParser(JSON.stringify({
      requires_translation: false,
      detected_language: "English",
      translated_title: "",
      translated_body: "",
    }));
    assert.equal(status, 0);
    const parsed = parseOutputs(output);
    assert.equal(parsed.requires_translation, "false");
    assert.equal(parsed.detected_language, "English");
    assert.equal(parsed.translated_title, undefined);
  });

  it("treats string requires_translation as false path", () => {
    const { status, output } = runParser(JSON.stringify({
      requires_translation: "true",
      detected_language: "German",
    }));
    assert.equal(status, 0);
    assert.equal(parseOutputs(output).requires_translation, "false");
  });

  it("supports multiline bodies and shell-looking content", () => {
    const body = "line1\n$(rm -rf /)\nBODY_abc\n\"quotes\"\n`ticks`";
    const { status, output } = runParser(JSON.stringify({
      requires_translation: true,
      detected_language: "German",
      translated_title: "T",
      translated_body: body,
    }));
    assert.equal(status, 0);
    assert.equal(parseOutputs(output).translated_body, body);
  });

  it("writes false outputs on invalid JSON and empty responses", () => {
    for (const raw of ["{", "", "[]"]) {
      const { status, output } = runParser(raw);
      assert.equal(status, 0);
      const parsed = parseOutputs(output);
      assert.equal(parsed.requires_translation, "false");
      assert.equal(parsed.detected_language, "unknown");
    }
  });

  it("parses fenced responses in the process path", () => {
    const raw = "```json\n" + JSON.stringify({
      requires_translation: true,
      detected_language: "Japanese",
      translated_title: "Title",
      translated_body: "Body",
    }) + "\n```";
    const { status, output } = runParser(raw);
    assert.equal(status, 0);
    assert.equal(parseOutputs(output).requires_translation, "true");
    assert.equal(parseOutputs(output).translated_title, "Title");
  });

  it("scrubs control characters from language and title", () => {
    assert.equal(scrubLine("German\u0000-->@x", 64), "German -->@x");
    const { output } = runParser(JSON.stringify({
      requires_translation: true,
      detected_language: "German\u0007",
      translated_title: "A".repeat(300),
      translated_body: "ok",
    }));
    const parsed = parseOutputs(output);
    assert.equal(parsed.detected_language, "German");
    assert.equal(parsed.translated_title.length, 256);
  });
});
