// Native-semantics consumer: CODEX_HOME is a literal path, never shell-expanded.
// This fixture observes the child boundary without requiring an installed Codex.
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const home = realpathSync(resolve(process.env.CODEX_HOME!));
const config = Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8")) as {
  model_provider: string;
  model_providers: Record<string, { base_url: string; env_key: string }>;
};
const provider = config.model_providers[config.model_provider]!;
const token = process.env[provider.env_key];
let status: number | undefined;
if (process.env.OCX_FIXTURE_REQUEST === "1") {
  // Mirror the native transport's relevant HTTP_PROXY behavior for the observer.
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  const response = await fetch(`${provider.base_url}/responses`, {
    method: "POST", proxy, headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: "{}",
  });
  status = response.status;
}
console.log(JSON.stringify({ home, baseUrl: provider.base_url, hasToken: Boolean(token), status }));
