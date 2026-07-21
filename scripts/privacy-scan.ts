import { existsSync, readFileSync } from "node:fs";

type Finding = {
  file: string;
  line: number;
  kind: string;
  value: string;
};

const TEXT_FILE_RE = /\.(?:cjs|css|html|js|json|jsonc|md|mjs|ps1|sh|toml|ts|tsx|txt|yml|yaml)$/;
const EXCLUDED_PREFIXES = [
  "devlog/",
  "gui/dist/",
  "node_modules/",
  "tests/.tmp-",
];
const EXCLUDED_SUFFIXES = [
  "bun.lock",
  "package-lock.json",
];

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

function isAllowedEmail(file: string, email: string): boolean {
  if (file === "scripts/privacy-scan.ts" && email === "a@b.com") return true;
  const domain = email.split("@").at(1)?.toLowerCase() ?? "";
  if (domain === "example.test" || domain === "example.com" || domain === "test.com" || domain.endsWith(".test")) {
    return true;
  }
  // URL-userinfo fixtures (https://user:pw@host/...) read as "pw@host" — not emails.
  if (file.startsWith("tests/") && email === ["pw", "chatgpt.com"].join("@")) return true;
  return file.startsWith("tests/") && email === "a@b.com";
}

function isAllowedHomePath(file: string, username: string): boolean {
  if (file.startsWith("tests/") && (username === "example" || username === "test" || username === "x")) {
    return true;
  }
  if (file.startsWith("docs/") && (username === "me" || username === "user")) return true;
  if (file.startsWith("docs-site/") && username === "example") return true;
  return false;
}

function isAllowedTokenLooking(file: string, token: string): boolean {
  if (!file.startsWith("tests/")) return false;
  // Test fixture sentinels: sk-rawsentinel..., sk-test-...
  return /^sk-(?:rawsentinel|test-)\d+[a-z]*$/.test(token);
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
    match => isAllowedEmail(file, match[0]),
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
