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

/**
 * Models often emit JS-style escapes inside JSON strings (especially `\'`).
 * Those are invalid JSON and used to make long Korean/Japanese issue translations
 * fail closed even when the payload is otherwise complete.
 *
 * Only `\'` drops the backslash (apostrophe needs no JSON escape). Other unknown
 * escapes (e.g. `\Users`, `\d+`, `\x41`) are rewritten as doubled backslashes so
 * JSON.parse keeps a literal `\` — dropping them would corrupt Markdown/code.
 */
function repairInvalidJsonStringEscapes(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      if ('"\\/bfnrt'.includes(ch)) {
        out += "\\" + ch;
      } else if (ch === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
        out += "\\u";
      } else if (ch === "'") {
        // JS-style apostrophe escape → plain apostrophe in JSON.
        out += "'";
      } else {
        // Preserve a literal backslash in the parsed string (C:\Users, \d+, \x41).
        out += "\\\\" + ch;
      }
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = false;
    out += ch;
  }
  if (escaped) out += "\\\\";
  return out;
}

function tryParseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseAiResponse(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  return (
    tryParseJsonObject(text) ||
    tryParseJsonObject(unfenced) ||
    tryParseJsonObject(repairInvalidJsonStringEscapes(text)) ||
    tryParseJsonObject(repairInvalidJsonStringEscapes(unfenced))
  );
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
    // Do not mark the source complete — invalid output must remain retryable.
    console.warn("::warning::Issue translation AI response was empty or not valid JSON.");
    writeOutput("requires_translation", "false");
    writeOutput("detected_language", "unknown");
    writeOutput("source_complete", "false");
    return;
  }

  // Only boolean false is a completed no-translation decision. Strings/null/numbers
  // must not mark the source complete (remain retryable after cooldown).
  if (parsed.requires_translation === false) {
    const lang = scrubLine(parsed.detected_language || "English", 64) || "English";
    writeOutput("requires_translation", "false");
    writeOutput("detected_language", lang);
    writeOutput("source_complete", "true");
    return;
  }

  if (parsed.requires_translation !== true) {
    console.warn("::warning::Issue translation AI response had an invalid requires_translation value.");
    writeOutput("requires_translation", "false");
    writeOutput("detected_language", "unknown");
    writeOutput("source_complete", "false");
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
  // Apply step marks complete only after a successful issue/comment update.
  writeOutput("source_complete", "false");
}

if (require.main === module) {
  main();
}

module.exports = {
  scrubLine,
  repairInvalidJsonStringEscapes,
  parseAiResponse,
  main,
};
