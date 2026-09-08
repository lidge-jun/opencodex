import * as readline from "node:readline";
import { modelSelectionGuidance } from "./model-selection-guidance";
import { initializeProviderModelSelection } from "../providers/initial-model-selection";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { injectCodexConfig } from "../codex/inject";
import { classifyOpenAiTierBackup, ConfigMutationLockError, getConfigPath, getDefaultConfig, initializePersistedConfigIfMissing, isValidProviderName, observeInitialConfigState, preserveOpenAiTierRollbackSnapshot } from "../config";
import { InitialConfigPublicationError } from "../config/initialize";
import { redactUserPath } from "../lib/redact";
import { enrichProviderFromCatalog } from "../oauth/key-providers";
import { deriveInitProviders } from "../providers/derive";
import type { OcxConfig, OcxProviderConfig } from "../types";

class InitCancelledError extends Error {
  constructor(readonly exitCode: 1 | 130) {
    super(exitCode === 130 ? "Setup cancelled." : "stdin reached EOF while waiting for input. Re-run `ocx init` in an interactive terminal.");
  }
}

function createPrompt(): { ask(question: string): Promise<string>; throwIfCancelled(): void; close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  let cancellation: InitCancelledError | undefined;
  const onInterrupt = () => {
    cancellation = new InitCancelledError(130);
    rl.close();
  };
  rl.on("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);
  rl.on("close", () => {
    closed = true;
    cancellation ??= new InitCancelledError(1);
    process.off("SIGINT", onInterrupt);
    rl.off("SIGINT", onInterrupt);
  });
  return {
    ask(question: string): Promise<string> {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(cancellation ?? new InitCancelledError(1));
          return;
        }
        const onClose = () => {
          reject(cancellation ?? new InitCancelledError(1));
        };
        rl.once("close", onClose);
        rl.question(question, answer => {
          rl.off("close", onClose);
          resolve(answer);
        });
      });
    },
    throwIfCancelled() {
      if (cancellation) throw cancellation;
    },
    close() {
      if (!closed) rl.close();
    },
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
  console.log("Choose your default provider (you can add more later):");
  let lastKind: InitKind | null = null;
  providers.forEach((p, i) => {
    if (p.kind !== lastKind) { console.log(`\n  ${KIND_HEADING[p.kind]}:`); lastKind = p.kind; }
    console.log(`   ${String(i + 1).padStart(2)}. ${p.label}`);
  });
  console.log(`\n   ${providers.length + 1}. custom (enter URL manually)`);
}

const envKeyFor = (id: string) => `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

/** Post-init cleanup of `.pre-openai-tiers-v2.bak` with rollback preservation (issue #257). */
export function cleanupOpenAiTierBackupAfterInit(configPath = getConfigPath()): void {
  const backup = `${configPath}.pre-openai-tiers-v2.bak`;
  try {
    if (!existsSync(backup)) return;
    if (classifyOpenAiTierBackup(readFileSync(backup)) === "stale") {
      unlinkSync(backup);
      return;
    }
    const preserved = preserveOpenAiTierRollbackSnapshot(configPath);
    console.warn(`⚠️  Kept your pre-migration config rollback snapshot at ${preserved}`);
  } catch { /* cleanup is best-effort; never block init on backup housekeeping */ }
}

export async function runInit(): Promise<void> {
  const initial = observeInitialConfigState();
  if (initial === "exists") {
    console.log(`Keeping existing config at ${redactUserPath(getConfigPath())}. Use \`ocx config\` or the dashboard to update it.`);
    return;
  }
  if (initial === "invalid") {
    console.error(`Cannot initialize ${redactUserPath(getConfigPath())}: existing config is invalid, unreadable, or not a regular file. It has been preserved.`);
    process.exitCode = 1;
    return;
  }
  const prompt = createPrompt();
  let configCreated = false;
  try {
    console.log("\n🔧 opencodex (ocx) setup\n");

    const providers = buildInitProviders();
    printMenu(providers);

    const choice = await prompt.ask("\nSelect default provider (number): ");
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

    initializeProviderModelSelection(providerName, providerConfig);
    const config: OcxConfig = {
      ...getDefaultConfig(),
      port,
      providers: { [providerName]: providerConfig },
      defaultProvider: providerName,
      modelDiscovery: { newModelPolicy: "off" },
    };

    prompt.throwIfCancelled();
    const outcome = initializePersistedConfigIfMissing(config);
    if (outcome !== "created") {
      console.error("Config appeared or changed while setup was running; keeping it and stopping setup.");
      process.exitCode = 1;
      return;
    }
    configCreated = true;
    // Init writes a fresh config, so a stale pre-migration backup from a previous
    // installation would make the next `ocx start` crash on a stale-backup
    // collision (issue #257). But only a STALE backup (unparseable, or already a
    // post-migration v2 snapshot) may be deleted; a backup that still parses as a
    // valid pre-migration (v1) config is a user-intentional rollback point and is
    // preserved by renaming it out of the collision path (sol review 260722).
    cleanupOpenAiTierBackupAfterInit();
    console.log(`\n✅ Config saved to ${redactUserPath(getConfigPath())}`);
    if (oauthHint) console.log(`🔐 Authenticate this provider with:  ocx login ${providerName}`);

    const injectAnswer = await prompt.ask("Inject into Codex config.toml? [Y/n]: ");
    prompt.throwIfCancelled();
    if (injectAnswer.trim().toLowerCase() !== "n") {
      console.log("Fetching available models from provider...");
      const result = await injectCodexConfig(port, config, {
        beforeClientWrite: () => prompt.throwIfCancelled(),
      }).catch(error => {
        // The injection/lock boundary may wrap the guard's cancellation error.
        prompt.throwIfCancelled();
        throw error;
      });
      prompt.throwIfCancelled();
      console.log(result.success ? `✅ ${result.message}` : `⚠️  ${result.message}`);
    }

    const shimAnswer = await prompt.ask("Install Codex autostart shim? [Y/n]: ");
    prompt.throwIfCancelled();
    if (shimAnswer.trim().toLowerCase() !== "n") {
      try {
        const { installCodexShim } = await import("../codex/shim");
        prompt.throwIfCancelled();
        const result = installCodexShim();
        console.log(result.installed ? `✅ ${result.message}` : `⚠️  ${result.message}`);
      } catch (err) {
        if (err instanceof InitCancelledError) throw err;
        console.log(`⚠️  Codex autostart shim skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`\n🚀 Setup complete! Run 'ocx start' to start the proxy.`);
    for (const line of modelSelectionGuidance(providerName)) console.log(line);
  } catch (error) {
    if (error instanceof InitCancelledError) {
      console.error(`\n❌ ${error.message}${configCreated ? " The created config has been kept." : ""}`);
      process.exitCode = error.exitCode;
    } else {
      const message = error instanceof InitialConfigPublicationError
        ? `${error.message}${error.publication !== "not-published" ? " Config may already exist; inspect it before retrying." : ""}${error.residualTemp ? " A temporary file could not be removed; inspect the config directory." : ""}`
        : error instanceof ConfigMutationLockError
          ? "Config initialization could not acquire its write lock. Retry when the other config operation finishes."
          : `Setup did not finish.${configCreated ? " The created config has been kept." : " Check the config directory and setup inputs before retrying."}`;
      console.error(`\n❌ ${message}`);
      process.exitCode = 1;
    }
  } finally {
    prompt.close();
  }
}
