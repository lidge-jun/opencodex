import * as readline from "node:readline";
import { unlinkSync } from "node:fs";
import { injectCodexConfig } from "../codex/inject";
import { getConfigPath, getDefaultConfig, isValidProviderName, saveConfig } from "../config";
import { enrichProviderFromCatalog } from "../oauth/key-providers";
import { deriveInitProviders } from "../providers/derive";
import type { OcxConfig, OcxProviderConfig } from "../types";

function createPrompt(): { ask(question: string): Promise<string>; close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question: string): Promise<string> {
      return new Promise(resolve => rl.question(question, resolve));
    },
    close() { rl.close(); },
  };
}

type InitKind = "forward" | "oauth" | "key" | "local";
export interface InitProvider {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  kind: InitKind;
  dashboardUrl?: string;
  defaultModel?: string;
}

/**
 * The full CLI provider menu, derived from the canonical provider registry so `ocx init`,
 * the GUI picker, key-login catalog, OAuth seeds, and metadata aliases cannot drift.
 */
export function buildInitProviders(): InitProvider[] {
  return deriveInitProviders();
}

const KIND_HEADING: Record<InitKind, string> = {
  forward: "ChatGPT login",
  oauth: "Account login (OAuth — then run: ocx login <id>)",
  key: "API key (paste a key from the provider's dashboard)",
  local: "Local servers (usually no key)",
};

function printMenu(providers: InitProvider[]): void {
  console.log("Available providers:");
  let lastKind: InitKind | null = null;
  providers.forEach((p, i) => {
    if (p.kind !== lastKind) { console.log(`\n  ${KIND_HEADING[p.kind]}:`); lastKind = p.kind; }
    console.log(`   ${String(i + 1).padStart(2)}. ${p.label}`);
  });
  console.log(`\n   ${providers.length + 1}. custom (enter URL manually)`);
}

const envKeyFor = (id: string) => `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

export async function runInit(): Promise<void> {
  const prompt = createPrompt();
  console.log("\n🔧 opencodex (ocx) setup\n");

  const providers = buildInitProviders();
  printMenu(providers);

  const choice = await prompt.ask("\nSelect provider (number): ");
  const idx = parseInt(choice, 10) - 1;

  let providerName: string;
  let providerConfig: OcxProviderConfig;
  let oauthHint = false;

  if (idx >= 0 && idx < providers.length) {
    const p = providers[idx];
    providerName = p.id;
    console.log(`\n📡 ${p.label}`);
    console.log(`   Base URL: ${p.baseUrl}`);

    if (p.kind === "forward") {
      providerConfig = { adapter: p.adapter, baseUrl: p.baseUrl, authMode: "forward" };
      console.log("   No API key needed — forwards your existing `codex login`.");
    } else if (p.kind === "oauth") {
      providerConfig = { adapter: p.adapter, baseUrl: p.baseUrl, authMode: "oauth", ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}) };
      oauthHint = true;
    } else {
      // key + local: collect a key (local usually blank).
      if (p.dashboardUrl) console.log(`   🔑 Get your key: ${p.dashboardUrl}`);
      // Template URL with placeholders (e.g. Cloudflare's {account_id}) needs a resolved value.
      let baseUrl = p.baseUrl;
      if (/\{[^}]*\}/.test(baseUrl)) {
        const resolved = (await prompt.ask(`   Your endpoint URL (${baseUrl}): `)).trim();
        if (!resolved) {
          console.error("   A resolved URL is required — replace the {placeholder} with your actual value.");
          process.exit(1);
        }
        baseUrl = resolved;
      }
      const env = envKeyFor(p.id);
      const hint = p.kind === "local" ? "API key (usually blank — press Enter): " : `API key (paste, or env var $${env}): `;
      const apiKey = (await prompt.ask(`\n${hint}`)).trim();
      const modelChoice = (await prompt.ask(`Default model${p.defaultModel ? ` [${p.defaultModel}]` : " (optional)"}: `)).trim();
      const defaultModel = modelChoice || p.defaultModel;
      providerConfig = {
        adapter: p.adapter,
        baseUrl,
        ...(p.kind === "key" ? { apiKey: apiKey || `\${${env}}` } : apiKey ? { apiKey } : {}),
        ...(defaultModel ? { defaultModel } : {}),
      };
      // Apply the catalog's models / vision classification (same enrichment as the GUI).
      enrichProviderFromCatalog(p.id, providerConfig);
    }
  } else {
    providerName = (await prompt.ask("Provider name: ")).trim();
    if (!isValidProviderName(providerName)) {
      console.error("Provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key.");
      prompt.close();
      process.exit(1);
    }
    const baseUrl = await prompt.ask("Base URL (e.g. http://localhost:11434/v1): ");
    const adapter = await prompt.ask("Adapter [openai-chat]: ") || "openai-chat";
    const apiKey = await prompt.ask("API key (optional): ");
    const defaultModel = await prompt.ask("Default model: ");
    providerConfig = {
      adapter: adapter.trim(),
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
    };
  }

  const portStr = await prompt.ask("\nProxy port [10100]: ");
  const port = parseInt(portStr, 10) || 10100;

  const config: OcxConfig = {
    ...getDefaultConfig(),
    port,
    providers: { [providerName]: providerConfig },
    defaultProvider: providerName,
  };

  saveConfig(config);
  // Init writes a fresh config, so any pre-migration backup from a previous
  // installation is orphaned. Remove it so the next `ocx start` does not crash
  // on a stale-backup collision (issue #257).
  try { unlinkSync(`${getConfigPath()}.pre-openai-tiers-v2.bak`); } catch { /* absent is fine */ }
  console.log(`\n✅ Config saved to ~/.opencodex/config.json`);
  if (oauthHint) console.log(`🔐 Authenticate this provider with:  ocx login ${providerName}`);

  const injectAnswer = await prompt.ask("Inject into Codex config.toml? [Y/n]: ");
  if (injectAnswer.trim().toLowerCase() !== "n") {
    console.log("Fetching available models from provider...");
    const result = await injectCodexConfig(port, config);
    console.log(result.success ? `✅ ${result.message}` : `⚠️  ${result.message}`);
  }

  const shimAnswer = await prompt.ask("Install Codex autostart shim? [Y/n]: ");
  if (shimAnswer.trim().toLowerCase() !== "n") {
    try {
      const { installCodexShim } = await import("../codex/shim");
      const result = installCodexShim();
      console.log(result.installed ? `✅ ${result.message}` : `⚠️  ${result.message}`);
    } catch (err) {
      console.log(`⚠️  Codex autostart shim skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n🚀 Setup complete! Run 'ocx start' to start the proxy.`);
  prompt.close();
}
