/**
 * Pipe-regression child for #1007: runs the REAL account login handler
 * against a mock management API whose login-status never resolves, so the
 * parent can prove the authorization URL reaches a piped stdout while the
 * child is still polling.
 */
import { cmdAccount, type AccountDeps } from "../../src/cli/account";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/api/codex-auth/login") {
      return Response.json({
        url: "https://auth.example/authorize?flow=pipe-test",
        instructions: "Finish sign-in in your browser.",
        flowId: "flow-pipe",
      });
    }
    if (url.pathname === "/api/codex-auth/login-status") {
      // Never resolves: the child keeps polling for the whole window.
      return Response.json({ status: "pending" });
    }
    return Response.json({ error: "unhandled" }, 404);
  },
});

const deps: AccountDeps = {
  baseUrl: `http://127.0.0.1:${server.port}`,
  loadConfigImpl: () => ({ providers: {} }) as ReturnType<NonNullable<AccountDeps["loadConfigImpl"]>>,
};

await cmdAccount(["login", "openai"], deps);
server.stop(true);
