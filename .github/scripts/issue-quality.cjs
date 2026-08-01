"use strict";

// ---------------------------------------------------------------------------
// Pure issue-quality validation for OpenCodex.
// CommonJS, zero runtime dependencies. No GitHub API calls.
// ---------------------------------------------------------------------------

/**
 * True when the entire meaningful value is a placeholder-only token.
 * Supports harmless Markdown emphasis/code markers and trailing punctuation.
 * Sentences that merely contain a placeholder phrase are not matches.
 */
const PLACEHOLDER_ONLY_RE =
  /^[\s_*~`]*(?:no\s+response|n\/?a|not\s+applicable|not\s+available|none|todo|tbd)[\s_*~`]*[.!?]*$/i;

/**
 * If `text` is exactly one enclosing fenced code block (``` or ~~~), return the
 * inner body; otherwise null. Real multi-statement fences are left alone by
 * the placeholder matcher after unwrap.
 */
function unwrapSingleEnclosingFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^(```|~~~)[^\n]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/);
  if (!match) return null;
  return match[2];
}

/**
 * Shared strip/trim/unwrap used by placeholder and unusable-stand-in matchers.
 * Returns null when the value is absent after normalisation.
 */
function normalizeRawSectionValue(raw) {
  if (typeof raw !== "string") return null;
  let value = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!value) return null;

  // A lone fenced block whose entire body is a stand-in is still a stand-in
  // (e.g. ```text\nN/A\n```), not a real example.
  const unwrapped = unwrapSingleEnclosingFence(value);
  if (unwrapped !== null) {
    value = unwrapped.trim();
    if (!value) return null;
  }

  return value;
}

function isPlaceholderOnlyValue(raw) {
  const value = normalizeRawSectionValue(raw);
  if (value === null) return false;
  return PLACEHOLDER_ONLY_RE.test(value);
}

/**
 * Strip HTML comments, placeholder-only values, and trim whitespace.
 */
function clean(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.replace(/<!--[\s\S]*?-->/g, "");
  // Whole-value placeholders first (including a single enclosing fence), so
  // line-by-line stripping cannot leave bare fence markers behind.
  if (isPlaceholderOnlyValue(s)) return "";
  // Treat placeholder-only lines (GitHub "No response", N/A, etc.) as empty.
  s = s
    .split("\n")
    .map((line) => (isPlaceholderOnlyValue(line) ? "" : line))
    .join("\n");
  if (isPlaceholderOnlyValue(s)) return "";
  return s.trim();
}

/**
 * Lowercase, strip punctuation (Unicode-aware), collapse whitespace.
 */
function normalise(raw) {
  return clean(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical form for duplicate detection: normalise + strip common filler
 * phrases that do not add semantic content.
 */
function canonicalise(raw) {
  let s = normalise(raw);
  const fillers = [
    /^i want to\s+/,
    /^we need to\s+/,
    /^would like to\s+/,
    /^i would like to\s+/,
    /^we would like to\s+/,
    /^please\s+/,
  ];
  for (const re of fillers) s = s.replace(re, "");
  return s.trim();
}

/**
 * Extract the text content of a markdown ### section by heading name.
 * Returns null when the heading is absent.
 */
function extractSection(body, heading) {
  if (typeof body !== "string") return null;
  const lines = body.split("\n");
  const headingLower = heading.toLowerCase().trim();
  let capturing = false;
  let sectionDepth = 0;
  let fence = null;
  const out = [];
  for (const line of lines) {
    if (fence) {
      if (new RegExp(`^[ \\t]{0,3}${fence.marker}{${fence.length},}[ \\t]*$`).test(line)) {
        fence = null;
      }
      if (capturing) out.push(line);
      continue;
    }

    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      if (capturing) out.push(line);
      continue;
    }

    const m = line.match(/^(#{2,4})\s+(.*)/);
    if (m) {
      const depth = m[1].length;
      if (capturing && depth <= sectionDepth) break;
      if (!capturing && m[2].toLowerCase().trim() === headingLower) {
        capturing = true;
        sectionDepth = depth;
        continue;
      }
    }
    if (capturing) out.push(line);
  }
  if (!capturing) return null;
  return out.join("\n").trim();
}

/**
 * Resolve a logical section from the first matching heading.
 * Prefers the first non-empty match; if every present heading is empty,
 * returns that empty string so callers can distinguish "missing" (null)
 * from "present but blank".
 */
function resolveSection(body, headings) {
  let firstPresent = null;
  for (const heading of headings) {
    const section = extractSection(body, heading);
    if (section === null) continue;
    if (firstPresent === null) firstPresent = section;
    if (!isEmpty(section)) return section;
  }
  return firstPresent;
}

/**
 * True when the body has multiple non-empty h2–h4 sections with enough detail.
 * Soft-pass only — unstructured length alone is not enough, and a single
 * arbitrary heading must not bypass the quality gate (Codex on #564).
 */
function hasSubstantialStructuredContent(body, minSectionLen = 40, minRichSections = 2) {
  if (typeof body !== "string") return false;
  const lines = body.split("\n");
  let capturing = false;
  let bucket = [];
  let richSections = 0;
  const flush = () => {
    if (clean(bucket.join("\n")).length >= minSectionLen) richSections += 1;
    bucket = [];
  };
  for (const line of lines) {
    const m = line.match(/^#{2,4}\s+(.*)/);
    if (m) {
      if (capturing) flush();
      capturing = true;
      continue;
    }
    if (capturing) bucket.push(line);
  }
  if (capturing) flush();
  return richSections >= minRichSections;
}

// ---------------------------------------------------------------------------
// Issue kind detection
// ---------------------------------------------------------------------------

const FEATURE_NEW_HEADINGS = [
  "What are you trying to accomplish?",
  "What prevents this today?",
  "What should OpenCodex do?",
];
const FEATURE_LEGACY_HEADINGS = ["Problem to solve", "Proposed solution"];
const FEATURE_GOAL_HEADINGS = [
  "What are you trying to accomplish?",
  "Goal / Problem",
  "Goal/Problem",
  "Problem to solve",
];
const FEATURE_BLOCKER_HEADINGS = [
  "What prevents this today?",
  "Current limitation",
  "Current workaround",
];
const FEATURE_BEHAVIOUR_HEADINGS = [
  "What should OpenCodex do?",
  "Expected behaviour",
  "Expected behavior",
  "Proposed solution",
];
const FEATURE_EXAMPLE_HEADINGS = [
  "Example usage or interface",
  "Example usage",
  "Example",
];
const FEATURE_ALIAS_DETECT_HEADINGS = [
  "Goal / Problem",
  "Goal/Problem",
  "Expected behaviour",
  "Expected behavior",
  "Current limitation",
  "Current workaround",
  "Example usage",
  // Intentionally omit bare "Example" — too common in freeform/bug reports.
];
const BUG_NEW_HEADINGS = ["Client or integration", "Summary", "Reproduction"];
const BUG_LEGACY_HEADINGS = ["Summary", "Reproduction"];
const PROVIDER_HEADINGS = [
  "Provider or upstream service",
  "Endpoint or capability",
  "Current behaviour",
  "Expected behaviour",
];
const DOCS_HEADINGS = [
  "Documentation problem type",
  "Documentation location",
  "What is wrong or missing?",
];

const KIND_TO_LABEL = {
  bug: "bug",
  feature: "enhancement",
  documentation: "documentation",
  "provider-compatibility": "provider-compatibility",
};

/**
 * Orthogonal product-area labels (additive beside kind/process labels).
 * Colors/descriptions are used when the workflow ensures labels exist.
 */
const AREA_LABELS = {
  provider: {
    color: "1D76DB",
    description: "Provider adapters, OpenAI-compat presets, upstream API quirks",
  },
  "account-pool": {
    color: "5319E7",
    description: "OAuth, credentials, Codex pool, quota, failover, plans",
  },
  catalog: {
    color: "006B75",
    description: "Model catalog, slugs, visibility, routed entries",
  },
  gui: {
    color: "D93F0B",
    description: "Dashboard, tray, settings UI",
  },
  cli: {
    color: "FBCA04",
    description: "CLI, config inject, packaging flags",
  },
  proxy: {
    color: "0E8A16",
    description: "HTTP proxy, routing, reverse-proxy / management auth",
  },
  platform: {
    color: "BFDADC",
    description: "OS/service/tray/ACL (Windows-heavy, not Windows-only)",
  },
  streaming: {
    color: "C5DEF5",
    description: "SSE, WebSocket, terminal stream frames",
  },
  tools: {
    color: "F9D0C4",
    description: "tool_calls, MCP, web-search / sidecar tools",
  },
  install: {
    color: "EDEDED",
    description: "Installation or packaging",
  },
  service: {
    color: "EDEDED",
    description: "Service lifecycle (WinSW/launchd/scheduler)",
  },
};

/** Canonical Area dropdown text → area label(s). Keys are lowercased. */
const AREA_FIELD_TO_LABELS = {
  cli: ["cli"],
  "proxy and routing": ["proxy"],
  dashboard: ["gui"],
  "provider adapter": ["provider"],
  "provider adapters": ["provider"],
  "authentication and account pool": ["account-pool"],
  "catalog / models": ["catalog"],
  streaming: ["streaming"],
  "tools / mcp / web search": ["tools"],
  "installation or packaging": ["install"],
  "service lifecycle": ["service"],
  "service lifecycle (config injection)": ["service"],
  "platform (windows / macos / linux)": ["platform"],
  // Do not map to kind label `documentation` — that collides with labelBasedKind
  // when a feature/bug form picks Area: Documentation. Docs form already seeds
  // the kind label; Area selection alone does not add an area tag.
  documentation: [],
  // No dedicated label; heuristics still run in detectAreaLabels.
  "multiple areas": [],
  other: [],
};

/** Body headings used for area heuristics (excludes Environment / OS metadata). */
const AREA_HEURISTIC_BODY_HEADINGS = [
  "Summary",
  "Reproduction",
  "What are you trying to accomplish?",
  "What prevents this today?",
  "What should OpenCodex do?",
  "Example usage or interface",
  "Current behaviour",
  "Expected behaviour",
  "Minimal redacted request or reproduction",
  "What is wrong or missing?",
  "Documentation problem type",
  "Documentation location",
];

/**
 * Heuristic rules. `scope: "title"` avoids false hits from template Environment /
 * OS fields in the body; `scope: "full"` is for distinctive technical tokens.
 */
const AREA_HEURISTICS = [
  {
    label: "account-pool",
    scope: "full",
    re: /\b(oauth|reauth|needsreauth|account pool|codex.?auth|auto[- ]?switch|account failover|refresh token|plan_type|chatgpt[- ]account|reset credit)\b/i,
  },
  {
    label: "account-pool",
    scope: "title",
    re: /\b(quota|failover|pool account|account switch)\b/i,
  },
  {
    label: "catalog",
    scope: "full",
    re: /\b(model catalog|opencodex-catalog|model list|model visibility|virtual model|routed (catalog|entries|slug)|model slug)\b/i,
  },
  {
    label: "catalog",
    scope: "title",
    re: /\bcatalog\b/i,
  },
  {
    label: "gui",
    scope: "title",
    re: /\b(dashboard|\bgui\b|tray|sidebar|settings (page|tab|ui))\b/i,
  },
  {
    label: "cli",
    scope: "title",
    re: /\b(ocx\b|config\.toml|config inject)\b/i,
  },
  {
    label: "proxy",
    scope: "full",
    re: /\b(reverse[- ]proxy|management api|admin[- ]token|\/api\/\*|bind(s)? the (old )?port)\b/i,
  },
  {
    label: "proxy",
    scope: "title",
    re: /\b(reverse[- ]proxy|management api|admin[- ]token)\b/i,
  },
  {
    label: "platform",
    scope: "full",
    re: /\b(winsw|launchd|schtasks|icacls|windows-latest|tray host|scheduler backend)\b/i,
  },
  {
    label: "platform",
    scope: "title",
    re: /\b(\[windows\]|\[macos\]|windows|macos|darwin|win32|wsl)\b/i,
  },
  {
    label: "streaming",
    scope: "full",
    re: /\b(sse|websocket|\bws\b|stream(ing)?\b.{0,40}\btruncat\w*|stream(ing)?\b.{0,40}\bterminal\b|terminal (sse )?frame|without a terminal)\b/i,
  },
  {
    label: "tools",
    scope: "full",
    re: /\b(tool_calls?|tool[- ]calls?|\bmcp\b|web[- ]search|tool[- ]recall)\b/i,
  },
  {
    label: "install",
    scope: "full",
    re: /\b(npm (global )?install|packaging|release asset|npx ocx)\b/i,
  },
  {
    label: "service",
    scope: "full",
    re: /\b(ocx service|winsw|scheduler backend|launchd service)\b/i,
  },
  {
    label: "provider",
    scope: "full",
    re: /\b(provider adapter|openai[- ]compatible|provider[- ]compat|adapter quirk|built[- ]in provider|provider preset)\b/i,
  },
  {
    label: "provider",
    scope: "title",
    re: /\b(\[provider\]|provider compat|openai[- ]compatible)\b/i,
  },
];

/**
 * Map a detected issue kind to its triage label. Returns null when unknown.
 */
function labelForKind(kind) {
  if (!kind || typeof kind !== "string") return null;
  return KIND_TO_LABEL[kind] || null;
}

/**
 * Map a template Area dropdown value to orthogonal area label names.
 * Returns [] for Other / Multiple areas / unknown / empty.
 *
 * @param {unknown} areaText
 * @returns {string[]}
 */
function mapAreaFieldToLabels(areaText) {
  if (typeof areaText !== "string") return [];
  const key = areaText.replace(/\s+/g, " ").trim().toLowerCase();
  if (!key) return [];
  return AREA_FIELD_TO_LABELS[key] ? [...AREA_FIELD_TO_LABELS[key]] : [];
}

/**
 * Build heuristic text from title-relevant semantic sections only — never from
 * Operating system / Version / Checks metadata that every template includes.
 *
 * @param {string} body
 * @returns {string}
 */
function bodyForAreaHeuristics(body) {
  if (typeof body !== "string" || !body.trim()) return "";
  const parts = [];
  for (const heading of AREA_HEURISTIC_BODY_HEADINGS) {
    const section = extractSection(body, heading);
    if (section) parts.push(section);
  }
  return parts.join("\n\n");
}

/**
 * Conservative title/body heuristics for orthogonal area labels.
 *
 * @param {string} title
 * @param {string} body semantic body text (already filtered)
 * @returns {string[]}
 */
function heuristicAreaLabels(title, body) {
  const titleText = title || "";
  const fullText = `${titleText}\n${body || ""}`;
  const seen = new Set();
  const out = [];
  for (const { label, re, scope } of AREA_HEURISTICS) {
    const text = scope === "title" ? titleText : fullText;
    if (!re.test(text) || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/**
 * Detect additive product-area labels from Area field, form defaults, and
 * title/body heuristics. Never invents per-provider labels.
 *
 * @param {{
 *   title?: string,
 *   body?: string,
 *   labels?: string[],
 *   heuristicBody?: string,
 * }} issue
 *   `body` is the source form (for Area / provider headings).
 *   `heuristicBody` may include English translation text for heuristics only.
 * @returns {string[]}
 */
function detectAreaLabels(issue) {
  const title = typeof issue?.title === "string" ? issue.title : "";
  const body = typeof issue?.body === "string" ? issue.body : "";
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  const heuristicSource = typeof issue?.heuristicBody === "string" ? issue.heuristicBody : body;

  const areaSection = extractSection(body, "Area");
  const fromArea = mapAreaFieldToLabels(areaSection);
  const fromHeur = heuristicAreaLabels(title, bodyForAreaHeuristics(heuristicSource));
  const fromForm = [];
  if (labels.includes("provider-compatibility")) fromForm.push("provider");
  // Provider-compat form uses this heading instead of Area.
  if (extractSection(body, "Provider or upstream service") !== null) {
    fromForm.push("provider");
  }

  const seen = new Set();
  const out = [];
  for (const label of [...fromArea, ...fromForm, ...fromHeur]) {
    if (!label || seen.has(label)) continue;
    if (!AREA_LABELS[label]) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

function countHeadings(body, headings) {
  let n = 0;
  for (const h of headings) {
    if (extractSection(body, h) !== null) n++;
  }
  return n;
}

/**
 * Detect the issue kind from body headings, title prefix, labels, and
 * optional stored bot kind.
 *
 * @param {{ title: string, body: string, labels: string[], storedKind?: string|null }} issue
 * @returns {"feature"|"bug"|"provider-compatibility"|"documentation"|null}
 */
function detectIssueKindFromContent(issue) {
  const { title = "", body = "", labels = [] } = issue;
  const titleLower = title.toLowerCase();

  // Provider compatibility: distinct headings.
  if (countHeadings(body, PROVIDER_HEADINGS) >= 3) return "provider-compatibility";

  // Documentation: distinct headings.
  if (countHeadings(body, DOCS_HEADINGS) >= 2) return "documentation";

  // New feature form: at least 2 of the 3 core headings.
  if (countHeadings(body, FEATURE_NEW_HEADINGS) >= 2) return "feature";

  // Translated / alternate feature headings (e.g. after issue-triage).
  // Require a feature-specific goal heading so common headings like
  // "Expected behaviour" cannot reclassify bug/freeform reports as features.
  // ([Feature]: prefix and enhancement labels are handled elsewhere.)
  if (
    countHeadings(body, FEATURE_ALIAS_DETECT_HEADINGS) >= 2 &&
    countHeadings(body, FEATURE_GOAL_HEADINGS) >= 1
  ) {
    return "feature";
  }

  // New bug form: Client or integration + Summary + Reproduction.
  if (
    extractSection(body, "Client or integration") !== null &&
    extractSection(body, "Summary") !== null &&
    extractSection(body, "Reproduction") !== null
  ) {
    return "bug";
  }

  // Legacy feature form: title prefix or old headings.
  if (titleLower.startsWith("[feature]:") || countHeadings(body, FEATURE_LEGACY_HEADINGS) >= 2) {
    return "feature";
  }

  // Legacy bug form: title prefix or old headings (Summary + Reproduction).
  if (titleLower.startsWith("[bug]:") || countHeadings(body, BUG_LEGACY_HEADINGS) >= 2) {
    // Only classify as bug when there is supporting evidence (label or prefix)
    // to avoid false positives on generic issues that happen to have those words.
    if (titleLower.startsWith("[bug]:") || labels.includes("bug")) return "bug";
  }

  return null;
}

/**
 * True when body evidence for `kind` is a full structured form, not merely a
 * title prefix or leftover label. Used to decide whether detected kind may
 * override a stored bot kind.
 */
function hasStrongKindEvidence(kind, issue) {
  const { body = "" } = issue;
  switch (kind) {
    case "provider-compatibility":
      return countHeadings(body, PROVIDER_HEADINGS) >= 3;
    case "documentation":
      return countHeadings(body, DOCS_HEADINGS) >= 2;
    case "feature":
      return (
        countHeadings(body, FEATURE_NEW_HEADINGS) >= 2 ||
        countHeadings(body, FEATURE_LEGACY_HEADINGS) >= 2 ||
        (countHeadings(body, FEATURE_ALIAS_DETECT_HEADINGS) >= 2 &&
          countHeadings(body, FEATURE_GOAL_HEADINGS) >= 1)
      );
    case "bug":
      return (
        extractSection(body, "Client or integration") !== null &&
        extractSection(body, "Summary") !== null &&
        extractSection(body, "Reproduction") !== null
      );
    default:
      return false;
  }
}

/**
 * Detect the issue kind from body headings, title prefix, labels, and
 * optional stored bot kind.
 *
 * Stored kind survives heading removal (bypass protection). A different
 * detected kind overrides it only when the body has strong form evidence.
 *
 * @param {{ title: string, body: string, labels: string[], storedKind?: string|null }} issue
 * @returns {"feature"|"bug"|"provider-compatibility"|"documentation"|null}
 */
function detectIssueKind(issue) {
  const { storedKind } = issue;
  const detected = detectIssueKindFromContent(issue);

  if (storedKind) {
    if (
      detected &&
      detected !== storedKind &&
      hasStrongKindEvidence(detected, issue)
    ) {
      return detected;
    }
    return storedKind;
  }

  return detected;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isEmpty(text) {
  const c = clean(text);
  if (c.length === 0) return true;
  // Stand-ins like "...", "…", "---" are not actionable report content.
  return /^[\p{P}\p{S}\s]+$/u.test(c);
}

function allSameCanonical(sections) {
  const cans = sections.map(canonicalise).filter(Boolean);
  if (cans.length < 2) return false;
  return cans.every((c) => c === cans[0]);
}

function allRepeatTitle(sections, title) {
  const titleCan = canonicalise(title);
  if (!titleCan) return false;
  const cans = sections.map(canonicalise).filter(Boolean);
  if (cans.length === 0) return false;
  return cans.every((c) => c === titleCan);
}

function isPlaceholder(text) {
  return isPlaceholderOnlyValue(text);
}

/**
 * True when Version is an "I don't know" stand-in rather than an install id.
 * Kept separate from PLACEHOLDER_ONLY_RE so legacy N/A / No response soft-pass
 * behaviour is unchanged.
 */
const UNUSABLE_VERSION_RE =
  /^[\s_*~`]*(?:unknown|unkown|uknown|don'?t\s+know|do\s+not\s+know|idk|dunno|not\s+sure|unsure|\?+|모름|잘\s*모름|모르겠(?:습니다|음)?|不明|わからない|分からない|不知道|不清楚|keine\s+ahnung|wei[sß]{1,2}\s+nicht)[\s_*~`]*[.!?]*$/i;

function isUnusableVersion(raw) {
  const value = normalizeRawSectionValue(raw);
  if (value === null) return false;
  return UNUSABLE_VERSION_RE.test(value);
}

const CJK_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

function countWords(text) {
  const c = clean(text);
  if (!c) return 0;

  // Count each CJK character as one unit, and non-CJK scripts as Unicode
  // word tokens. Mixing one CJK glyph into a Latin/Cyrillic word must not
  // inflate the count to letter-length.
  const cjkChars = c.match(CJK_RE) || [];
  const nonCjkText = c.replace(CJK_RE, " ");
  const nonCjkTokens = nonCjkText.match(/[\p{L}\p{N}']+/gu) || [];

  return cjkChars.length + nonCjkTokens.length;
}

function hasConcreteDetail(text) {
  const c = clean(text);
  if (!c) return false;
  return (
    /\d/.test(c) ||
    /[`{}\[\]<>/\\]/.test(c) ||
    /\b(ocx|config|api|cli|dashboard|provider|proxy|route|endpoint|workflow|command)\b/i.test(c)
  );
}

function isTooTerseFeatureSection(text) {
  if (isEmpty(text) || isPlaceholder(text)) return false;
  const words = countWords(text);
  if (words >= 8) return false;
  if (words >= 6 && hasConcreteDetail(text)) return false;
  return true;
}

/**
 * Bug Reproduction needs steps or concrete signals. A title-like phrase with
 * no commands, paths, digits, or product keywords is not actionable.
 */
function isTooTerseBugReproduction(text) {
  if (isEmpty(text) || isPlaceholder(text)) return false;
  if (hasConcreteDetail(text)) return false;
  return countWords(text) < 12;
}

/**
 * Check if raw section text is a placeholder-only variant without relying on
 * clean() first. Used to distinguish intentionally blank optional fields
 * (legacy "No response" / N/A) from actively cleared required fields.
 */
function isRawPlaceholder(raw) {
  if (raw === null) return false;
  return isPlaceholderOnlyValue(raw);
}

/**
 * Near-miss freeform headings that often appear in API-opened or copy-pasted
 * bug reports instead of the Bug report template (e.g. Description / Log entry).
 */
const FREEFORM_BUG_NEAR_MISS_HEADINGS = [
  "Description",
  "Steps to reproduce",
  "Steps to Reproduce",
  "How to reproduce",
  "Log",
  "Logs",
  "Log entry",
  "Error",
  "Error output",
  "Stack trace",
];

/**
 * True when an unclassified body looks like a bug report that skipped the
 * template (near-miss headings and/or repro/error signals).
 *
 * @param {{ title?: string, body?: string }} issue
 * @returns {boolean}
 */
function looksLikeUntemplatedBugReport(issue) {
  const body = typeof issue?.body === "string" ? issue.body : "";
  if (!body.trim()) return false;

  const nearMissCount = countHeadings(body, FREEFORM_BUG_NEAR_MISS_HEADINGS);
  const hasReproduction =
    extractSection(body, "Reproduction") !== null ||
    extractSection(body, "Steps to reproduce") !== null ||
    extractSection(body, "Steps to Reproduce") !== null ||
    extractSection(body, "How to reproduce") !== null;
  const hasDescription = extractSection(body, "Description") !== null;
  const hasLogOrError =
    extractSection(body, "Log") !== null ||
    extractSection(body, "Logs") !== null ||
    extractSection(body, "Log entry") !== null ||
    extractSection(body, "Logs or error output") !== null ||
    extractSection(body, "Error") !== null ||
    extractSection(body, "Error output") !== null ||
    extractSection(body, "Stack trace") !== null;

  if (hasDescription && (hasReproduction || hasLogOrError)) return true;
  if (hasReproduction && hasLogOrError) return true;
  if (nearMissCount >= 2) return true;

  // Body-level signals for heading-free freeform dumps.
  const signalRe =
    /\b(repro(?:duce|duction| steps)?|stack\s*traces?|traceback|segfault|panic|exception|error\s*output|ECONNREFUSED|SIGSEGV)\b/i;
  if (signalRe.test(body) && (hasDescription || hasReproduction || hasLogOrError || nearMissCount >= 1)) {
    return true;
  }
  return false;
}

/**
 * Reasons/guidance when no structured issue kind was detected.
 *
 * @param {{ title?: string, body?: string }} issue
 * @returns {{ reasons: string[], guidance: string[] }}
 */
function untemplatedIssueFailure(issue) {
  if (looksLikeUntemplatedBugReport(issue)) {
    return {
      reasons: [
        "This looks like a bug report but it does not use the Bug report template headings (for example Description/Log entry instead of Summary).",
      ],
      guidance: [
        "Use the Bug report template, or edit this issue to include: Client or integration, Summary, Reproduction, Version, and Operating system.",
        "Retitling with `[Bug]:` and applying the `bug` label alone is not enough without those section headings filled in.",
      ],
    };
  }
  return {
    reasons: [
      "This issue does not use a recognized issue template.",
    ],
    guidance: [
      "Open a new issue with the Bug report, Feature request, Documentation, or Provider compatibility template.",
      "Or edit this issue so the body uses the template section headings for the kind of report you are filing.",
    ],
  };
}

/**
 * Validate an issue body for its detected kind.
 *
 * Unclassified (freeform / non-template) issues are invalid so API-opened
 * reports cannot skip the quality gate. Trusted-author exemption is enforced
 * by the workflow, not here.
 *
 * @param {{ title: string, body: string, labels: string[], storedKind?: string|null }} issue
 * @returns {{ kind: string|null, valid: boolean, softPass: boolean, reasons: string[], guidance: string[] }}
 */
function validateIssue(issue) {
  const { title = "", body = "" } = issue;
  const kind = detectIssueKind(issue);
  const reasons = [];
  const guidance = [];
  let softPass = false;

  if (!kind) {
    const failure = untemplatedIssueFailure(issue);
    return {
      kind: null,
      valid: false,
      softPass: false,
      reasons: failure.reasons,
      guidance: failure.guidance,
    };
  }

  if (kind === "feature") {
    const goal = resolveSection(body, FEATURE_GOAL_HEADINGS);
    const blocker = resolveSection(body, FEATURE_BLOCKER_HEADINGS);
    const behaviour = resolveSection(body, FEATURE_BEHAVIOUR_HEADINGS);
    const example = resolveSection(body, FEATURE_EXAMPLE_HEADINGS);

    const coreSections = [goal, blocker, behaviour, example];
    const emptyCore = [];
    if (isEmpty(goal)) emptyCore.push("goal / problem");
    // blocker and example are only required when those headings exist.
    // On the legacy / translated forms these sections may be absent (null).
    if (blocker !== null && isEmpty(blocker)) emptyCore.push("current limitation");
    if (isEmpty(behaviour)) emptyCore.push("expected behaviour");
    if (example !== null && isPlaceholder(example)) {
      reasons.push("Example usage or interface contains placeholder text instead of a concrete example.");
      guidance.push("Add a real CLI command, config snippet, API exchange, or before/after workflow example.");
    } else if (example !== null && isEmpty(example)) {
      emptyCore.push("example usage");
    }

    const mappedHeadingPresent =
      goal !== null || blocker !== null || behaviour !== null || example !== null;

    if (emptyCore.length > 0) {
      // Soft-pass rich non-template bodies once kind is already feature (title
      // prefix, enhancement label, or stored kind). Do not require the title to
      // keep a `[Feature]:` prefix — maintainer retitles must not re-arm closure.
      const canSoftPass =
        !mappedHeadingPresent &&
        hasSubstantialStructuredContent(body);
      if (canSoftPass) {
        softPass = true;
      } else {
        reasons.push(`Required sections are missing or empty: ${emptyCore.join(", ")}.`);
        guidance.push("Fill in each required section with specific detail about your workflow.");
      }
    }

    if (!softPass) {
      const nonEmpty = coreSections.filter((s) => !isEmpty(s));
      if (nonEmpty.length >= 2 && allSameCanonical(nonEmpty)) {
        reasons.push("All core sections contain the same content.");
        guidance.push("Each section should describe a different aspect: goal, limitation, expected behaviour, and a concrete example.");
      }

      if (nonEmpty.length >= 2 && allRepeatTitle(nonEmpty, title)) {
        reasons.push("All core sections merely repeat the issue title.");
        guidance.push("Expand each section with details beyond the title.");
      }

      if (nonEmpty.length > 0 && nonEmpty.every(isPlaceholder)) {
        reasons.push("Required sections contain only placeholder text.");
        guidance.push("Replace placeholder text with your actual proposal.");
      }
    }

    const terseSections = [];
    if (goal !== null && isTooTerseFeatureSection(goal)) terseSections.push("goal / problem");
    if (blocker !== null && isTooTerseFeatureSection(blocker)) terseSections.push("current limitation");
    if (behaviour !== null && isTooTerseFeatureSection(behaviour)) terseSections.push("expected behaviour");
    if (terseSections.length > 0) {
      reasons.push(`Required sections are too vague to act on: ${terseSections.join(", ")}.`);
      guidance.push("Describe the workflow, limitation, and expected behaviour with enough detail for someone to implement or evaluate the request.");
    }
  }

  if (kind === "bug") {
    const summary = extractSection(body, "Summary");
    const repro = extractSection(body, "Reproduction");
    const version = extractSection(body, "Version");
    const os = extractSection(body, "Operating system") ?? extractSection(body, "OS");
    // New Bug report template always includes Client or integration.
    const isNewBugForm = extractSection(body, "Client or integration") !== null;

    if (isEmpty(summary) && isEmpty(repro)) {
      // Soft-pass substantial non-English / freeform structured reports once
      // kind is already bug (label, stored kind, or prior `[Bug]:` detection).
      // Requiring the title to keep a `[Bug]:` prefix caused #545: a maintainer
      // retitle of an already detailed report was treated as empty Summary/
      // Reproduction and auto-closed.
      const canSoftPass =
        summary === null &&
        repro === null &&
        hasSubstantialStructuredContent(body);
      if (canSoftPass) {
        softPass = true;
      } else {
        reasons.push("Both Summary and Reproduction are empty.");
        guidance.push("Describe what happened and how to reproduce it.");
      }
    } else {
      // Each mapped field is required on its own — a filled Summary with an
      // empty / ellipsis Reproduction (e.g. #598) must not pass.
      if (isEmpty(summary)) {
        reasons.push("Summary is empty.");
        guidance.push("Describe what happened (the symptom or error).");
      }
      if (isEmpty(repro)) {
        reasons.push("Reproduction is empty.");
        guidance.push("List the exact steps to reproduce the problem.");
      } else if (!softPass && isTooTerseBugReproduction(repro)) {
        reasons.push("Reproduction is too vague to act on.");
        guidance.push("List exact steps, commands, and the observed failure — not only a short phrase.");
      }
    }

    // Version "Unknown" / "모름" / "idk" is never actionable, on any form.
    if (!softPass && version !== null && isUnusableVersion(version)) {
      reasons.push("Version is missing or unknown.");
      guidance.push("Report the installed `@bitkyc08/opencodex` version (for example `2.7.42`) or a commit SHA from `ocx --version`.");
    } else if (
      !softPass &&
      isNewBugForm &&
      (version === null || isEmpty(version) || isRawPlaceholder(version))
    ) {
      // New form requires Version (including when the heading was removed).
      // Legacy N/A / No response soft-pass stays only for bodies without
      // Client or integration.
      reasons.push("Version is missing.");
      guidance.push("Add your OpenCodex version so we can reproduce the environment.");
    }

    if (!softPass && isNewBugForm && os !== null && isUnusableVersion(os)) {
      reasons.push("Operating system is missing or unknown.");
      guidance.push("Add your OS name and version (for example Windows 11 24H2).");
    } else if (
      !softPass &&
      isNewBugForm &&
      (os === null || isEmpty(os) || isRawPlaceholder(os))
    ) {
      reasons.push("Operating system is missing.");
      guidance.push("Add your OS name and version (for example Windows 11 24H2).");
    }

    // Required environment fields removed after submission on bodies that are
    // not the new form (no Client or integration). Legacy reports never had
    // Version or OS fields, so null means absent, not removed. Skip when the
    // raw value is a "No response" placeholder — the old form had both fields
    // as optional. Only close when the field was actively cleared.
    if (
      !softPass &&
      !isNewBugForm &&
      version !== null &&
      os !== null &&
      isEmpty(version) &&
      isEmpty(os) &&
      !isRawPlaceholder(version) &&
      !isRawPlaceholder(os)
    ) {
      reasons.push("Version and Operating system are both missing.");
      guidance.push("Add your OpenCodex version and OS so we can reproduce the environment.");
    }

    if (!softPass) {
      const nonEmpty = [summary, repro].filter((s) => !isEmpty(s));
      if (nonEmpty.length >= 2 && allSameCanonical(nonEmpty)) {
        reasons.push("Summary and Reproduction contain the same content.");
        guidance.push("Summary should describe the symptom; Reproduction should list the exact steps.");
      }

      if (nonEmpty.length >= 1 && allRepeatTitle(nonEmpty, title)) {
        reasons.push("Summary and Reproduction merely repeat the title.");
        guidance.push("Add detail beyond the title: what you observed, what you expected, and the exact steps.");
      }

      if (nonEmpty.length > 0 && nonEmpty.every(isPlaceholder)) {
        reasons.push("Required sections contain only placeholder text.");
        guidance.push("Replace placeholder text with your actual report.");
      }
    }
  }

  if (kind === "provider-compatibility") {
    const current = extractSection(body, "Current behaviour");
    const expected = extractSection(body, "Expected behaviour");
    const repro = extractSection(body, "Minimal redacted request or reproduction");
    const response = extractSection(body, "Actual response or error");
    const docs = extractSection(body, "Upstream documentation");

    const emptyCore = [];
    if (isEmpty(current)) emptyCore.push("current behaviour");
    if (isEmpty(expected)) emptyCore.push("expected behaviour");
    // Metadata fields: provider, version, endpoint are required on the form.
    const provider = extractSection(body, "Provider or upstream service");
    const version = extractSection(body, "OpenCodex version");
    const endpoint = extractSection(body, "Endpoint or capability");
    if (provider !== null && isEmpty(provider)) emptyCore.push("provider or upstream service");
    if (version !== null && isRawPlaceholder(version) === false && isEmpty(version)) emptyCore.push("OpenCodex version");
    if (endpoint !== null && isEmpty(endpoint)) emptyCore.push("endpoint or capability");
    if (emptyCore.length > 0) {
      // Same soft-pass as bug/feature: label- or maintainer-scoped provider
      // reports often use non-English structured headings after a retitle.
      const mappedHeadingPresent =
        current !== null || expected !== null || repro !== null || response !== null || docs !== null ||
        provider !== null || version !== null || endpoint !== null;
      const canSoftPass =
        !mappedHeadingPresent &&
        hasSubstantialStructuredContent(body);
      if (canSoftPass) {
        softPass = true;
      } else {
        reasons.push(`Required sections are missing or empty: ${emptyCore.join(", ")}.`);
        guidance.push("Describe both the current and expected behaviour.");
      }
    }

    if (!softPass && !isEmpty(current) && !isEmpty(expected) && canonicalise(current) === canonicalise(expected)) {
      reasons.push("Current and expected behaviour are effectively identical.");
      guidance.push("Explain the difference between what happens now and what should happen.");
    }

    const allSections = [current, expected, repro, response].filter((s) => !isEmpty(s));
    if (!softPass && allSections.length >= 2 && allRepeatTitle(allSections, title)) {
      reasons.push("All sections merely repeat the issue title.");
      guidance.push("Add specific detail in each section.");
    }

    if (!softPass && isEmpty(repro) && isEmpty(response)) {
      reasons.push("Both the request/reproduction and the actual response/error are absent.");
      guidance.push("Include at least a minimal redacted request or the actual error output.");
    }

    if (!softPass && isEmpty(docs)) {
      reasons.push("Upstream documentation is empty without stating that no public specification exists.");
      guidance.push("Add a URL to the provider specification, or state that no public spec exists.");
    }
  }

  if (kind === "documentation") {
    const location = extractSection(body, "Documentation location");
    const problem = extractSection(body, "What is wrong or missing?");
    const expected = extractSection(body, "What should the documentation explain instead?");

    if (isEmpty(location) && isEmpty(problem)) {
      reasons.push("Documentation location and problem description are both missing.");
      guidance.push("Point to the exact documentation page and describe what is wrong.");
    }

    const nonEmpty = [location, problem, expected].filter((s) => !isEmpty(s));
    if (nonEmpty.length >= 1 && allRepeatTitle(nonEmpty, title)) {
      reasons.push("The body merely repeats the title.");
      guidance.push("Add detail: the exact URL or path, what is wrong, and what it should say.");
    }

    if (nonEmpty.length > 0 && nonEmpty.every(isPlaceholder)) {
      reasons.push("Required sections contain only placeholder text.");
      guidance.push("Replace placeholder text with the actual documentation problem.");
    }
  }

  return {
    kind,
    valid: reasons.length === 0 && !softPass,
    softPass,
    reasons,
    guidance,
  };
}

// ---------------------------------------------------------------------------
// Closure ownership
// ---------------------------------------------------------------------------

/**
 * Decide whether the bot may auto-close an invalid issue.
 *
 * After a maintainer reopens and deactivates enforcement, later `edited`
 * events must not close the issue again.
 *
 * @param {{ active?: boolean, maintainerOverride?: boolean }|null|undefined} botState
 * @returns {boolean}
 */
function shouldEnforceClosure(botState) {
  if (botState && botState.maintainerOverride === true) return false;
  return true;
}

/**
 * Decide whether the bot may reopen a closed issue.
 *
 * @param {{ active: boolean, closedAt: string|null, stateReason: string }} botState
 * @param {{ state: string, closed_at: string|null, state_reason: string|null, closed_by?: string|null }} issue
 * @param {boolean} maintainerOverride  True when a maintainer changed the issue state after the bot.
 * @returns {boolean}
 */
function shouldReopen(botState, issue, maintainerOverride) {
  if (!botState || !botState.active) return false;
  if (issue.state !== "closed") return false;
  if (maintainerOverride) return false;
  if (issue.closed_at !== botState.closedAt) return false;
  if (issue.state_reason !== botState.stateReason) return false;
  // Only reopen if the bot itself was the last actor to close the issue.
  // A human closing it (even with the same timestamp) means intentional closure.
  if (issue.closed_by && issue.closed_by !== "github-actions[bot]") return false;
  return true;
}

/**
 * workflow_dispatch accepts a bare issue number, but GitHub reuses the same
 * number namespace for issues and pull requests. Reject PR targets before any
 * validation or mutation runs.
 *
 * @param {{ pull_request?: unknown }} issue
 * @param {number|string} issueNumber
 * @param {string} eventName
 * @returns {string|null}
 */
function rejectsWorkflowDispatchPullRequest(issue, issueNumber, eventName) {
  if (eventName !== "workflow_dispatch") return null;
  if (!issue?.pull_request) return null;
  return `#${issueNumber} is a pull request. This workflow only accepts issue numbers.`;
}

/**
 * workflow_dispatch can be started from a selected branch. Reject runs whose
 * selected ref is not the repository default branch so untrusted branch code
 * cannot drive issue mutations with issues:write.
 *
 * @param {string} eventName
 * @param {string|null|undefined} ref
 * @param {string|null|undefined} defaultBranch
 * @returns {string|null}
 */
function rejectsWorkflowDispatchNonDefaultBranch(eventName, ref, defaultBranch) {
  if (eventName !== "workflow_dispatch") return null;
  if (!defaultBranch || typeof defaultBranch !== "string") {
    return "workflow_dispatch requires repository.default_branch to be available.";
  }
  const expected = `refs/heads/${defaultBranch}`;
  if (ref !== expected) {
    return (
      `workflow_dispatch must run from the default branch (${defaultBranch}); ` +
      `selected ref was ${ref || "(empty)"}.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  clean,
  normalise,
  canonicalise,
  extractSection,
  resolveSection,
  detectIssueKind,
  validateIssue,
  looksLikeUntemplatedBugReport,
  shouldReopen,
  shouldEnforceClosure,
  isPlaceholderOnlyValue,
  isPlaceholder,
  isRawPlaceholder,
  isUnusableVersion,
  countWords,
  hasConcreteDetail,
  labelForKind,
  KIND_TO_LABEL,
  AREA_LABELS,
  AREA_FIELD_TO_LABELS,
  mapAreaFieldToLabels,
  bodyForAreaHeuristics,
  heuristicAreaLabels,
  detectAreaLabels,
  hasSubstantialStructuredContent,
  rejectsWorkflowDispatchPullRequest,
  rejectsWorkflowDispatchNonDefaultBranch,
};
