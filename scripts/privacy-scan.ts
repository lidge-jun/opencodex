import { existsSync, readFileSync } from "node:fs";

type Finding = {
  file: string;
  line: number;
  kind: string;
  value: string;
};

const TEXT_FILE_RE = /\.(?:cjs|css|html|js|json|jsonc|md|mjs|ps1|sh|toml|ts|tsx|txt|yml|yaml)$/;
const EXCLUDED_PREFIXES = [
  "gui/dist/",
  "node_modules/",
  "tests/.tmp-",
];
const EXCLUDED_SUFFIXES = [
  "bun.lock",
  "package-lock.json",
];

/**
 * The maintainer's local account name. It appears throughout `devlog/` evidence blocks
 * because those quote real command invocations, and it is already public through
 * repository ownership and commit authorship. Scoped to `devlog/` only — a home path
 * under any other username, anywhere, still fails the scan.
 */
const MAINTAINER_HOME_USERNAME = "jun";

/**
 * Placeholder addresses used in sample CLI output and UI specs inside `devlog/`.
 * Deliberately a short explicit list: each entry is a value a human chose as obviously
 * fake, and adding one is a reviewed change.
 */
const DEVLOG_PLACEHOLDER_EMAILS = new Set([
  ["1", "gmail.com"].join("@"),
  ["a", "b.com"].join("@"),
  ["work", "corp.com"].join("@"),
]);

/**
 * Exact fake probes preserved as historic scan evidence in the devlog publication
 * record. Keep this limited to that file and those values: the record proves all
 * three detectors worked on a staged file before the probe was removed. Construct
 * the strings from fragments so this scanner does not report its own allowances.
 */
const DEVLOG_PUBLICATION_PROOF_FILE = "devlog/_fin/260730_devlog_publication_feasibility/030_wp3_wp4_execution_record.md";
const DEVLOG_PUBLICATION_PROOF_TOKEN = ["sk-", "liveKeyShaped9", "x8w7v6u5", "t4s3r2q1p0"].join("");
const DEVLOG_PUBLICATION_PROOF_HOME_USERNAME = ["someone", "else"].join("");
const DEVLOG_PUBLICATION_PROOF_EMAIL = ["stranger", "third-party.example.org"].join("@");

function gitLsFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`git ls-files failed: ${stderr.trim() || result.exitCode}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split(/\r?\n/)
    .filter(Boolean);
}

function shouldScan(file: string): boolean {
  if (!TEXT_FILE_RE.test(file)) return false;
  if (EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))) return false;
  if (EXCLUDED_SUFFIXES.some(suffix => file.endsWith(suffix))) return false;
  return true;
}

function lineNumber(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** The full source line containing `index`, used for context-sensitive allowances. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

function isAllowedEmail(file: string, email: string): boolean {
  if (file === "scripts/privacy-scan.ts" && email === "a@b.com") return true;
  if (file === DEVLOG_PUBLICATION_PROOF_FILE && email === DEVLOG_PUBLICATION_PROOF_EMAIL) return true;
  const domain = email.split("@").at(1)?.toLowerCase() ?? "";
  if (domain === "example.test" || domain === "example.com" || domain === "test.com" || domain.endsWith(".test")) {
    return true;
  }
  // devlog records public commit authorship: PR absorption notes, cherry-pick
  // provenance, and `Co-authored-by:` trailers. Those addresses are already public in
  // this repository's git history, so redacting them here protects nothing while
  // destroying the attribution the notes exist to preserve. GitHub's own noreply form
  // is a public handle by construction.
  if (file.startsWith("devlog/")) {
    if (domain === "users.noreply.github.com") return true;
    if (DEVLOG_PLACEHOLDER_EMAILS.has(email.toLowerCase())) return true;
  }
  // URL-userinfo fixtures (https://user:pw@host/...) read as "pw@host" — not emails.
  if (file.startsWith("tests/") && email === ["pw", "chatgpt.com"].join("@")) return true;
  return file.startsWith("tests/") && email === "a@b.com";
}

/**
 * Whether this occurrence is git-attribution provenance rather than contact data.
 *
 * `devlog/` notes quote commit and PR metadata verbatim so absorption and cherry-pick
 * decisions stay auditable: `Co-authored-by:` trailers, `author Name <addr>` citations,
 * and `Name <addr>` forms. Every such address is ALREADY public as commit authorship in
 * this repository, so redacting the note protects nothing and destroys the attribution.
 *
 * Matching the surrounding SHAPE rather than a list of addresses is deliberate: a new
 * contributor needs no scanner change, while a bare address pasted as contact detail
 * still fails.
 */
function isGitAttributionContext(line: string): boolean {
  return /co-authored-by:\s*.*<[^>]+>/i.test(line)
    || /\bauthor(?:ed by)?\b[^<]*<[^>]+>/i.test(line)
    || /signed-off-by:\s*.*<[^>]+>/i.test(line)
    // `handle <addr>` — the shape git itself prints for an identity. Requires a name
    // token before the angle brackets, so a bare address is not covered.
    || /[A-Za-z0-9._-]+\s*<[^@\s>]+@[^\s>]+>/.test(line)
    // A markdown table row citing commit provenance: a SHA cell plus the address.
    // Requires the 7+ hex SHA, so an arbitrary table of contacts is not covered.
    || (/^\s*\|/.test(line) && /\b[0-9a-f]{7,40}\b/.test(line));
}
function isAllowedHomePath(file: string, username: string): boolean {
  if (file === DEVLOG_PUBLICATION_PROOF_FILE && username === DEVLOG_PUBLICATION_PROOF_HOME_USERNAME) return true;
  if (file.startsWith("tests/") && (username === "example" || username === "test" || username === "x")) {
    return true;
  }
  if (file.startsWith("docs/") && (username === "me" || username === "user")) return true;
  if (file.startsWith("docs-site/") && username === "example") return true;
  // devlog evidence blocks quote real command invocations, and a reproducible path is
  // the point. The maintainer's own account name is already public through repository
  // ownership and commit authorship. Any OTHER username still fails: a contributor's or
  // reporter's home path is somebody else's data.
  if (file.startsWith("devlog/") && (username === MAINTAINER_HOME_USERNAME || username === "u" || username === "user" || username === "me" || username === "test")) {
    return true;
  }
  return false;
}

function isAllowedTokenLooking(file: string, token: string): boolean {
  if (file === DEVLOG_PUBLICATION_PROOF_FILE && token === DEVLOG_PUBLICATION_PROOF_TOKEN) return true;
  if (file.startsWith("tests/")) {
    // Test fixture sentinels: sk-rawsentinel..., sk-test-...
    return /^sk-(?:rawsentinel|test-)\d+[a-z]*$/.test(token);
  }
  if (file.startsWith("devlog/")) {
    // devlog quotes the same fixture sentinels its tests use, plus self-describing
    // placeholders written for redaction and warning examples. The allowance is
    // deliberately shape-based: a token must SAY it is fake. A real `sk-` key is high
    // entropy and would not match any of these words, so it still fails.
    return /^sk-(?:ant-)?(?:rawsentinel|test|warning|from|oat01-test)[A-Za-z0-9_-]*$/.test(token)
      || /^sk-[a-z-]*(?:sentinel|placeholder|redact|example|dummy|fake)[A-Za-z0-9_-]*$/.test(token);
  }
  return false;
}

function isAllowedBearerToken(file: string, token: string): boolean {
  if (!file.startsWith("tests/")) return false;
  return /^(?:access|stack|usage-debug)-token(?:-value)?-[A-Za-z0-9-]+$/.test(token);
}

function addFindingsForPattern(
  findings: Finding[],
  file: string,
  text: string,
  kind: string,
  pattern: RegExp,
  allow: (match: RegExpExecArray) => boolean,
): void {
  for (const match of text.matchAll(pattern)) {
    if (allow(match)) continue;
    findings.push({
      file,
      line: lineNumber(text, match.index ?? 0),
      kind,
      value: match[0],
    });
  }
}

function scanFile(file: string): Finding[] {
  const text = readFileSync(file, "utf-8");
  const findings: Finding[] = [];
  addFindingsForPattern(
    findings,
    file,
    text,
    "home-path",
    /\/Users\/([A-Za-z0-9_-]+)\//g,
    match => isAllowedHomePath(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "email",
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    match =>
      isAllowedEmail(file, match[0])
      || (file.startsWith("devlog/") && isGitAttributionContext(lineAt(text, match.index ?? 0))),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "bearer-token",
    /Bearer\s+([A-Za-z0-9._-]{24,})/g,
    match => isAllowedBearerToken(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "token-looking",
    /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
    match => isAllowedTokenLooking(file, match[0]),
  );
  return findings;
}

const findings = gitLsFiles()
  .filter(existsSync)
  .filter(shouldScan)
  .flatMap(scanFile);

if (findings.length > 0) {
  console.error("Privacy scan failed:");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.kind}: ${finding.value}`);
  }
  process.exit(1);
}

console.log("Privacy scan passed");
