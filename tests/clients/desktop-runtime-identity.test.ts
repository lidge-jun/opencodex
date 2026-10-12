import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * Which instance the shell is talking to, and what it will send there.
 *
 * The management token is the admin credential for this machine's proxy, and the endpoint is a
 * port a local process can take. So identity comes first, from the unauthenticated health body the
 * runtime already publishes — the marker, the pid and the port — and the credential follows only
 * for the instance the shell decided to trust. The same facts answer a second question the shell
 * used to answer with a boolean: whether the process holding the port is the child it started.
 *
 * Both are read out of the source, because CI has no running proxy to address and no Windows
 * webview to navigate.
 */
const SHELL = "desktop/src-tauri/src";
const PROXY = repoPath(`${SHELL}/proxy.rs`);
const EXIT = repoPath(`${SHELL}/exit.rs`);
const LIB = repoPath(`${SHELL}/lib.rs`);
const STARTUP = repoPath(`${SHELL}/startup.rs`);
const WINDOW = repoPath(`${SHELL}/window.rs`);
const SERVE = repoPath("src/server/index/serve-options.ts");

function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("desktop runtime identity", () => {
  const proxy = code(PROXY);
  const exit = code(EXIT);

  test("the identity it reads is the one the runtime publishes", () => {
    // Unauthenticated, so it can be read before anything secret is sent.
    const health = code(SERVE);
    for (const field of ['service: "opencodex"', "pid: process.pid", "port: healthPort"]) {
      expect(health).toContain(field);
    }
    const reader = proxy.slice(proxy.indexOf("pub fn identity_from("));
    const body = reader.slice(0, reader.indexOf("\n}"));
    expect(body).toContain('body.get("service")');
    expect(body).toContain('body.get("pid")');
    expect(body).toContain('body.get("port")');
    // A 200 from something else on the port is not this proxy, and a body describing a different
    // listener does not authorise a credential for this one.
    expect(body).toContain("if port != addressed_port {");
  });

  test("the credential is never sent to an unconfirmed instance", () => {
    // The admin token never leaves the client: the request carries a single-use capability
    // minted only for the recorded runtime, so a listener that took the port after the bound
    // child exited cannot satisfy it.
    const start = proxy.indexOf("fn authorised_capability(");
    expect(start).toBeGreaterThan(-1);
    const body = proxy.slice(start, proxy.indexOf("async fn send(", start));
    expect(body).toContain("let Some(binding) = self.binding() else");
    // Re-confirmed here, not trusted from when it was made: in between, the child can exit and
    // something else can hold the port.
    expect(body).toContain("runtime_identity()");
    expect(body).toContain("recorded.port != self.endpoint.port");
    expect(body).toContain("recorded.pid != binding.identity.pid");
    expect(body).toContain("recorded.port != binding.identity.port");
    expect(body).toContain("if self.binding() != Some(binding)");
    // The minted proof is bound to the method and path, and the raw token is never read here.
    expect(body).toContain("CapabilityHeaders::mint(&recorded, method, path)");
    expect(body).not.toContain("self.auth.token()");
  });

  test("a request is bound to the pid, the port and the generation it was authorised under", () => {
    expect(proxy).toContain("pub struct RuntimeIdentity {");
    expect(proxy).toContain("pub pid: u32");
    expect(proxy).toContain("pub port: u16");
    expect(proxy).toContain("pub struct RuntimeBinding {");
    expect(proxy).toContain("pub generation: u64");
    const bind = proxy.slice(proxy.indexOf("pub fn bind("));
    expect(bind.slice(0, bind.indexOf("\n    }"))).toContain("*generations += 1;");
  });

  test("the local management client refuses redirects and system proxies", () => {
    const builder = proxy.slice(proxy.indexOf("Client::builder()"), proxy.indexOf(".build()?"));
    expect(builder).toContain("redirect(redirect::Policy::none())");
    expect(builder).toContain(".no_proxy()");
  });

  test("attaching to a runtime does not carry ownership of the last one", () => {
    const lib = code(LIB);
    const attach = lib.slice(lib.indexOf("pub fn attach("));
    const body = attach.slice(0, attach.indexOf("\n    }"));
    expect(body).toContain("self.confirmed.store(false, Ordering::Release)");
    // A spawn records a pid; it does not record that the pid is the one holding the port.
    const adopt = lib.slice(lib.indexOf("pub fn adopt("));
    expect(adopt.slice(0, adopt.indexOf("\n    }"))).toContain(
      "self.confirmed.store(false, Ordering::Release)",
    );
    const confirm = lib.slice(lib.indexOf("pub fn confirm_ownership("));
    expect(confirm.slice(0, confirm.indexOf("\n    }"))).toContain(
      "self.child_pid() == Some(identity.pid)",
    );
  });

  test("ownership is confirmed from the answering pid before anything is stopped", () => {
    const start = exit.indexOf("async fn confirm(");
    expect(start).toBeGreaterThan(-1);
    const body = exit.slice(start, exit.indexOf("fn hide_windows(", start));
    expect(body).toContain("identity.pid == child_pid => Ownership::Ours");
    expect(body).toContain("Ok(_) => Ownership::Foreign");
    // Nothing listening is only proof the child is gone if the child said so.
    expect(body).toContain("watch.exit().is_some()");
    expect(body).toContain("Ownership::Unknown");
    const drain = exit.slice(exit.indexOf("pub async fn drain_current("));
    const drainBody = drain.slice(0, drain.indexOf("\nenum Ownership"));
    expect(drainBody).toContain("Ownership::Foreign => DrainVerdict::Drained");
    expect(drainBody).toContain("Ownership::Unknown => DrainVerdict::OwnershipUnknown");
  });

  test("the startup sequence is what grants ownership, and only on a readable answer", () => {
    const startup = code(STARTUP);
    const bind = startup.slice(startup.indexOf("async fn bind("));
    const body = bind.slice(0, bind.indexOf("\n}"));
    expect(body).toContain("proxy.identify()");
    expect(body).toContain("proxy.bind(identity)");
    expect(body).toContain("state.confirm_ownership(identity)");
    // An answer that cannot be read leaves the app owning nothing.
    expect(body).toContain("_ => return None,");
    // And the sequence does not report Ready against an instance it could not identify: the
    // management token is only ever sent to a bound one, so a dashboard there would not load.
    const callers = startup.match(/bind\(app, &?proxy, deadline\)\.await\.is_none\(\)/g) || [];
    expect(callers).toHaveLength(2);
  });

  test("the app's own origin is allowed by both spellings, and nothing wider", () => {
    const window = code(WINDOW);
    const rule = window.slice(window.indexOf("fn is_app_origin("));
    const body = rule.slice(0, rule.indexOf("\n}"));
    // The custom scheme's app host (tauri://localhost, no port), and the http spelling WebView2
    // needs on Windows. The update page's command guard relies on this exact app origin.
    expect(body).toContain('"tauri" => url.host_str() == Some("localhost") && url.port().is_none()');
    expect(body).toContain('url.host_str() == Some("tauri.localhost")');
    // Not https, which is not the scheme the pinned Tauri serves the app over, and not a port,
    // which would mean something else is answering.
    expect(body).toContain("url.port().is_none()");
    expect(body).not.toContain('"https"');
    expect(window).toContain("if is_app_origin(url) {");
    // Not http://localhost generally (only the tauri: scheme may name that host), and not a
    // remote IPC widening.
    expect(body).not.toMatch(/"http" =>[^\n]*Some\("localhost"\)/);
    expect(window.match(/Some\("localhost"\)/g) ?? []).toHaveLength(1);
    expect(readFileSync(repoPath("desktop/src-tauri/capabilities/default.json"), "utf8")).not.toContain(
      "remote",
    );
  });
});
