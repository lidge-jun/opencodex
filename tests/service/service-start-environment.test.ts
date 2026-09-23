import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * `service stop` already refused to act when the shell it runs in resolves a
 * different `CODEX_SQLITE_HOME` / `CODEX_HOME` than the one recorded at install.
 * `service start` did not, so a shell whose environment had moved would start the
 * service against the recorded database while resolving another itself, and native
 * Codex history would split across two files with neither side reporting anything
 * wrong.
 *
 * This is a source oracle rather than an invocation because the branch it guards
 * dispatches into real launchd, systemd, or schtasks, and because the property is
 * an ordering: the guard has to run BEFORE `ops.start()`, not merely somewhere in
 * the same case. A test that only asserted both appear would pass on the arrangement
 * that leaves the database split.
 *
 * It lives beside `service.test.ts` rather than in it because that file is at its
 * committed size cap in `tests/fixtures/file-size-baseline.json`, and the caps only
 * move down.
 */
test("service start refuses a changed install environment before it starts the launcher", () => {
  const source = readFileSync(repoPath("src", "service", "cli.ts"), "utf8");

  // The guard is imported, so it cannot be satisfied by a local stub of the same name.
  expect(source).toContain('import { assertServiceEnvironmentMatchesInstall');

  const body = source.slice(source.indexOf("export async function serviceCommand"));
  expect(body).toContain('case "start":');
  const startCase = body.slice(body.indexOf('case "start":'), body.indexOf('case "stop"'));
  const guardAt = startCase.indexOf("assertServiceEnvironmentMatchesInstall();");
  const launchAt = startCase.indexOf("ops.start();");
  expect(guardAt).toBeGreaterThan(-1);
  expect(launchAt).toBeGreaterThan(guardAt);
  // The runtime-ownership refusal now sits between them. It can only PREVENT the start, so
  // the invariant is unchanged: nothing reaches the service manager before the guard has run.
  expect(startCase.slice(guardAt, launchAt)).not.toContain("ops.");
});
