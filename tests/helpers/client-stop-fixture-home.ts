import { join } from "node:path";

export function stopFixtureEnv(root: string, inherited = process.env) {
  return { ...inherited, HOME: root, USERPROFILE: root, OPENCODEX_HOME: join(root, "ocx"), CODEX_HOME: join(root, "codex"),
    OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(root, "claude-desktop"), CLAUDE_CONFIG_DIR: join(root, ".claude"),
    GROK_HOME: join(root, ".grok"), XDG_CONFIG_HOME: join(root, ".config"), OCX_OWNER_REGISTRY_DIR: join(root, "ocx", "ocx-homes"),
    OCX_SERVICE: "", OCX_SERVICE_MANAGED: "0" };
}

export function unavailableFixtureHome() {
  const home = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  // Runtime watch requests stay inside this fixture. The Home must not keep its child process alive.
  home.unref();
  return home;
}
