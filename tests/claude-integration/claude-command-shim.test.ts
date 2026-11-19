import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findNativePosixClaude, supportsClaudeShim } from "../../src/claude/native-executable";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

test.skipIf(!supportsClaudeShim())("bare Claude uses the connected route without inherited auth, with native maintenance and reversible PATH activation", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-claude-shim-"));
  const bin = join(home, "bin");
  const ocxHome = join(home, "ocx");
  const shim = join(ocxHome, "claude-shim");
  const key = "ocx_data_" + "z".repeat(40);
  const messages: { authorization: string | null; body: unknown }[] = [];
  const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/v1/messages") {
      messages.push({ authorization: request.headers.get("authorization"), body: await request.json() });
      return Response.json({ ok: true });
    }
    if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [] });
    return new Response(null, { status: 404 });
  } });
  try {
    mkdirSync(bin);
    mkdirSync(ocxHome, { mode: 0o700 });
    const cwd = realpathSync(home);
    const env = { HOME: home, USER: "fixture", XDG_CONFIG_HOME: join(home, "xdg"), CLAUDE_CONFIG_DIR: join(home, "claude-config"), OPENCODEX_HOME: ocxHome, PATH: `${bin}${delimiter}/usr/bin:/bin`, OCX_TEST_HOME_GUARD: "1" };
    const cli = repoPath("src", "cli", "index.ts");
    writeFileSync(join(bin, "ocx"), `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(cli)} "$@"\n`, { mode: 0o700 });
    const probe = join(home, "probe.ts");
    writeFileSync(probe, `
      const args = process.argv.slice(2);
      if (args[0] === '--version') { console.log('2.1.300'); process.exit(0); }
      if (args[0] === '-p') {
        const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
          method: 'POST', headers: { authorization: 'Bearer ' + process.env.ANTHROPIC_AUTH_TOKEN },
          body: JSON.stringify({ input: await Bun.stdin.text() }),
        });
        if (!response.ok) process.exit(2);
      }
      console.log(JSON.stringify({ args, cwd: process.cwd() }));
      process.exit(23);
    `);
    const native = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(probe)} "$@"\n`;
    writeFileSync(join(bin, "claude"), native, { mode: 0o700 });
    const baseUrl = mock.url.origin;
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
      runtimeRole: "client", claudeCode: { enabled: true, authMode: "proxy", injectAgents: false },
      client: { serverUrl: baseUrl, managementUrl: baseUrl, managementTransport: "direct", selectedClients: ["claude"],
        apiKeyId: "fixture", connectedAt: "2026-11-19T00:00:00Z", tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
        tokenFingerprint: createHash("sha256").update(key).digest("hex"), protocolVersion: 1, priorCatalog: "" },
    }));
    writeFileSync(join(ocxHome, "service-api-token"), `${key}\n`, { mode: 0o600 });
    async function run(args: string[], path = env.PATH, input = "") {
      const child = Bun.spawn(args, { cwd, env: { ...env, PATH: path }, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (stderr.includes(key) || stdout.includes(key)) throw new Error("Fixture token leaked to CLI output");
      return { status, stdout, stderr };
    }
    const install = await run(["ocx", "claude-shim", "install"]);
    expect(install.status, install.stderr).toBe(0);
    expect((await run(["ocx", "claude-shim", "status"])).stdout).toContain("inactive on PATH");
    const activated = await run(["/bin/sh", "-c", `. ${quote(join(shim, "activate.sh"))}; . ${quote(join(shim, "activate.sh"))}; printf '%s' "$PATH"`]);
    const active = `${shim}:${env.PATH}`;
    expect(activated.stdout).toBe(active);
    expect((await run(["ocx", "claude-shim", "install"], active)).status).toBe(0);
    expect((await run(["ocx", "claude-shim", "status"], active)).stdout).toContain("installed, active");
    const alias = join(home, "alias");
    mkdirSync(alias);
    symlinkSync(join(shim, "claude"), join(alias, "claude"));
    expect(findNativePosixClaude(`${alias}:${active}`, home)).toBe(join(bin, "claude"));
    expect((await run(["claude", "--help"], active)).stdout).toContain('"args":["--help"]');
    const routed = await run(["claude", "-p", "--", "", "two words", "å\nnext"], active, "from stdin");
    expect(routed.status, routed.stderr).toBe(23);
    expect(JSON.parse(routed.stdout)).toEqual({ args: ["-p", "--", "", "two words", "å\nnext"], cwd });
    expect(messages).toEqual([{ authorization: `Bearer ${key}`, body: { input: "from stdin" } }]);
    const wrapper = join(shim, "claude");
    const original = readFileSync(wrapper, "utf8");
    writeFileSync(wrapper, original + "# unexpected edit\n");
    expect((await run(["ocx", "claude-shim", "uninstall"], active)).status).toBe(1);
    expect(readFileSync(wrapper, "utf8")).toContain("unexpected edit");
    writeFileSync(wrapper, original);
    expect((await run(["ocx", "claude-shim", "uninstall"], active)).status).toBe(0);
    expect(existsSync(shim)).toBe(false);
    expect(readFileSync(join(bin, "claude"), "utf8")).toBe(native);
  } finally {
    mock.stop(true);
    removeTreeWithRetry(home);
  }
}, 35_000);
