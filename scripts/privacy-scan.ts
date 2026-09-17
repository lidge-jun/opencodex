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

/**
 * The sponsorship contact address published on purpose. It is the one email the project
 * WANTS in the tree, and only in the two files that carry the sponsor rule set. Anywhere
 * else — a devlog note, a test fixture, a comment — the same address still fails, because
 * there it would be a leak of contact data rather than a published channel.
 */
const SPONSORSHIP_CONTACT_EMAIL = ["jun", "lidgeai.com"].join("@");
const SPONSORSHIP_CONTACT_FILES = new Set(["SPONSORS.md", "README.md"]);

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
  if (SPONSORSHIP_CONTACT_FILES.has(file) && email.toLowerCase() === SPONSORSHIP_CONTACT_EMAIL) return true;
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

/**
 * One token of an SSH directive value that is documentation, not infrastructure.
 *
 * Deliberately narrow: SSH's own `%h`/`%p`/`%r` substitutions, an obviously templated
 * value, RFC 2606 / RFC 6761 reserved names, and generic account words. Anything else
 * naming a host or an account is treated as real, because the cost of a false positive
 * here is one allowlist line and the cost of a false negative is a published endpoint.
 *
 * Every rule is anchored to the whole token. An unanchored reserved-name test reads
 * `example.com.internal-buildfarm.net` as documentation, when it is a real host that
 * merely begins with one.
 */
function isPlaceholderToken(token: string): boolean {
  // `%h`, and the composed forms SSH's own documentation uses: `%h:%p`, `%r@%h`.
  // A token made only of substitutions names nothing.
  if (/^(?:[@:/._-]*%[hpr])+[@:/._-]*$/.test(token)) return true;
  // `<host>`, `${HOST}`, `{{ runner }}` — templated rather than literal. Both ends
  // are anchored so a real host carrying a stray bracket is not laundered into one.
  if (/^<[^<>]*>$/.test(token)) return true;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(token)) return true;
  if (/^\{+[^{}]*\}*$/.test(token)) return true;
  if (/^[}>]+$/.test(token)) return true;
  // Judge a `login@host:port` token on its host part: userinfo and a port name no
  // infrastructure on their own. (Written without a dotted domain after the "@" so this
  // comment is not itself an email finding — which is exactly what it was, once.)
  const host = (token.split("@").at(-1) ?? "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (/^(?:localhost|example|invalid|test|example\.(?:com|net|org))$/i.test(host)) return true;
  if (/\.(?:localhost|example|invalid|test|example\.(?:com|net|org))$/i.test(host)) return true;
  // Generic account placeholders, matching the home-path allowlist's spirit.
  return /^(?:user|username|me|you|someone|root|ubuntu|runner)$/i.test(token);
}

/**
 * Whether an SSH directive value is documentation in its entirety.
 *
 * EVERY whitespace-separated token must be a placeholder. The question this replaces
 * was whether the value *contained* something allowlisted, which is the wrong question
 * for `ProxyCommand`: its value is a command line rather than a host, so one reserved
 * name anywhere in it cleared the entire line. Two concrete bypasses followed from
 * that, and both are pinned as tests:
 *
 *   - `ProxyCommand nc -X connect -x proxy.example.com:8080 <real-host> 22` passed the
 *     unanchored reserved-name rule on its proxy hop while naming the real endpoint
 *     three tokens later.
 *   - any value beginning with `$` passed the templated-prefix rule outright, so
 *     `ProxyCommand $CF access ssh --hostname <real-host>` was allowed whole.
 *
 * A `ProxyCommand` is a leak by default; only a wholly templated value is
 * documentation. `HostName` takes a single token, so this is the same question asked
 * of one token, and its behavior is unchanged except for the anchoring above.
 */
function isAllowedSshEndpoint(value: string): boolean {
  // A trailing `# comment` is ssh_config syntax, not part of the value.
  const v = value.replace(/(?:^|[ \t])#.*$/, "").trim();
  if (!v) return true;
  return v.split(/[ \t]+/).every(isPlaceholderToken);
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

/**
 * Scan already-read text.
 *
 * Split out of `scanFile` so a test can exercise the REAL detectors rather than
 * re-declaring the patterns — a copied regex stays green after the production
 * detector is deleted, which is the failure this seam exists to prevent.
 *
 * Safe to import: the repo scan runs only under `import.meta.main`, for the
 * reason documented on `runScan`.
 */
export function scanText(file: string, text: string): Finding[] {
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
  /*
   * SSH config directives naming a real endpoint.
   *
   * `privacy-scan` knew about tokens, emails and home paths, but nothing about
   * infrastructure — so a devlog could publish a working `Host` block and this
   * scan passed. That is how a runner's hostname, login and Cloudflare
   * `ProxyCommand` shipped in `260731_pr_merge_round/022`; #4623 removes them by
   * hand. The values are deliberately not repeated here — this file is the fix,
   * and restating them would outlive the cleanup.
   *
   * Anchored to the SSH config grammar — directive at the start of a line, with
   * optional indent — because `User` is an ordinary English word and matching it
   * in prose would make this unusable. `HostName`/`ProxyCommand` are distinctive
   * enough on their own but are anchored the same way for consistency.
   */
  addFindingsForPattern(
    findings,
    file,
    text,
    "ssh-endpoint",
    // `HostName` only, and the value must be the whole rest of the line.
    //
    // `User` is deliberately NOT matched. It is an ordinary English word, and
    // anchoring it to the SSH grammar still fires on wrapped prose — "…the\nuser
    // configuration." and "…the\nuser notice." both matched a line-anchored
    // single-token form during development. The username alone is also the least
    // sensitive part of a Host block, and `MAINTAINER_HOME_USERNAME` already
    // covers the maintainer's account in path form.
    //
    // A trailing `# comment` is allowed after the value, because ssh_config permits
    // one and without it the end-of-line anchor simply failed to match the directive.
    // The `Keyword=value` form is deliberately NOT accepted here: `hostname = "127.0.0.1",`
    // is ordinary TypeScript, and three such lines are in `src/server/ports.ts` and
    // `src/server/port-reclaim.ts` today. `ProxyCommand` below does accept it, because
    // that word is not an identifier anyone writes in code.
    /^[ \t]*HostName[ \t]+(\S+)(?:[ \t]+#[^\n]*)?[ \t]*$/gim,
    match => isAllowedSshEndpoint(match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "ssh-proxy-command",
    /^[ \t]*ProxyCommand[ \t=]+(\S.*)$/gim,
    match => isAllowedSshEndpoint(match[1] ?? ""),
  );
  /*
   * Meta Model API keys. The pattern above does not match them: the measured shape is
   * `LLM|<16 digits>|<27 chars>`, verified against a real key's grammar (never its value).
   * The `meta-muse` provider imports one of these, so a leak has to be detectable here.
   */
  addFindingsForPattern(
    findings,
    file,
    text,
    "meta-api-key",
    /\bLLM\|\d+\|[A-Za-z0-9_-]{10,}\b/g,
    match => isAllowedTokenLooking(file, match[0]),
  );
  return findings;
}

function scanFile(file: string): Finding[] {
  return scanText(file, readFileSync(file, "utf-8"));
}

/**
 * Finding kinds whose matched text is itself a secret.
 *
 * A home path or an email is context a reviewer needs in the failure message. A bearer
 * token or an API key is the very thing the scan exists to keep out of a readable
 * artifact, so the report names where it is instead of what it is.
 *
 * Both SSH kinds are redacted: the `ProxyCommand` value carries the binary path, the
 * access method and the tunnel options, and the `HostName` value is the endpoint
 * itself. CI logs are far more widely readable than the diff either was caught in.
 */
const REDACTED_FINDING_KINDS = new Set([
  "bearer-token",
  "token-looking",
  "meta-api-key",
  "ssh-proxy-command",
  // Redacted for the same reason as the ProxyCommand: this scan runs in CI on a
  // public repository, so printing the value would republish the endpoint into a
  // public log — the scanner leaking what it was written to catch. `file:line`
  // already locates it for whoever has to remove it.
  "ssh-endpoint",
]);

if (import.meta.main) {
  runScan();
}

/**
 * Run the scan. Invoked only as a script, never on import.
 *
 * This used to run at module scope, so `import { scanText }` executed a full
 * repo scan as a side effect — and a failing scan called `process.exit(1)`,
 * taking the importing test process with it. That coupling is invisible while
 * the tree is clean and bites the moment a detector finds something: adding the
 * `ssh-endpoint` rule below broke `privacy-scan-meta-key.test.ts`, which does
 * nothing but import the same seam this file exports for testing.
 */
function runScan(): void {
  const findings = gitLsFiles()
    .filter(existsSync)
    .filter(shouldScan)
    .flatMap(scanFile);

  if (findings.length > 0) {
    console.error("Privacy scan failed:");
    for (const finding of findings) {
      // A credential finding must not be echoed: this output goes to stderr and into CI
      // logs, so printing the match would copy a leaked secret from one place it should
      // not be into another — and CI logs are far more widely readable than a diff.
      // The location and kind are enough to find it; the value is one `git show` away
      // for whoever is fixing it.
      const shown = REDACTED_FINDING_KINDS.has(finding.kind) ? "<redacted>" : finding.value;
      console.error(`${finding.file}:${finding.line} ${finding.kind}: ${shown}`);
    }
    process.exit(1);
  }

  console.log("Privacy scan passed");
}
