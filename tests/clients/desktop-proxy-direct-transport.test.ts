import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * The desktop shell's management client talks to the loopback proxy with the admin token
 * attached. reqwest resolves system proxy configuration by default — HTTP_PROXY,
 * HTTPS_PROXY, and the platform proxy settings behind them — so a machine-wide proxy
 * would receive a credential that is only ever meant for the loopback endpoint. The builder
 * has to opt out explicitly; nothing in the request path re-checks it afterwards.
 */
describe("desktop management transport", () => {
  const source = readFileSync(repoPath("desktop", "src-tauri", "src", "proxy.rs"), "utf8");

  test("the proxy client disables system proxy resolution for its loopback traffic", () => {
    // Line comments are stripped first: a .no_proxy() that only exists in prose must not
    // satisfy the contract.
    const code = source.replace(/\/\/[^\n]*/g, "");
    const builder = code.split("Client::builder()")[1]?.split(".build()")[0];
    expect(builder).toBeDefined();
    expect(builder).toContain(".no_proxy()");
  });
});
