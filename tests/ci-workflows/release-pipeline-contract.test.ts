import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

type WorkflowStep = {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
  shell?: string;
};

type WorkflowJob = {
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  strategy?: { matrix?: { include?: Array<{ os?: string }> } };
  steps?: WorkflowStep[];
};

type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, WorkflowJob | undefined> };

function needsOf(job: WorkflowJob | undefined): string[] {
  if (job?.needs === undefined) return [];
  return typeof job.needs === "string" ? [job.needs] : job.needs;
}

function readWorkflow(...segments: string[]): Workflow {
  return Bun.YAML.parse(readFileSync(repoPath(...segments), "utf8")) as Workflow;
}

function triggerPaths(workflowText: string, trigger: string, until: string): string[] {
  const afterTrigger = workflowText.split(`${trigger}:`)[1]?.split(`${until}:`)[0];
  expect(afterTrigger).toBeDefined();
  return afterTrigger!
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith('- "'))
    .map(line => line.slice(3, -1));
}

/** Keep credentials and shell startup hooks out of mocked release subprocesses. */
function releaseTestEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: "", BASH_ENV: "", ENV: "" };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}

/** Prefer native Git Bash on Windows; never invoke the System32 WSL launcher. */
function releaseTestBash(): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const git = Bun.which("git");
    if (git) candidates.push(join(dirname(git), "..", "bin", "bash.exe"),
      join(dirname(git), "..", "usr", "bin", "bash.exe"));
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (root) candidates.push(join(root, "Git", "bin", "bash.exe"));
    }
    if (process.env.LOCALAPPDATA) candidates.push(
      join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  const onPath = Bun.which("bash");
  if (onPath && !/[\\/](?:system32|sysnative)[\\/]bash(?:\.exe)?$/i.test(onPath)) {
    candidates.push(onPath);
  }
  for (const candidate of new Set(candidates)) {
    if (!existsSync(candidate)) continue;
    try {
      const probe = Bun.spawnSync([candidate, "--noprofile", "--norc", "-c", 'printf "%s" "$BASH_VERSION"'],
        { env: releaseTestEnv(), timeout: 2_000, maxBuffer: 4096 });
      if (probe.exitCode === 0 && probe.stdout.toString().trim()) return candidate;
    } catch { /* Try another native installation; no shell means an explicit local skip. */ }
  }
  return null;
}

function releaseShellPath(nodeDirectory: string, bashPath: string, windows: boolean): string {
  if (!windows) return `${nodeDirectory}:/usr/bin:/bin`;
  const shellDirectory = win32.dirname(bashPath);
  return [nodeDirectory, shellDirectory, win32.join(shellDirectory, "..", "usr", "bin")].join(";");
}

/**
 * Contracts for the release pipeline itself. Each assertion encodes a defect that a green
 * workflow can still carry: a bash script silently reinterpreted by PowerShell on a Windows
 * runner, a checksum that records a path its verifier cannot resolve, publication that outruns
 * packaging, and a service gate that names one file while the implementation is a directory.
 */
describe("release pipeline contract", () => {
  const release = readWorkflow(".github", "workflows", "release.yml");

  test("signing jobs require dev dispatch validation and check out the selected source", () => {
    expect(Object.keys(release.on ?? {})).toEqual(["workflow_dispatch"]);
    const dispatch = release.jobs?.["validate-dispatch"]?.steps?.find(step => step.name === "Resolve eligible source");
    expect(dispatch?.run).toContain("refs/heads/dev");
    expect(dispatch?.run).toContain(".github/scripts/release-evidence.cjs resolve");
    expect(JSON.stringify(release.jobs?.["validate-dispatch"])).not.toContain("secrets.");
    expect(needsOf(release.jobs?.preflight)).toEqual(["validate-dispatch"]);
    for (const id of ["package-standalone", "package-desktop"]) {
      const job = release.jobs?.[id];
      expect(needsOf(job), id).toEqual(["validate-dispatch", "preflight"]);
      expect(job?.if, id).toBe("${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev' }}");
      const steps = job?.steps ?? [];
      expect(steps.find(step => step.name === "Checkout")?.with?.ref, id)
        .toBe("${{ needs.validate-dispatch.outputs.source_sha }}");
      expect(steps.find(step => step.name === "Stamp and verify release version")?.run, id)
        .toContain("release-version-sources.ts check");
      expect(steps.some(step => JSON.stringify(step).includes("secrets.")), id).toBe(true);
    }
    expect(release.jobs?.["sign-linux-updater"]).toBeUndefined();
    expect(release.jobs?.["sign-windows-standalone"]).toBeUndefined();
  });

  test("release verification uses only the pinned workflow revision", () => {
    const steps = release.jobs?.["verify-release"]?.steps ?? [];
    const checkout = steps.find(step => step.name === "Checkout trusted workflow revision");
    expect(checkout?.with?.ref).toBe("${{ needs.validate-dispatch.outputs.workflow_sha }}");
    expect(steps.some(step => String(step.with?.ref ?? "").includes("source_sha"))).toBe(false);
    expect(steps.find(step => step.name === "Bind verified asset digests")?.run).toContain("sha256");
  });

  test("release documentation names every dispatch input and the current recovery rules (#8329)", () => {
    const doc = readFileSync(repoPath("structure", "ops", "docs-and-release.md"), "utf8");
    const start = doc.indexOf("\n## Release workflow");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = doc.indexOf("\n## ", start + 1);
    const section = doc.slice(start, end < 0 ? undefined : end);
    const dispatch = (release.on as { workflow_dispatch?: { inputs?: Record<string, unknown> } } | undefined)?.workflow_dispatch;
    const inputs = Object.keys(dispatch?.inputs ?? {});
    expect(inputs).toContain("resume-after-npm-publish");
    for (const input of inputs) expect(section, input).toContain(`\`${input}\``);
    for (const gate of [".github/scripts/release-history.cjs", ".github/scripts/release-resume.cjs", "scripts/verify-release-resume.ts"]) {
      expect(section, gate).toContain(gate);
    }
    // The pre-#8328 text said resume was refused, npm history failed the run, and reconciliation was outstanding.
    const ci = readFileSync(repoPath("structure", "ops", "cross-platform-ci.md"), "utf8");
    const contributing = readFileSync(repoPath("docs-site", "src", "content", "docs", "contributing.md"), "utf8");
    for (const [name, text] of [["docs-and-release.md", doc], ["cross-platform-ci.md", ci], ["contributing.md", contributing]] as const) {
      for (const stale of ["refuses resume", "Resume is also refused", "Resume is refused", "fails closed on existing npm",
        "fails closed for existing npm", "history reconciliation, independent"]) {
        expect(text, `${name}: ${stale}`).not.toContain(stale);
      }
    }
  });

  test("attachment checks the entire receipt digest set and never clobbers assets", () => {
    const steps = release.jobs?.["attach-release"]?.steps ?? [];
    const receipt = steps.find(step => step.name === "Require the verification receipt for this commit");
    const attach = steps.find(step => step.name === "Attach to the release");
    expect(receipt?.run).toContain("sha256");
    expect(attach?.run).not.toContain("--clobber");
    expect(attach?.run).toContain("existing asset");
  });

  test.skipIf(process.platform === "win32")("attachment reuses an existing published asset only when its digest matches", () => {
    const attach = release.jobs?.["attach-release"]?.steps?.find(step => step.name === "Attach to the release")?.run;
    expect(attach).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "ocx-existing-asset-"));
    try {
      mkdirSync(join(root, "verification")); mkdirSync(join(root, "dist/release"), { recursive: true });
      writeFileSync(join(root, "dist/release/app.zip"), "archive");
      const digest = createHash("sha256").update("archive").digest("hex");
      writeFileSync(join(root, "verification/receipt.json"), JSON.stringify({ assets: { "app.zip": digest } }));
      const mock = String.raw`
        gh() {
          case "$1:$2" in
            release:view) if [ "$5" = isDraft ]; then printf 'false\n'; else printf '%s\n' "$RELEASE_INFO"; fi ;;
            release:upload|release:edit) printf 'mutation\n' >> "$CALLS"; return 91 ;;
            *) return 92 ;;
          esac
        }
      `;
      const calls = join(root, "calls");
      const run = (assetDigest: string) => {
        writeFileSync(calls, "");
        const result = Bun.spawnSync(["bash", "-e", "-c", mock + attach!], { cwd: root, env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin", RELEASE_VERSION: "2.1.0", RUNNER_TEMP: root, CALLS: calls,
          RELEASE_INFO: JSON.stringify({ isDraft: false, assets: [{ name: "app.zip", state: "uploaded", digest: assetDigest }] }),
        }, stdout: "pipe", stderr: "pipe" });
        return { result, calls: readFileSync(calls, "utf8") };
      };
      const match = run(`sha256:${digest}`);
      expect(match.result.exitCode, match.result.stderr.toString()).toBe(0);
      expect(match.calls).toBe("");
      const mismatch = run(`sha256:${"0".repeat(64)}`);
      expect(mismatch.result.exitCode).not.toBe(0);
      expect(mismatch.calls).toBe("");
    } finally { removeTreeWithRetry(root); }
  });

  test.skipIf(process.platform === "win32")("attachment uploads only missing assets and rechecks every remote digest", () => {
    const attach = release.jobs?.["attach-release"]?.steps?.find(step => step.name === "Attach to the release")?.run;
    expect(attach).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "ocx-partial-assets-"));
    try {
      mkdirSync(join(root, "verification")); mkdirSync(join(root, "dist/release"), { recursive: true });
      const assets: Record<string, string> = {};
      for (const name of ["existing.zip", "missing.zip"]) {
        writeFileSync(join(root, "dist/release", name), name);
        assets[name] = createHash("sha256").update(name).digest("hex");
      }
      writeFileSync(join(root, "verification/receipt.json"), JSON.stringify({ assets }));
      const remote = (names: string[], altered = false) => JSON.stringify({ isDraft: true, assets: names.map(name => ({
        name, state: "uploaded", digest: `sha256:${altered && name === "existing.zip" ? "0".repeat(64) : assets[name]}`,
      })) });
      const mock = String.raw`
        gh() {
          printf '%s\n' "$*" >> "$CALLS"
          case "$1:$2" in
            release:view)
              if [ "$5" = isDraft ]; then printf 'true\n';
              elif [ -f "$RUNNER_TEMP/uploaded" ]; then printf '%s\n' "$FINAL_INFO";
              else printf '%s\n' "$INITIAL_INFO"; fi ;;
            release:upload) : > "$RUNNER_TEMP/uploaded" ;;
            release:edit) : ;;
            *) return 92 ;;
          esac
        }
      `;
      const calls = join(root, "calls");
      const execute = (finalInfo: string) => {
        writeFileSync(calls, "");
        const marker = join(root, "uploaded"); if (existsSync(marker)) unlinkSync(marker);
        const result = Bun.spawnSync(["bash", "-e", "-c", mock + attach!], { cwd: root, env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin", RELEASE_VERSION: "2.1.0", RUNNER_TEMP: root, CALLS: calls,
          INITIAL_INFO: remote(["existing.zip"]), FINAL_INFO: finalInfo,
        }, stdout: "pipe", stderr: "pipe" });
        return { result, calls: readFileSync(calls, "utf8") };
      };
      const valid = execute(remote(["existing.zip", "missing.zip"]));
      expect(valid.result.exitCode, valid.result.stderr.toString()).toBe(0);
      expect(valid.calls).toContain("release upload v2.1.0 dist/release/missing.zip\n");
      expect(valid.calls).not.toContain("release upload v2.1.0 dist/release/existing.zip");
      expect(valid.calls).toContain("release edit v2.1.0 --draft=false");
      const changed = execute(remote(["existing.zip", "missing.zip"], true));
      expect(changed.result.exitCode).not.toBe(0);
      expect(changed.calls).not.toContain("release edit");
    } finally { removeTreeWithRetry(root); }
  });

  test.skipIf(process.platform === "win32")("asset receipt binds the complete file set and detects every changed identity or byte", () => {
    const bind = release.jobs?.["verify-release"]?.steps?.find(step => step.name === "Bind verified asset digests")?.run;
    const verify = release.jobs?.["attach-release"]?.steps?.find(step => step.name === "Require the verification receipt for this commit")?.run;
    expect(bind).toBeDefined(); expect(verify).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "ocx-release-assets-"));
    try {
      mkdirSync(join(root, "dist/release"), { recursive: true }); mkdirSync(join(root, "verification"));
      writeFileSync(join(root, "dist/release/a.zip"), "archive");
      writeFileSync(join(root, "dist/release/a.zip.sha256"), "checksum");
      const source = "a".repeat(40), workflow = "b".repeat(40);
      writeFileSync(join(root, "verification/receipt.json"), JSON.stringify({ version: "2.1.0", sha: source, repo: "org/repo" }));
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", RELEASE_VERSION: "2.1.0", SOURCE_SHA: source,
        WORKFLOW_SHA: workflow, GITHUB_REPOSITORY: "org/repo", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
      const execute = (script: string, extra: Record<string, string> = {}) => Bun.spawnSync(["bash", "-e", "-c", script], {
        cwd: root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe",
      });
      const bound = execute(bind!); expect(bound.exitCode, bound.stderr.toString()).toBe(0);
      const receipt = JSON.parse(readFileSync(join(root, "verification/receipt.json"), "utf8"));
      expect(Object.keys(receipt.assets).sort()).toEqual(["a.zip", "a.zip.sha256"]);
      expect(receipt.assets["a.zip"]).toBe(createHash("sha256").update("archive").digest("hex"));
      expect(execute(verify!).exitCode).toBe(0);
      expect(execute(verify!, { GITHUB_RUN_ATTEMPT: "2" }).exitCode).toBe(0);
      for (const extra of [{ SOURCE_SHA: "c".repeat(40) }, { WORKFLOW_SHA: "c".repeat(40) },
        { RELEASE_VERSION: "2.1.1" }, { GITHUB_RUN_ATTEMPT: "0" }]) {
        expect(execute(verify!, extra).exitCode, JSON.stringify(extra)).not.toBe(0);
      }
      writeFileSync(join(root, "dist/release/a.zip"), "modified");
      expect(execute(verify!).exitCode).not.toBe(0);
      writeFileSync(join(root, "dist/release/a.zip"), "archive");
      writeFileSync(join(root, "dist/release/extra"), "unexpected");
      expect(execute(verify!).exitCode).not.toBe(0);
    } finally { removeTreeWithRetry(root); }
  });

  test("npm package builds without publication credentials and a trusted job verifies it", () => {
    const pack = release.jobs?.["package-npm"];
    const verify = release.jobs?.["verify-npm"];
    expect(pack?.permissions).toEqual({ contents: "read" });
    expect(pack?.steps?.find(step => step.name === "Build npm package")?.run).toContain("npm run prepublishOnly");
    expect(pack?.steps?.find(step => step.name === "Build npm package")?.run).toContain("npm pack --ignore-scripts");
    expect(needsOf(verify)).toContain("package-npm");
    expect(verify?.permissions).toEqual({ contents: "read", actions: "read" });
    expect(verify?.steps?.find(step => step.name === "Create verified npm receipt")?.run).toContain("sha256");
    expect(verify?.if).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("trusted npm receipt creation rejects missing or wrong package gitHead", () => {
    const create = release.jobs?.["verify-npm"]?.steps?.find(step => step.name === "Create verified npm receipt")?.run;
    expect(create).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "ocx-githead-receipt-"));
    try {
      mkdirSync(join(root, "npm-artifact")); mkdirSync(join(root, "package"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@fixture/pkg" }));
      const archive = join(root, "npm-artifact/package.tgz"), output = join(root, "output");
      writeFileSync(output, "");
      const source = "a".repeat(40);
      const run = (gitHead?: string) => {
        writeFileSync(join(root, "package/package.json"), JSON.stringify({ name: "@fixture/pkg", version: "9.8.7", ...(gitHead ? { gitHead } : {}) }));
        const packed = Bun.spawnSync(["tar", "-czf", archive, "package"], { cwd: root, stdout: "pipe", stderr: "pipe" });
        expect(packed.exitCode, packed.stderr.toString()).toBe(0);
        return Bun.spawnSync(["bash", "-e", "-c", create!], { cwd: root, env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin", SOURCE_SHA: source, WORKFLOW_SHA: "b".repeat(40),
          RELEASE_VERSION: "9.8.7", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: output,
        }, stdout: "pipe", stderr: "pipe" });
      };
      expect(run().exitCode).not.toBe(0);
      expect(existsSync(join(root, "npm-artifact/receipt.json"))).toBe(false);
      expect(run("c".repeat(40)).exitCode).not.toBe(0);
      expect(existsSync(join(root, "npm-artifact/receipt.json"))).toBe(false);
      const valid = run(source); expect(valid.exitCode, valid.stderr.toString()).toBe(0);
      expect(JSON.parse(readFileSync(join(root, "npm-artifact/receipt.json"), "utf8")).gitHead).toBe(source);
    } finally { removeTreeWithRetry(root); }
  });

  test.skipIf(process.platform === "win32")("real npm publish of the packed tarball sends the selected gitHead to a loopback registry", async () => {
    const build = release.jobs?.["package-npm"]?.steps?.find(step => step.name === "Build npm package")?.run;
    const publish = release.jobs?.publish?.steps?.find(step => step.id === "publication")?.run;
    expect(build).toBeDefined(); expect(publish).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "ocx-npm-local-registry-"));
    let document: Record<string, any> | undefined;
    let requestPath = "";
    let publishRequests = 0;
    const server = createServer((request, response) => {
      if (request.method !== "PUT") { response.writeHead(404); response.end(); return; }
      publishRequests += 1;
      requestPath = request.url ?? "";
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        try { document = JSON.parse(Buffer.concat(chunks).toString("utf8")); response.writeHead(201, { "content-type": "application/json" }); response.end('{"ok":true}'); }
        catch { response.writeHead(400); response.end(); }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw Error("loopback registry unavailable");
      const registry = `http://127.0.0.1:${address.port}/`;
      const candidate = join(root, "candidate"), publisher = join(root, "publisher"), scratch = join(root, "runner-temp");
      mkdirSync(candidate); mkdirSync(publisher); mkdirSync(scratch);
      writeFileSync(join(root, "npmrc"), `//127.0.0.1:${address.port}/:_authToken=local-fixture-token\n`);
      writeFileSync(join(root, "global-npmrc"), "");
      writeFileSync(join(candidate, "package.json"), JSON.stringify({
        name: "@fixture/ocx-githead", version: "9.8.7", files: ["index.js"],
        scripts: { prepublishOnly: "node -e \"\"", prepack: "node -e \"\"", publish: "node -e \"require('fs').writeFileSync(process.env.FIXTURE_MARKER,'bad')\"" },
      }));
      writeFileSync(join(candidate, "index.js"), "export default 1;\n");
      writeFileSync(join(publisher, "workflow.txt"), "different workflow revision\n");
      const baseEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", FIXTURE_MARKER: join(root, "lifecycle-ran"),
        GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
        NPM_CONFIG_USERCONFIG: join(root, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(root, "global-npmrc"), NPM_CONFIG_CACHE: join(root, "npm-cache"),
        NPM_CONFIG_REGISTRY: registry, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" };
      const git = (cwd: string, ...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd, env: baseEnv, stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode, result.stderr.toString()).toBe(0); return result.stdout.toString().trim();
      };
      git(candidate, "init", "-q"); git(candidate, "add", "package.json", "index.js"); git(candidate, "commit", "-q", "-m", "source");
      const source = git(candidate, "rev-parse", "HEAD");
      git(publisher, "init", "-q"); git(publisher, "add", "workflow.txt"); git(publisher, "commit", "-q", "-m", "workflow");
      expect(git(publisher, "rev-parse", "HEAD")).not.toBe(source);
      const wrongProc = Bun.spawn(["bash", "-e", "-c", build!], { cwd: candidate,
        env: { ...baseEnv, SOURCE_SHA: "0".repeat(40), RELEASE_VERSION: "9.8.7", RUNNER_TEMP: scratch }, stdout: "pipe", stderr: "pipe" });
      const [wrongExit] = await Promise.all([wrongProc.exited, new Response(wrongProc.stdout).text(), new Response(wrongProc.stderr).text()]);
      expect(wrongExit).not.toBe(0);
      expect(JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")).gitHead).toBeUndefined();
      expect(existsSync(join(candidate, "dist/npm/package.tgz"))).toBe(false);
      const buildProc = Bun.spawn(["bash", "-e", "-c", build!], { cwd: candidate, env: { ...baseEnv, SOURCE_SHA: source, RELEASE_VERSION: "9.8.7", RUNNER_TEMP: scratch }, stdout: "pipe", stderr: "pipe" });
      const [buildExit, buildOut, buildErr] = await Promise.all([buildProc.exited, new Response(buildProc.stdout).text(), new Response(buildProc.stderr).text()]);
      expect(buildExit, buildOut + buildErr).toBe(0);
      const tarball = join(candidate, "dist/npm/package.tgz");
      const manifest = Bun.spawnSync(["tar", "-xOzf", tarball, "package/package.json"], { stdout: "pipe", stderr: "pipe" });
      expect(manifest.exitCode, manifest.stderr.toString()).toBe(0);
      expect(JSON.parse(manifest.stdout.toString()).gitHead).toBe(source);
      const output = join(root, "output"), summary = join(root, "summary"); writeFileSync(output, ""); writeFileSync(summary, "");
      const proc = Bun.spawn(["bash", "-e", "-c", publish!], { cwd: publisher, env: { ...baseEnv, NPM_TARBALL: tarball,
        NPM_DIST_TAG: "latest", RESUME: "false", SOURCE_SHA: source, RELEASE_VERSION: "9.8.7", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(exit, stdout + stderr).toBe(0);
      expect(publishRequests).toBe(1);
      expect(requestPath.toLowerCase()).toBe("/@fixture%2focx-githead");
      expect(document?.versions?.["9.8.7"]?.gitHead).toBe(source);
      expect(readFileSync(output, "utf8")).toContain("published=true");
      expect(existsSync(join(root, "lifecycle-ran"))).toBe(false);
      const attachments = Object.values(document?._attachments ?? {}) as Array<{ data?: string }>;
      expect(attachments).toHaveLength(1);
      expect(createHash("sha256").update(Buffer.from(attachments[0]!.data!, "base64")).digest("hex"))
        .toBe(createHash("sha256").update(readFileSync(tarball)).digest("hex"));
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      removeTreeWithRetry(root);
    }
  }, 30000);

  test.skipIf(process.platform === "win32")("published npm source must match the selected SHA before GitHub release creation", () => {
    const steps = release.jobs?.publish?.steps ?? [];
    const gate = steps.find(step => step.name === "Verify published npm source");
    const create = steps.find(step => step.name === "Create GitHub release");
    expect(gate?.run).toBeDefined();
    expect(steps.indexOf(gate!)).toBeGreaterThan(steps.findIndex(step => step.id === "publication"));
    expect(steps.indexOf(gate!)).toBeLessThan(steps.indexOf(create!));
    const source = "a".repeat(40);
    const mock = String.raw`
      npm() { printf '%s\n' "$REGISTRY_HEAD"; }
      timeout() { shift 2; "$@"; }
      sleep() { :; }
    `;
    const run = (head: string) => Bun.spawnSync(["bash", "-e", "-c", mock + gate!.run!], {
      cwd: repoPath(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SOURCE_SHA: source,
        RELEASE_VERSION: "9.8.7", REGISTRY_HEAD: head }, stdout: "pipe", stderr: "pipe",
    });
    expect(run(JSON.stringify(source)).exitCode).toBe(0);
    expect(run(JSON.stringify("b".repeat(40))).exitCode).not.toBe(0);
    expect(run("null").exitCode).not.toBe(0);
    expect(run("").exitCode).not.toBe(0);
  });

  test("OIDC publication uses only trusted workflow code and the verified tarball", () => {
    const publish = release.jobs?.publish;
    expect(needsOf(publish)).toContain("verify-npm");
    const steps = publish?.steps ?? [];
    const checkout = steps.find(step => step.name === "Checkout trusted workflow revision");
    expect(checkout?.with?.ref).toBe("${{ needs.validate-dispatch.outputs.workflow_sha }}");
    expect(steps.some(step => String(step.with?.ref ?? "").includes("source_sha"))).toBe(false);
    expect(steps.some(step => step.uses?.startsWith("./"))).toBe(false);
    expect(steps.some(step => /^\s*(?:bun install|npm (?:install|run|pack))\b/m.test(step.run ?? ""))).toBe(false);
    expect(steps.find(step => step.name === "Verify immutable npm receipt")?.run).toContain("sha256");
    expect(steps.find(step => step.id === "publication")?.run).toContain('npm publish "$NPM_TARBALL" --ignore-scripts');
    // npm treats "npm-artifact/package.tgz" as the GitHub repo npm-artifact/package.tgz; only an
    // explicitly local spec (./ or an absolute path) publishes the verified file.
    expect(String(publish?.env?.NPM_TARBALL)).toMatch(/^(?:\.\/|\/)/);
    expect(publish?.if).toContain("inputs.dry-run != true");
  });

  test.skipIf(process.platform === "win32")("npm receipt verification rejects changed source, workflow, version and payload", () => {
    const verify = release.jobs?.publish?.steps?.find(step => step.name === "Verify immutable npm receipt")?.run;
    expect(verify).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "ocx-npm-receipt-"));
    try {
      mkdirSync(join(root, "npm-artifact")); mkdirSync(join(root, "package"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@fixture/pkg" }));
      writeFileSync(join(root, "package/package.json"), JSON.stringify({ name: "@fixture/pkg", version: "9.8.7", gitHead: "a".repeat(40) }));
      const archive = join(root, "npm-artifact/package.tgz");
      const packed = Bun.spawnSync(["tar", "-czf", archive, "package"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(packed.exitCode, packed.stderr.toString()).toBe(0);
      const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
      const source = "a".repeat(40), workflow = "b".repeat(40);
      const create = release.jobs?.["verify-npm"]?.steps?.find(step => step.name === "Create verified npm receipt")?.run;
      expect(create).toBeDefined();
      const output = join(root, "output"); writeFileSync(output, "");
      const createReceipt = (version: string) => Bun.spawnSync(["bash", "-e", "-c", create!], { cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SOURCE_SHA: source, WORKFLOW_SHA: workflow,
          RELEASE_VERSION: version, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: output },
        stdout: "pipe", stderr: "pipe" });
      expect(createReceipt("9.8.8").exitCode).not.toBe(0);
      expect(existsSync(join(root, "npm-artifact/receipt.json"))).toBe(false);
      const created = createReceipt("9.8.7");
      expect(created.exitCode, created.stderr.toString()).toBe(0);
      expect(JSON.parse(readFileSync(join(root, "npm-artifact/receipt.json"), "utf8"))).toEqual({
        sourceSha: source, workflowSha: workflow, version: "9.8.7", runId: "123", attempt: "1", packageName: "@fixture/pkg", gitHead: source, sha256: digest,
      });
      expect(readFileSync(output, "utf8")).toBe(`sha256=${digest}\n`);
      const execute = (extra: Record<string, string> = {}) => Bun.spawnSync(["bash", "-e", "-c", verify!], { cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SOURCE_SHA: source, WORKFLOW_SHA: workflow,
          RELEASE_VERSION: "9.8.7", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", NPM_TARBALL: archive, EXPECTED_DIGEST: digest, ...extra },
        stdout: "pipe", stderr: "pipe" });
      const valid = execute();
      expect(valid.exitCode, valid.stderr.toString()).toBe(0);
      expect(execute({ GITHUB_RUN_ATTEMPT: "2" }).exitCode).toBe(0);
      for (const mismatch of [{ SOURCE_SHA: "c".repeat(40) }, { WORKFLOW_SHA: "c".repeat(40) },
        { RELEASE_VERSION: "9.8.8" }, { GITHUB_RUN_ATTEMPT: "0" }, { GITHUB_RUN_ATTEMPT: "bad" },
        { GITHUB_RUN_ID: "124" }, { EXPECTED_DIGEST: "0".repeat(64) }]) {
        expect(execute(mismatch).exitCode, JSON.stringify(mismatch)).not.toBe(0);
      }
      const receiptPath = join(root, "npm-artifact/receipt.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, gitHead: "c".repeat(40) }));
      expect(execute().exitCode).not.toBe(0);
      writeFileSync(join(root, "package/package.json"), JSON.stringify({ name: "@fixture/pkg", version: "9.8.7", gitHead: "c".repeat(40) }));
      const forged = Bun.spawnSync(["tar", "-czf", archive, "package"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(forged.exitCode, forged.stderr.toString()).toBe(0);
      const forgedDigest = createHash("sha256").update(readFileSync(archive)).digest("hex");
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, sha256: forgedDigest }));
      expect(execute({ EXPECTED_DIGEST: forgedDigest }).exitCode).not.toBe(0);
      writeFileSync(archive, "changed payload");
      expect(execute().exitCode).not.toBe(0);
    } finally { removeTreeWithRetry(root); }
  });

  test.skipIf(process.platform === "win32")("CI and service evidence is rechecked against the source and reachable baseline", () => {
    const verify = release.jobs?.["verify-npm"]?.steps?.find(step => step.name === "Recheck source CI and service evidence")?.run;
    const publish = release.jobs?.publish?.steps?.find(step => step.name === "Recheck source CI and service evidence")?.run;
    expect(verify).toBeDefined();
    expect(publish).toBe(verify);
    const root = mkdtempSync(join(tmpdir(), "ocx-release-evidence-"));
    try {
      const calls = join(root, "calls"), source = "a".repeat(40), baseline = "b".repeat(40);
      const mock = String.raw`
        git() { case "$1" in tag) if [ "$BASELINE" = yes ]; then echo v2.0.0; fi ;; rev-parse) echo "$BASE_SHA" ;; *) return 91 ;; esac; }
        bun() { cat >/dev/null; [ "$BASELINE" = yes ] && echo v2.0.0 || :; }
        gh() { echo "$DRAFT"; }
        node() {
          if [ "$1" = .github/scripts/release-evidence.cjs ]; then
            printf '%s\n' "$*" >> "$CALLS"
            case "$2" in check) return "$CI_STATUS" ;; service-range) printf '{"required":%s}\n' "$REQUIRED" ;; service) return "$SERVICE_STATUS" ;; *) return 92 ;; esac
          else command node "$@"; fi
        }
      `;
      const execute = (extra: Record<string, string> = {}) => {
        writeFileSync(calls, "");
        const result = Bun.spawnSync(["bash", "-e", "-c", mock + verify!], { cwd: root, env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin", SOURCE_SHA: source, BASE_SHA: baseline, RELEASE_VERSION: "2.1.0",
          BASELINE: "yes", DRAFT: "false", REQUIRED: "true", CI_STATUS: "0", SERVICE_STATUS: "0", CALLS: calls, ...extra,
        }, stdout: "pipe", stderr: "pipe" });
        return { code: result.exitCode, calls: readFileSync(calls, "utf8"), stderr: result.stderr.toString() };
      };
      const required = execute();
      expect(required.code, required.stderr).toBe(0);
      expect(required.calls).toContain(`check ${source}`);
      expect(required.calls).toContain(`service-range ${source} ${baseline}`);
      expect(required.calls).toContain(`service ${source}`);
      const unchanged = execute({ REQUIRED: "false" });
      expect(unchanged.code, unchanged.stderr).toBe(0);
      expect(unchanged.calls).not.toContain(`service ${source}`);
      const initial = execute({ BASELINE: "no" });
      expect(initial.code, initial.stderr).toBe(0);
      expect(initial.calls).toContain(`service-range ${source} --initial`);
      for (const bad of [{ CI_STATUS: "1" }, { SERVICE_STATUS: "1" }, { DRAFT: "true" }, { REQUIRED: "null" }]) {
        expect(execute(bad).code, JSON.stringify(bad)).not.toBe(0);
      }
    } finally { removeTreeWithRetry(root); }
  });

  test.skipIf(process.platform === "win32")("history collector receives the exact source and channel and rejects failures", () => {
    const gate = release.jobs?.publish?.steps?.find(step => step.name === "Require reconciled publication history")?.run;
    const dryGate = release.jobs?.["verify-npm"]?.steps?.find(step => step.name === "Require reconciled publication history")?.run;
    expect(gate).toBeDefined();
    expect(dryGate).toBe(gate);
    const root = mkdtempSync(join(tmpdir(), "ocx-release-history-"));
    try {
      const mock = 'node() { printf "%s\\n" "$*"; return "$HISTORY_STATUS"; }\n';
      const sha = "a".repeat(40);
      const execute = (tag: string, status = "0", source = sha, version = "2.100.0") => Bun.spawnSync(["bash", "-e", "-c", mock + gate!], {
        cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HISTORY_STATUS: status, NPM_DIST_TAG: tag,
          SOURCE_SHA: source, RELEASE_VERSION: version, GH_TOKEN: "fixture-token" },
        stdout: "pipe", stderr: "pipe",
      });
      const stable = execute("latest");
      expect(stable.exitCode).toBe(0);
      expect(stable.stdout.toString()).toContain(`release-history.cjs check ${sha} 2.100.0 stable`);
      const preview = execute("preview", "0", sha, "2.100.0-preview.20261108.1");
      expect(preview.exitCode).toBe(0);
      expect(preview.stdout.toString()).toContain(`release-history.cjs check ${sha} 2.100.0-preview.20261108.1 preview`);
      expect(execute("latest", "7").exitCode).not.toBe(0);
      expect(execute("unknown").exitCode).not.toBe(0);
      expect(execute("latest", "0", "short").exitCode).not.toBe(0);
      const steps = release.jobs?.publish?.steps ?? [];
      const history = steps.findIndex(step => step.name === "Require reconciled publication history");
      const publish = steps.findIndex(step => step.name === "Publish verified npm tarball");
      expect(history).toBeGreaterThanOrEqual(0);
      expect(history).toBeLessThan(publish);
      expect(steps.slice(history + 1, publish).every(step => step.if?.includes("inputs.resume-after-npm-publish == true"))).toBe(true);
    } finally { removeTreeWithRetry(root); }
  });

  test("every multi-line script on a Windows runner declares an explicit shell", () => {
    for (const jobId of ["package-standalone", "package-desktop"]) {
      const job = release.jobs?.[jobId];
      expect(job, jobId).toBeDefined();
      const runsOnWindows = job!.strategy?.matrix?.include?.some(entry => entry.os === "windows-latest");
      expect(runsOnWindows, `${jobId} exercises Windows`).toBe(true);
      for (const step of job!.steps ?? []) {
        // A single command line is shell-neutral; a script block implies shell-specific
        // syntax and must not fall back to the runner's default shell on Windows.
        if (typeof step.run !== "string" || !step.run.includes("\n")) continue;
        // Steps fenced away from Windows never meet PowerShell.
        if (/runner\.os\s*==\s*'(Linux|macOS)'/.test(step.if ?? "")) continue;
        expect(step.shell, `${jobId} / ${step.name}`).toBeDefined();
      }
    }
  });

  test("the release asset rename runs under bash", () => {
    const step = release.jobs?.["package-desktop"]?.steps
      ?.find(candidate => candidate.run?.includes("collect-release-assets.ts"));
    expect(step).toBeDefined();
    // The script uses backslash continuations and "$VAR" expansion, which PowerShell does
    // not read the way bash does; on the Windows matrix this step is only correct under bash.
    expect(step!.shell).toBe("bash");
  });

  test("standalone checksums record bare names that resolve where the verifier runs", () => {
    const archive = release.jobs?.["package-standalone"]?.steps
      ?.find(candidate => candidate.run?.includes("sha256sum"));
    expect(archive).toBeDefined();
    const checksumLines = archive!.run!.split("\n")
      .filter(line => line.includes("sha256sum") && !line.trim().startsWith("#"));
    expect(checksumLines.length).toBeGreaterThanOrEqual(2);
    for (const line of checksumLines) {
      const argument = /sha256sum\s+"([^"]+)"/.exec(line)?.[1];
      expect(argument, line).toBeDefined();
      // shasum -c resolves the recorded path relative to the verifier's working directory,
      // which is dist/release; any directory prefix names a file that cannot exist there.
      expect(argument!).not.toContain("/");
      // The redirect target gets the same treatment: a bare output name is what makes the
      // checksum file land in the directory the upload glob scans.
      const output = />\s+"([^"]+)"/.exec(line)?.[1];
      expect(output, line).toBeDefined();
      expect(output!).not.toContain("/");
      // verifyChecksums binds each record to its own payload by removing only
      // the final .sha256 suffix, including the archive extension in the name.
      expect(output, line).toBe(`${argument}.sha256`);
    }

    // The bare names above only resolve end to end if the step checksums from the directory
    // the artifact lives in (it leaves the per-target build directory first), if the upload
    // glob picks the checksum file up, and if the pre-publication verifier downloads every
    // artifact flattened beside them. Locking only the final line would leave those joints
    // unguarded. YAML block scalars are dedented on parse, so the script's own lines carry
    // no indentation here.
    expect(archive!.run).toMatch(/^ *cd \.\.\/\.\.$/m);
    const upload = release.jobs?.["package-standalone"]?.steps
      ?.find(candidate => candidate.uses?.startsWith("actions/upload-artifact@")
        && String(candidate.with?.name).startsWith("standalone-"));
    expect(String(upload?.with?.path)).toContain("dist/ocx-*.sha256");

    const download = release.jobs?.["verify-release"]?.steps
      ?.find(candidate => candidate.uses?.startsWith("actions/download-artifact@")
        && candidate.with?.pattern === "standalone-*");
    expect(download?.with?.["merge-multiple"]).toBe(true);
    expect(download?.with?.path).toBe("dist/release");
  });

  test("publication consumes the verified packaging result", () => {
    const verify = release.jobs?.["verify-release"];
    expect(verify).toBeDefined();
    expect(needsOf(verify).sort())
      .toEqual(["package-desktop", "package-standalone", "validate-dispatch"]);
    // Verification is not a publication-mode step: a dry run must prove the same chain
    // a real release relies on, so the job carries no dry-run exemption.
    expect(verify!.if).toBeUndefined();
    expect(verify!.steps?.some(candidate => candidate.run?.includes("verify-release-assets.ts")))
      .toBe(true);

    const publish = release.jobs?.publish;
    expect(publish).toBeDefined();
    expect(needsOf(publish).sort()).toEqual(["validate-dispatch", "verify-npm", "verify-release"]);

    const attach = release.jobs?.["attach-release"];
    expect(attach).toBeDefined();
    expect(needsOf(attach).sort()).toEqual(["publish", "validate-dispatch", "verify-release"]);
  });

  test("attach uploads only the verified bundle, and only after requiring its receipt", () => {
    const steps = release.jobs?.["attach-release"]?.steps ?? [];
    // Verification happens exactly once, before publication: attach must not re-verify
    // checksums or regenerate the manifest from unverified parts.
    expect(steps.some(candidate => candidate.run?.includes("shasum"))).toBe(false);
    expect(steps.some(candidate => candidate.run?.includes("updater-manifest.ts"))).toBe(false);

    const bundle = steps.find(candidate => candidate.uses?.startsWith("actions/download-artifact@")
      && candidate.with?.name === "verified-release");
    expect(bundle?.with?.path).toBe("dist/release");

    const receiptCheck = steps.findIndex(candidate => candidate.run?.includes("verification/receipt.json"));
    const upload = steps.findIndex(candidate => candidate.run?.includes("gh release upload"));
    expect(receiptCheck).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(receiptCheck);
  });

  test("the release is a draft until the verified assets are attached", () => {
    // GitHub freezes a release the moment it is published: every later asset upload
    // comes back HTTP 422 "Cannot upload assets to an immutable release". Creating
    // the release published and uploading afterwards is what left v2.55.0 through
    // v2.60.0 with zero assets and the desktop updater with nothing to fetch.
    const releaseText = readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8");
    const createStep = releaseText.split("- name: Create GitHub release")[1] ?? "";
    expect(createStep).toMatch(/gh release create "\$release_tag" --draft/);

    const attachRun = (release.jobs?.["attach-release"]?.steps ?? [])
      .map(candidate => candidate.run ?? "")
      .find(run => run.includes("gh release upload")) ?? "";
    expect(attachRun).toContain("--draft=false");
    expect(attachRun.indexOf("gh release upload")).toBeLessThan(attachRun.indexOf("--draft=false"));
  });

  describe("draft publication shell behavior", () => {
    const bash = releaseTestBash();
    const shellTest = test.skipIf(bash === null);

    test("CI and POSIX hosts must execute the Bash regressions", () => {
      // A Windows workstation need not install Bash just to run static contracts.
      // CI must never turn a missing/broken shell into a green skipped regression.
      if (process.env.CI || process.platform !== "win32") expect(bash).not.toBeNull();
    });

    test("Git Bash receives native Windows PATH entries separated by semicolons", () => {
      const nodeDir = "C:\\Program Files\\nodejs";
      const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
      // Literal expectations: rebuilding them with win32.dirname/win32.join would mirror the
      // implementation and pass even if those operations produced the wrong entries (#8336).
      expect(releaseShellPath(nodeDir, gitBash, true).split(";")).toEqual([
        "C:\\Program Files\\nodejs",
        "C:\\Program Files\\Git\\bin",
        "C:\\Program Files\\Git\\usr\\bin",
      ]);
    });

    shellTest("Bash can run Node on a temporary checker file", () => {
      const cwd = mkdtempSync(join(tmpdir(), "ocx-bash-checker-"));
      try {
        const result = Bun.spawnSync([bash!, "--noprofile", "--norc", "-e", "-c",
          `cat > "$RUNNER_TEMP/check.cjs" <<'NODE'\nprocess.stdout.write('checker-ran');\nNODE\nnode "$RUNNER_TEMP/check.cjs"`], {
          cwd, env: releaseTestEnv({ PATH: releaseShellPath(dirname(Bun.which("node")!), bash!, process.platform === "win32"), RUNNER_TEMP: "." }),
          timeout: 3_000, maxBuffer: 16_384,
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toBe("checker-ran");
      } finally { removeTreeWithRetry(cwd); }
    });

    /**
     * Run the actual YAML block with an allowlisted gh mock. Actions runs a step as
     * `bash ... {0}` on a script file, so this does too. Passed as a `-c` argument, the
     * block crossed the Windows command line into Git Bash with the checker's `\\` folded to
     * one backslash; its name regex then rejected every asset as an invalid receipt.
     */
    function attach(env: Record<string, string> = {}) {
      const run = release.jobs?.["attach-release"]?.steps
        ?.find(step => step.run?.includes("gh release upload"))?.run;
      expect(run).toBeDefined();
      const cwd = mkdtempSync(join(tmpdir(), "ocx-release-contract-"));
      try {
        mkdirSync(join(cwd, "verification")); mkdirSync(join(cwd, "dist/release"), { recursive: true });
        writeFileSync(join(cwd, "dist/release/app.zip"), "archive");
        const digest = createHash("sha256").update("archive").digest("hex");
        writeFileSync(join(cwd, "verification/receipt.json"), JSON.stringify({ assets: { "app.zip": digest } }));
        writeFileSync(join(cwd, "attach-step.sh"), `
          gh() {
            printf 'gh:%s\\n' "$*" >&2
            case "$1:$2" in
              release:upload) return "$UPLOAD_STATUS" ;;
              release:view)
                if [ "$5" = 'isDraft,assets' ]; then
                  if [ -f "$RUNNER_TEMP/initial-viewed" ]; then printf '%s\\n' "$FINAL_INFO"; else
                    : > "$RUNNER_TEMP/initial-viewed"; printf '%s\\n' "$RELEASE_INFO"; return "$INITIAL_STATUS"
                  fi
                  return 0
                fi
                printf '%s\\n' "$DRAFT_STATE"; return "$VIEW_STATUS" ;;
              release:edit) return "$EDIT_STATUS" ;;
              *) return 97 ;;
            esac
          }
          ${run}
          printf 'attach-completed\\n'
        `);
        const result = Bun.spawnSync([bash!, "--noprofile", "--norc", "-e", "-o", "pipefail", "attach-step.sh"], {
          cwd, env: releaseTestEnv({ PATH: releaseShellPath(dirname(Bun.which("node")!), bash!, process.platform === "win32"), RUNNER_TEMP: ".", RELEASE_VERSION: "2.65.0", DRAFT_STATE: "true",
          RELEASE_INFO: '{"isDraft":true,"assets":[]}', INITIAL_STATUS: "0",
          FINAL_INFO: JSON.stringify({ isDraft: true, assets: [{ name: "app.zip", state: "uploaded", digest: `sha256:${digest}` }] }),
          UPLOAD_STATUS: "0", VIEW_STATUS: "0", EDIT_STATUS: "0", ...env }),
          timeout: 3_000, maxBuffer: 16_384 });
        const calls = result.stderr.toString().split(/\r?\n/).filter(line => line.startsWith("gh:"));
        return { code: result.exitCode, calls, completed: result.stdout.toString().includes("attach-completed"), stderr: result.stderr.toString() };
      } finally {
        removeTreeWithRetry(cwd);
      }
    }

    const initial = "gh:release view v2.65.0 --json isDraft,assets";
    const upload = "gh:release upload v2.65.0 dist/release/app.zip";
    const view = "gh:release view v2.65.0 --json isDraft --jq .isDraft";
    const edit = "gh:release edit v2.65.0 --draft=false";

    function expectAttach(env: Record<string, string>, expected: { code: number; calls: string[]; completed: boolean }) {
      const { stderr, ...actual } = attach(env);
      expect(actual, stderr).toEqual(expected);
      return stderr;
    }

    shellTest("lookup failure propagates even when stdout says true", () => {
      expectAttach({ VIEW_STATUS: "41" }, { code: 41, calls: [initial, upload, initial, view], completed: false });
    });
    for (const value of ["", "null", "TRUE", " true", "{}", "true\nfalse"]) {
      shellTest(`unexpected draft state ${JSON.stringify(value)} never publishes`, () => {
        expectAttach({ DRAFT_STATE: value }, { code: 1, calls: [initial, upload, initial, view], completed: false });
      });
    }
    shellTest("a draft is published exactly once, after upload and lookup", () => {
      expectAttach({}, { code: 0, calls: [initial, upload, initial, view, edit], completed: true });
    });
    shellTest("an explicitly public release is not edited again", () => {
      expectAttach({ DRAFT_STATE: "false" }, { code: 0, calls: [initial, upload, initial, view], completed: true });
    });
    shellTest("upload failure prevents lookup and publication", () => {
      expectAttach({ UPLOAD_STATUS: "42" }, { code: 42, calls: [initial, upload], completed: false });
    });
    shellTest("publication failure remains a failed step", () => {
      expectAttach({ EDIT_STATUS: "43" }, { code: 43, calls: [initial, upload, initial, view, edit], completed: false });
    });
    shellTest("existing release assets fail before any upload", () => {
      expect(expectAttach({ RELEASE_INFO: '{"isDraft":true,"assets":[{"name":"old"}]}' },
        { code: 1, calls: [initial], completed: false })).toContain("existing asset is unexpected");
    });
    shellTest("an already published release fails before any upload", () => {
      expect(expectAttach({ RELEASE_INFO: '{"isDraft":false,"assets":[]}' },
        { code: 1, calls: [initial], completed: false })).toContain("release is missing verified assets");
    });
  });

  test("unverified resume is refused and acknowledged publications are never retried", () => {
    const dispatch = release.jobs?.["validate-dispatch"]?.steps?.find(step => step.name === "Resolve eligible source");
    expect(dispatch?.run).toContain("Resume requires the original source SHA and version");
    const steps = release.jobs?.publish?.steps ?? [];
    const publication = steps.find(step => step.id === "publication");
    expect(publication?.run).toContain('npm publish "$NPM_TARBALL" --ignore-scripts');
    expect(publication?.run).toContain('echo "published=true" >> "$GITHUB_OUTPUT"');
    expect(publication?.run).toContain("do not republish this version");
    expect(publication?.run).toContain("VERIFIED_RESUME_DECISION");
    expect(steps.find(step => step.name === "Require reconciled publication history")?.run).toContain("release-history.cjs check");
  });

});

describe("service lifecycle trigger coverage", () => {
  const lifecycleText = readFileSync(repoPath(".github", "workflows", "service-lifecycle.yml"), "utf8");

  test("the PR trigger covers the service directory and desktop shell without a push trigger", () => {
    const prPaths = triggerPaths(lifecycleText, "pull_request", "workflow_dispatch");
    expect(prPaths).toContain("src/service.ts");
    expect(prPaths).toContain("src/service/**");
    expect(prPaths).toContain("desktop/**");
    const parsed = Bun.YAML.parse(lifecycleText) as { on: Record<string, unknown> };
    expect(parsed.on.push).toBeUndefined();
  });

  test("the release service gate matches every implemented service module and desktop file", () => {
    const { serviceChangeRequired } = require(repoPath(".github", "scripts", "release-evidence.cjs")) as { serviceChangeRequired: (paths: string[]) => boolean };

    // Derived from the tree, not restated: the service implementation is a directory, so
    // every module in it must satisfy the gate that demands lifecycle evidence.
    const serviceModules = readdirSync(repoPath("src", "service"))
      .filter(entry => entry.endsWith(".ts"));
    expect(serviceModules.length).toBeGreaterThanOrEqual(10);
    for (const module of serviceModules) {
      expect(serviceChangeRequired([`src/service/${module}`]), `src/service/${module}`).toBe(true);
    }
    expect(serviceChangeRequired(["src/service.ts"])).toBe(true);

    const desktopSurfaces = [
      ...readdirSync(repoPath("desktop", "scripts")).map(entry => `desktop/scripts/${entry}`),
      ...readdirSync(repoPath("desktop", "src-tauri", "src")).map(entry => `desktop/src-tauri/src/${entry}`),
    ];
    expect(desktopSurfaces.length).toBeGreaterThanOrEqual(10);
    for (const path of desktopSurfaces) {
      expect(serviceChangeRequired([path]), path).toBe(true);
    }

    expect(serviceChangeRequired(["src/router.ts"])).toBe(false);
    expect(serviceChangeRequired(["docs-site/src/pages/index.astro"])).toBe(false);
  });
});
