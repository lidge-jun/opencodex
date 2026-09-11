/**
 * The remote hub guide has to stay runnable end to end on a FRESH standalone config.
 *
 * It did not (#4200). The setup block told the reader to run a nested `ocx config set hub.<field>`
 * immediately after `ocx config set runtimeRole hub`, but `runtimeRole` does not create the object
 * and the CLI refuses to create a missing parent, so the guide's own next line died with
 * `config parent path not found: hub`. A guide that cannot be followed verbatim is worse than a
 * missing one: the reader assumes they broke something.
 *
 * The second half is the data plane. The management ingress deliberately serves no `/v1/*`,
 * `/healthz` or `/readyz`, so publishing only that ingress through Tailscale Serve leaves a hub
 * that pairs and then cannot answer a request. The trap is quiet, because a loopback-bound data
 * listener still returns 200 from `/readyz` while answering 403 on `/v1/catalog`.
 *
 * These assertions are cheap and the guide is edited often, which is the whole reason the first
 * defect survived to a public URL.
 */
import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

const GUIDE = repoPath("docs-site/src/content/docs/guides/remote-hub.md");

describe("remote hub guide", () => {
  test("no nested config set runs before its parent object exists", async () => {
    const source = await Bun.file(GUIDE).text();

    // The ordering IS the fix. Asserting only that the initializer appears somewhere would pass on
    // a guide that still sets the field first and mentions `{}` afterwards.
    for (const parent of ["hub", "remoteGui"] as const) {
      const initializer = source.indexOf(`ocx config set ${parent} '{}'`);
      const nested = source.indexOf(`ocx config set ${parent}.`);
      expect(initializer, `the guide no longer initializes an empty ${parent} object`).toBeGreaterThanOrEqual(0);
      expect(nested, `the guide no longer sets any ${parent} field`).toBeGreaterThanOrEqual(0);
      expect(
        initializer,
        `the guide sets a ${parent}.<field> before creating ${parent}, which fails on a fresh config`,
      ).toBeLessThan(nested);
    }

    // Name the error, so a reader who hit it recognizes their own terminal output.
    expect(source).toContain("config parent path not found: hub");
  });

  test("the whole-object form carries its replace-not-merge warning", async () => {
    // `setPath` assigns the leaf. Recommending the one-call form without this warning would tell
    // an operator adapting an existing config to silently drop their management ingress.
    const source = await Bun.file(GUIDE).text();
    expect(source).toContain("replaces** the object");
  });

  test("the guide says opencodex terminates no TLS itself", async () => {
    // There is no tls/cert/key field in OcxConfig. A reader who assumes otherwise looks for a
    // setting that does not exist instead of standing up a frontend.
    const source = await Bun.file(GUIDE).text();
    expect(source).toContain("terminates no TLS of its own");
  });

  test("ocx connect is shown with a data origin and a separate management origin", async () => {
    // The positional URL is where /readyz and /v1/catalog are fetched; --management-url is where
    // pairing and key issuance go. They need not share a port, and the macOS recipe relies on that.
    const source = await Bun.file(GUIDE).text();
    expect(source).toContain("ocx connect https://hub-name.tailnet-name.ts.net:8443");
    expect(source).toContain("--management-url https://hub-name.tailnet-name.ts.net");
  });

  test("the macOS Serve constraint and the loopback-bind trap are both documented", async () => {
    const source = await Bun.file(GUIDE).text();
    // Serve cannot reach a listener bound to the node's own tailnet address.
    expect(source).toContain("Tailscale Serve proxies only to");
    // And the obvious workaround -- bind the listener to loopback -- breaks the catalog quietly.
    expect(source).toContain("403 origin_rejected");
    expect(source).toContain("X-Forwarded-Host");
  });

  test("the Docker section does not contradict the standalone parent-object rule", async () => {
    // Compose seeds a hub object, so its nested sets work. Without saying so, the two sections
    // read as two different rules and the reader cannot tell which applies to them.
    const source = await Bun.file(GUIDE).text();
    expect(source).toContain("because the image seeds a first-run");
  });

  test("the retired --allow-insecure-http flag is not offered", async () => {
    // It is absent from CONNECT_USAGE, pairing refuses non-loopback HTTP outright, and
    // remoteGui.allowInsecureHttp is a retired no-op. Offering it sends an operator to an error.
    const source = await Bun.file(GUIDE).text();
    expect(source).not.toContain("--allow-insecure-http");
  });
});
