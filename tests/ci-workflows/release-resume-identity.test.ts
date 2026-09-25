import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertResumeSourceMetadata } from "../../scripts/verify-release-resume";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { createTempHome } from "../helpers/temp-home";

const SHA = "a".repeat(40);
const workflow = Bun.YAML.parse(readFileSync(repoPath(".github/workflows/release.yml"), "utf8")) as {
  jobs: { publish: { steps: Array<{ name: string; id?: string; env?: Record<string, string>; run?: string }> } };
};
const steps = workflow.jobs.publish.steps;
const metadata = steps.find(step => step.name === "Preflight release metadata")!;
const publication = steps.find(step => step.name === "Publish (or dry-run)")!;

test.each(["", "null", "{}", "[]", '"short"', JSON.stringify("b".repeat(40)), JSON.stringify(SHA.toUpperCase()), JSON.stringify(` ${SHA}`), JSON.stringify("x".repeat(1025))])("resume rejects nonmatching or nonscalar registry metadata %s", raw => {
  expect(() => assertResumeSourceMetadata(raw, SHA)).toThrow();
});
test("resume accepts only exact audited source metadata", () => {
  expect(() => assertResumeSourceMetadata(JSON.stringify(SHA), SHA)).not.toThrow();
  expect(metadata.id).toBe("metadata");
  expect(publication.env?.VERIFIED_RESUME_SHA).toBe("${{ steps.metadata.outputs.resume_sha }}");
});

async function runResume(raw: string, status = 0, omitVerification = false) {
  const home = createTempHome("ocx-resume-identity-");
  const output = join(home.root, "output");
  const summary = join(home.root, "summary");
  const calls = join(home.root, "calls");
  for (const path of [output, summary, calls]) writeFileSync(path, "");
  const prelude = String.raw`
    node() { echo '@fixture/release'; }
    bun() { "$TEST_BUN" "$@"; }
    git() { return 0; }
    gh() { return 1; }
    npm() {
      echo "npm $*" >> "$CALLS"
      if [ "$1" = view ] && [ "$3" = version ]; then echo 9.8.7; return 0; fi
      if [ "$1" = view ] && [ "$3" = gitHead ]; then
        [ "$4" = --json ] && [ "$5" = --registry=https://registry.npmjs.org ] && [ "$6" = --fetch-retries=0 ] && [ "$7" = --fetch-timeout=8000 ] || return 99
        [ "$REGISTRY_STATUS" = 0 ] || return "$REGISTRY_STATUS"
        printf '%s\n' "$REGISTRY_JSON"; return 0
      fi
      echo 'unexpected npm mutation' >&2; return 98
    }
    timeout() {
      [ "$1" = --kill-after=2s ] && [ "$2" = 10s ] || return 99
      shift 2; "$@"
    }
  `;
  const preflight = omitVerification ? "" : metadata.run!;
  const script = prelude + preflight + '\nVERIFIED_RESUME_SHA=$(sed -n "s/^resume_sha=//p" "$GITHUB_OUTPUT")\n'
    + publication.run + '\necho tag-created >> "$CALLS"\necho release-created >> "$CALLS"\n';
  try {
    const child = Bun.spawn(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
      cwd: repoRoot(),
      env: { ...process.env, TEST_BUN: process.execPath, RESUME: "true", DRY_RUN: "false", NPM_DIST_TAG: "latest",
        RELEASE_VERSION: "9.8.7", GITHUB_SHA: SHA, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
        CALLS: calls, REGISTRY_JSON: raw, REGISTRY_STATUS: String(status) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, stdout, stderr, output: readFileSync(output, "utf8"), calls: readFileSync(calls, "utf8") };
  } finally { home.remove(); }
}

test.skipIf(process.platform === "win32")("the real resume shell refuses before acknowledgement and Git publication", async () => {
  for (const [raw, status] of [[JSON.stringify("b".repeat(40)), 0], ["", 0], ["{}", 0], ["[]", 0], ["null", 0], ["not-json", 0], [JSON.stringify(SHA), 1], [JSON.stringify(SHA), 124]] as const) {
    const result = await runResume(raw, status);
    expect(result.exit, result.stdout + result.stderr).not.toBe(0);
    expect(result.output).not.toContain("published=true");
    expect(result.calls).not.toContain("npm publish");
    expect(result.calls).not.toContain("tag-created");
    expect(result.calls).not.toContain("release-created");
  }
  const absent = await runResume(JSON.stringify(SHA), 0, true);
  expect(absent.exit).not.toBe(0);
  expect(absent.output).not.toContain("published=true");
});

test.skipIf(process.platform === "win32")("matching source metadata resumes without republishing npm", async () => {
  const result = await runResume(JSON.stringify(SHA));
  expect(result.exit, result.stdout + result.stderr).toBe(0);
  expect(result.output).toContain(`resume_sha=${SHA}`);
  expect(result.output).toContain("published=true");
  expect(result.calls).not.toContain("npm publish");
  expect(result.calls).toContain("release-created");
});
