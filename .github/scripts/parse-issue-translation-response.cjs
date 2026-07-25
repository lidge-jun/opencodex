"use strict";

const fs = require("fs");
const crypto = require("crypto");

function scrubLine(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function parseAiResponse(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(
        text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim(),
      );
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

function writeOutput(key, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function writeMultilineOutput(key, value) {
  const delim = `${key.toUpperCase()}_${crypto.randomBytes(16).toString("hex")}`;
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${key}<<${delim}\n${value}\n${delim}\n`,
  );
}

function main() {
  if (!process.env.GITHUB_OUTPUT) {
    console.error("GITHUB_OUTPUT is not set");
    process.exit(1);
  }

  const parsed = parseAiResponse(process.env.AI_RESPONSE);
  if (!parsed) {
    // Still emit outputs so the workflow can persist rate-limit state.
    console.warn("::warning::Issue translation AI response was empty or not valid JSON.");
    writeOutput("requires_translation", "false");
    writeOutput("detected_language", "unknown");
    return;
  }

  if (parsed.requires_translation !== true) {
    const lang = scrubLine(parsed.detected_language || "English", 64) || "English";
    writeOutput("requires_translation", "false");
    writeOutput("detected_language", lang);
    return;
  }

  const lang = scrubLine(parsed.detected_language || "non-English", 64) || "non-English";
  const title = scrubLine(parsed.translated_title, 256);
  const body = String(parsed.translated_body || "").replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    "",
  );

  writeOutput("requires_translation", "true");
  writeOutput("detected_language", lang);
  writeOutput("translated_title", title);
  writeMultilineOutput("translated_body", body);
}

if (require.main === module) {
  main();
}

module.exports = {
  scrubLine,
  parseAiResponse,
  main,
};
