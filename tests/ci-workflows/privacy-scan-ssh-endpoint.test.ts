import { describe, expect, test } from "bun:test";
import { scanText } from "../../scripts/privacy-scan";

/**
 * #4623 removed a working SSH `Host` block from a published devlog by hand.
 * `privacy:scan` passed on that file, because it knew about tokens, emails and
 * home paths but nothing about infrastructure endpoints. These pin the detector
 * that closes it — and, just as importantly, the shapes it must NOT fire on,
 * since two rounds of false positives on ordinary prose and code are what
 * narrowed it to `HostName`/`ProxyCommand`.
 */
describe("privacy-scan — ssh-endpoint", () => {
  const kinds = (text: string) => scanText("devlog/x.md", text).map(f => f.kind);

  test("catches a Host block of the shape that shipped", () => {
    // Shaped like the block #4623 is removing, with a synthetic endpoint. Using
    // the real one would reintroduce it here permanently and undo that cleanup;
    // the regex cannot tell the difference, so there is nothing to be gained.
    const block = [
      "Host runner-cf",
      "    HostName ssh-runner.internal-buildfarm.net",
      "    ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h",
    ].join("\n");
    const k = kinds(block);
    expect(k).toContain("ssh-endpoint");        // redacted in the report; file:line locates it
    expect(k).toContain("ssh-proxy-command");   // redacted too, see REDACTED_FINDING_KINDS
  });

  test("a templated or reserved host is documentation, not infrastructure", () => {
    for (const line of [
      "    HostName example.com",
      "    HostName <your-runner>",
      "    HostName $RUNNER_HOST",
      "    HostName localhost",
      "    ProxyCommand %h",
    ]) {
      expect(kinds(line)).not.toContain("ssh-endpoint");
      expect(kinds(line)).not.toContain("ssh-proxy-command");
    }
  });

  test("does not fire on prose or code that merely starts with a directive word", () => {
    for (const line of [
      "User aliases are display metadata only. Codex pool aliases live on `CodexAccount`",
      "user configuration.",
      "user notice.",
      "          hostname === undefined ? { grokHome } : { grokHome, hostname },",
      "The hostname is resolved by the adapter.",
    ]) {
      expect(kinds(line)).not.toContain("ssh-endpoint");
    }
  });

  test("a ProxyCommand that merely contains %h is still the real command", () => {
    // The substitution token does not make the binary path, the access method or
    // the tunnel any less of a leak.
    expect(kinds("    ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h"))
      .toContain("ssh-proxy-command");
  });
});

/**
 * The allowance is evaluated per token, not over the whole value.
 *
 * A `ProxyCommand` value is a command line, so asking whether it *contains* something
 * allowlisted answers the wrong question: one reserved name or one leading `$` cleared
 * the whole line, real endpoint and all. Each case below was allowed by the previous
 * whole-string test and names a host the scan exists to catch.
 */
describe("privacy-scan — ssh endpoint tokens", () => {
  const kinds = (text: string) => scanText("devlog/x.md", text).map(f => f.kind);

  test("one reserved name inside a ProxyCommand does not clear the rest of it", () => {
    // The proxy hop is documentation. The endpoint three tokens later is not.
    expect(kinds("    ProxyCommand nc -X connect -x proxy.example.com:8080 ssh-runner.internal-buildfarm.net 22"))
      .toContain("ssh-proxy-command");
  });

  test("a leading substitution does not clear the rest of a ProxyCommand", () => {
    expect(kinds("    ProxyCommand $CF access ssh --hostname ssh-runner.internal-buildfarm.net"))
      .toContain("ssh-proxy-command");
    expect(kinds("    ProxyCommand %h ssh-runner.internal-buildfarm.net"))
      .toContain("ssh-proxy-command");
  });

  test("a real host that merely begins with a reserved name is still a real host", () => {
    expect(kinds("    HostName example.com.internal-buildfarm.net")).toContain("ssh-endpoint");
    // Userinfo and port are stripped before the host is judged, so neither can be
    // the reason a real host reads as a placeholder. Written without a dotted
    // domain after the "@" so this line is not itself an email finding.
    expect(kinds("    HostName root@ssh-runner:2222")).toContain("ssh-endpoint");
  });

  test("a wholly templated ProxyCommand is still documentation", () => {
    for (const line of [
      "    ProxyCommand %r@%h:%p",
      "    ProxyCommand <your-proxy>",
      "    ProxyCommand ${PROXY}",
    ]) {
      expect(kinds(line)).not.toContain("ssh-proxy-command");
    }
  });

  test("ssh_config comment and equals forms do not hide a directive", () => {
    expect(kinds("    HostName ssh-runner.internal-buildfarm.net # build box")).toContain("ssh-endpoint");
    expect(kinds("    ProxyCommand=cloudflared access ssh --hostname ssh-runner.internal-buildfarm.net"))
      .toContain("ssh-proxy-command");
    // A reserved host stays documentation with a comment attached.
    expect(kinds("    HostName example.com # sample")).not.toContain("ssh-endpoint");
  });

  test("the HostName equals form stays unmatched, because that shape is code", () => {
    // `src/server/ports.ts` and `src/server/port-reclaim.ts` carry exactly this line.
    // Accepting `Keyword=value` for `HostName` would fail the scan on the tree itself.
    expect(kinds("  hostname = \"127.0.0.1\",")).not.toContain("ssh-endpoint");
  });
});
