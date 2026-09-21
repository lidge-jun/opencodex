import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * The two CLI surfaces the shell drives, read against the CLI that defines them.
 *
 * D5 and D4: the shell stops resolving the home, the port and liveness itself, and stops performing
 * the teardown itself. `src/cli/resolve.ts` and `src/cli/stop-report.ts` own those answers; the Rust
 * side is a reader. Both halves are asserted here together so a schema, a status value or an
 * outcome name cannot change on one side and be discovered on a user's machine.
 *
 * The rule that matters most is the one a reader can get wrong quietly: liveness has three answers,
 * and only a proven absence authorises starting a runtime. Everything that can go wrong on the
 * shell side has to fold into the third one, because the reading that must never happen is "the
 * resolve failed, so nobody must be listening".
 */
const SHELL = "desktop/src-tauri/src";
const RESOLVE_RS = repoPath(`${SHELL}/resolve.rs`);
const STOP_RS = repoPath(`${SHELL}/runtime_stop.rs`);
const STARTUP = repoPath(`${SHELL}/startup.rs`);
const RESOLVE_TS = repoPath("src/cli/resolve.ts");
const STOP_TS = repoPath("src/cli/stop-report.ts");

function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("desktop CLI contracts", () => {
  const resolveRs = code(RESOLVE_RS);
  const stopRs = code(STOP_RS);
  const resolveTs = code(RESOLVE_TS);
  const stopTs = code(STOP_TS);

  test("both sides name the same wire versions", () => {
    expect(resolveTs).toContain('RESOLVE_SCHEMA = "ocx-resolve/1"');
    expect(resolveRs).toContain('pub const SCHEMA: &str = "ocx-resolve/1"');
    expect(stopTs).toContain('STOP_SUMMARY_SCHEMA = "ocx-stop/1"');
    expect(stopRs).toContain('pub const SCHEMA: &str = "ocx-stop/1"');
    // A document announcing anything else is not understood rather than half-read.
    expect(resolveRs).toContain("resolved.schema != SCHEMA");
    expect(stopRs).toContain("summary.schema != SCHEMA");
  });

  test("liveness keeps its three answers, and only one of them authorises a start", () => {
    // Two reach the wire; the third exits 1 before the document is built.
    expect(resolveTs).toContain('status: "live" | "absent-proven"');
    expect(resolveRs).toContain('#[serde(rename_all = "kebab-case")]');
    expect(resolveRs).toContain("    Live,");
    expect(resolveRs).toContain("    AbsentProven,");
    const rule = resolveRs.slice(resolveRs.indexOf("pub fn may_start("));
    const body = rule.slice(0, rule.indexOf("\n}"));
    expect(body).toContain("Some(Status::AbsentProven)");
    expect(body).not.toContain("Status::Live");
  });

  test("a live listener this app cannot manage is neither attached to nor started beside", () => {
    // Core's liveness predicate accepts a connected client's listener on purpose, so
    // duplicate-start avoidance can see it; a caller that needs the management plane has to
    // discriminate on the role rather than narrow that predicate.
    expect(resolveTs).toContain("role?: string");
    const verdict = resolveRs.slice(resolveRs.indexOf("pub fn live_verdict("));
    const body = verdict.slice(0, verdict.indexOf("\n}"));
    expect(body).toContain('role.as_deref() == Some("client")');
    expect(body).toContain("LiveVerdict::Unusable");
    // And an address this shell cannot reach on loopback is the same kind of answer.
    expect(body).toContain("loopback_reachable(resolved.liveness.hostname.as_deref())");
    const startup = code(STARTUP);
    const unusable = startup.indexOf("resolve::LiveVerdict::Unusable(reason) =>");
    const spawn = startup.indexOf("spawn_runtime(app, endpoint, &watch)");
    expect(unusable).toBeGreaterThan(-1);
    expect(startup.slice(unusable, spawn)).toContain("return;");
  });

  test("everything that can go wrong on this side folds into unknown", () => {
    const reader = resolveRs.slice(resolveRs.indexOf("pub fn read("), resolveRs.indexOf("pub async fn run("));
    // A non-zero exit is the CLI's own refusal, including the exit 1 it uses for unknown liveness.
    expect(reader).toContain("if exit_code != Some(0) {");
    expect(reader).toContain("Resolution::Unknown");
    const runner = resolveRs.slice(resolveRs.indexOf("pub async fn run("));
    const body = runner.slice(0, runner.indexOf("\n}"));
    // A missing binary, a failed spawn and a deadline all answer the same way.
    expect(body.match(/Resolution::Unknown/g) || []).toHaveLength(3);
    expect(body).toContain("timeout_at(deadline, command.output())");
  });

  test("the startup sequence refuses to start on anything but a proven absence", () => {
    const startup = code(STARTUP);
    const run = startup.slice(startup.indexOf("async fn run(app: &AppHandle)"));
    const unknown = run.indexOf("let Some(answer) = resolution.resolved() else {");
    const attach = run.indexOf("match resolve::live_verdict(&resolution) {");
    const guard = run.indexOf("if !resolve::may_start(&resolution) {");
    const spawn = run.indexOf("spawn_runtime(app, endpoint, &watch)");
    expect(unknown).toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(unknown);
    expect(guard).toBeGreaterThan(attach);
    expect(spawn).toBeGreaterThan(guard);
    // The unresolved branch fails the state; it does not fall through to a start.
    expect(run.slice(unknown, attach)).toContain("Phase::Resolving,");
    expect(run.slice(unknown, attach)).toContain("return;");
  });

  test("a stop is a success only when the CLI said so twice", () => {
    // The process status and the document have to agree, and the document has to say the runtime
    // is down: taking the summary's word for its own exit status is taking a claim as its own
    // evidence.
    expect(stopTs).toContain("ok: signals.exitCode === 0");
    expect(stopTs).toContain("runtimeDown: record.proxy ===");
    const reader = stopRs.slice(stopRs.indexOf("pub fn read("), stopRs.indexOf("pub async fn run("));
    expect(reader).toContain("if exit_code != Some(0)");
    expect(reader).toContain("|| !summary.ok");
    expect(reader).toContain("|| summary.exit_code != 0");
    expect(reader).toContain("|| !summary.runtime_down");
    // And the document has to agree with itself rather than be trusted to.
    expect(reader).toContain("|| !agrees");
    expect(reader).toContain("(Outcome::Stopped, Proxy::Stopped)");
    expect(reader).toContain("(Outcome::NotRunning, Proxy::NotRunning)");
    expect(reader).toContain("StopResult::Failed");
    const stopped = reader.indexOf("StopResult::Stopped(summary)");
    expect(stopped).toBeGreaterThan(reader.indexOf("if exit_code != Some(0)"));
  });

  test("the outcomes the shell can be handed are the outcomes the CLI can emit", () => {
    expect(stopTs).toContain(
      'outcome: "stopped" | "not-running" | "history-incomplete" | "history-deferred" | "failed"',
    );
    // The shell does not re-derive the outcome; it carries the CLI's own words into its diagnostic.
    expect(stopRs).toContain("summary.outcome");
    expect(stopRs).toContain("summary.exit_code");
    expect(stopRs).toContain("summary.message");
    expect(stopRs).not.toContain('== "stopped"');
  });
});
