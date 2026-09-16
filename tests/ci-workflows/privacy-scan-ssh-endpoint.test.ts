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
