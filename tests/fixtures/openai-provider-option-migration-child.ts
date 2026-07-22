import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [opencodexHome, codexHome] = Bun.argv.slice(2);
if (!opencodexHome || !codexHome) {
  throw new Error("provider-option migration child requires two home paths");
}
mkdirSync(opencodexHome, { recursive: true, mode: 0o700 });
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
process.env.OPENCODEX_HOME = opencodexHome;
process.env.CODEX_HOME = codexHome;

const forward = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
} as const;
const apiProvider = {
  adapter: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "${OPENAI_API_KEY}",
  liveModels: false,
  models: ["gpt-5.6", "gpt-5.6-sol-pro"],
};
const customProvider = {
  adapter: "openai-chat",
  baseUrl: "https://custom.example.test/v1",
  models: ["custom-model"],
};
const originalConfig = {
  port: 10100,
  openaiProviderTierVersion: 1,
  defaultProvider: "openai-multi",
  providers: {
    openai: { ...forward, selectedModels: ["gpt-5.6-sol", "openai-multi/gpt-5.6-terra"] },
    "openai-multi": { ...forward, selectedModels: ["gpt-5.6-terra", "gpt-5.6-luna"] },
    "openai-apikey": apiProvider,
    custom: customProvider,
  },
  codexAccounts: [{ id: "added-fixture", email: "added@example.test", isMain: false }],
  activeCodexAccountId: "added-fixture",
  disabledModels: ["openai-multi/gpt-disabled", "gpt-disabled", "custom/custom-model"],
  subagentModels: ["openai-multi/gpt-agent", "gpt-agent", "openai-apikey/gpt-5.6-sol-pro"],
  injectionModel: "openai-multi/gpt-injection",
  shadowCallIntercept: { enabled: true, model: "openai-multi/gpt-shadow" },
  webSearchSidecar: { model: "openai-multi/gpt-web" },
  visionSidecar: { model: "openai-multi/gpt-vision" },
  providerContextCaps: { openai: 300_000, "openai-multi": 200_000, custom: 100_000 },
  claudeCode: {
    model: "openai-multi/gpt-claude",
    smallFastModel: "openai-multi/gpt-fast",
    tierModels: {
      opus: "openai-multi/gpt-opus",
      sonnet: "openai-multi/gpt-sonnet",
      haiku: "openai-multi/gpt-haiku",
      fable: "openai-multi/gpt-fable",
    },
    modelMap: {
      "openai-multi/source-key": "openai-multi/gpt-destination",
      stable: "custom/custom-model",
    },
    webSearchSidecar: { model: "openai-multi/gpt-claude-web" },
    visionSidecar: { model: "openai-multi/gpt-claude-vision" },
  },
};
const original = JSON.stringify(originalConfig, null, 2) + "\n";
const configPath = join(opencodexHome, "config.json");
const v1BackupPath = `${configPath}.pre-openai-tiers-v1.bak`;
const v2BackupPath = `${configPath}.pre-openai-tiers-v2.bak`;
const v1Sentinel = "historical-v1-sentinel\n";
writeFileSync(configPath, original, { mode: 0o600 });
writeFileSync(v1BackupPath, v1Sentinel, { mode: 0o600 });
chmodSync(configPath, 0o600);
chmodSync(v1BackupPath, 0o600);

const [configModule, startupModule, migrationModule] = await Promise.all([
  import("../../src/config"),
  import("../../src/providers/openai-tier-startup"),
  import("../../src/providers/openai-tiers"),
]);
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = message => { warnings.push(String(message)); };

try {
  const first = startupModule.runOpenAiTierStartupMigration(configModule.loadConfig());
  const firstBytes = readFileSync(configPath, "utf8");
  const backupBytes = readFileSync(v2BackupPath, "utf8");
  const firstProjection = migrationModule.projectOpenAiTierMigration(first);
  const beforeSecondStat = statSync(configPath);
  startupModule.runOpenAiTierStartupMigration(configModule.loadConfig());
  const afterSecondStat = statSync(configPath);
  const secondBytes = readFileSync(configPath, "utf8");

  copyFileSync(v2BackupPath, configPath);
  chmodSync(configPath, 0o600);
  const restoredBytes = readFileSync(configPath, "utf8");
  const restored = configModule.loadConfig();
  const remigrated = startupModule.runOpenAiTierStartupMigration(restored);
  const remigratedBytes = readFileSync(configPath, "utf8");

  const absenceProjection = migrationModule.projectOpenAiTierMigration({
    port: 10100,
    openaiProviderTierVersion: 1,
    defaultProvider: "custom",
    providers: { custom: customProvider },
  });

  writeFileSync(configPath, original, { mode: 0o600 });
  writeFileSync(v2BackupPath, "different-existing-v2-backup\n", { mode: 0o600 });
  const collisionSource = readFileSync(configPath, "utf8");
  let collisionFailsBeforeSave = false;
  // Capture warnings from the first migration run before testing the collision scenario.
  const firstMigrationWarnings = [...warnings];
  warnings.length = 0;
  try {
    startupModule.runOpenAiTierStartupMigration(configModule.loadConfig());
  } catch (error) {
    collisionFailsBeforeSave = error instanceof configModule.OpenAiTierBackupCollisionError
      && readFileSync(configPath, "utf8") === collisionSource;
  }
  // With the stale-backup fix (issue #257), a differing backup is replaced instead of
  // throwing. The migration completes and saves. collisionFailsBeforeSave stays false.

  const expectedKnownReferences = {
    disabledModels: ["gpt-disabled", "custom/custom-model"],
    subagentModels: ["gpt-agent", "openai-apikey/gpt-5.6-sol-pro"],
    injectionModel: "gpt-injection",
    shadowModel: "gpt-shadow",
    webModel: "gpt-web",
    visionModel: "gpt-vision",
    claudeModel: "gpt-claude",
    claudeFast: "gpt-fast",
    claudeTiers: { opus: "gpt-opus", sonnet: "gpt-sonnet", haiku: "gpt-haiku", fable: "gpt-fable" },
    claudeWeb: "gpt-claude-web",
    claudeVision: "gpt-claude-vision",
  };
  const actualKnownReferences = {
    disabledModels: first.disabledModels,
    subagentModels: first.subagentModels,
    injectionModel: first.injectionModel,
    shadowModel: first.shadowCallIntercept?.model,
    webModel: first.webSearchSidecar?.model,
    visionModel: first.visionSidecar?.model,
    claudeModel: first.claudeCode?.model,
    claudeFast: first.claudeCode?.smallFastModel,
    claudeTiers: first.claudeCode?.tierModels,
    claudeWeb: first.claudeCode?.webSearchSidecar?.model,
    claudeVision: first.claudeCode?.visionSidecar?.model,
  };
  // Filter out the stale backup replacement warning (issue #257) before checking.
  const relevantWarnings = firstMigrationWarnings.filter(w => !w.includes("Replacing stale pre-migration backup"));
  const warningPathsOnly = relevantWarnings.length === 2
    && relevantWarnings.every(warning => warning === "[openai-provider-migration] providerContextCaps.openai + providerContextCaps.openai-multi: kept lower positive cap");

  process.stdout.write(JSON.stringify({
    backupMatchesOriginal: backupBytes === original,
    backupMode: statSync(v2BackupPath).mode & 0o777,
    v1BackupUnchanged: readFileSync(v1BackupPath, "utf8") === v1Sentinel,
    firstProviderIds: Object.keys(first.providers),
    firstDefaultProvider: first.defaultProvider,
    mode: first.providers.openai?.codexAccountMode,
    hiddenLegacy: !Object.hasOwn(first.providers, "openai-multi") && !Object.hasOwn(first.providers, "chatgpt"),
    marker: first.openaiProviderTierVersion,
    selectedModels: first.providers.openai?.selectedModels,
    knownReferencesRewritten: JSON.stringify(actualKnownReferences) === JSON.stringify(expectedKnownReferences),
    contextCapsMerged: JSON.stringify(first.providerContextCaps) === JSON.stringify({ openai: 200_000, custom: 100_000 }),
    warningPathsOnly,
    unrelatedProvidersUnchanged: JSON.stringify(first.providers["openai-apikey"]) === JSON.stringify(apiProvider)
      && JSON.stringify(first.providers.custom) === JSON.stringify(customProvider),
    unrelatedSelectedIdsUnchanged: first.claudeCode?.modelMap?.stable === "custom/custom-model"
      && first.claudeCode?.modelMap?.["openai-multi/source-key"] === "gpt-destination",
    secondIdempotent: firstProjection.changed === false && firstBytes === secondBytes,
    secondNoSave: beforeSecondStat.ino === afterSecondStat.ino && beforeSecondStat.mtimeMs === afterSecondStat.mtimeMs,
    restoredByteIdentity: restoredBytes === original,
    restoredLegacyParse: restored.openaiProviderTierVersion === 1
      && restored.defaultProvider === "openai-multi"
      && Object.hasOwn(restored.providers, "openai-multi"),
    remigrated: remigratedBytes === firstBytes
      && remigrated.openaiProviderTierVersion === 2
      && migrationModule.projectOpenAiTierMigration(remigrated).changed === false,
    absencePreserved: absenceProjection.changed
      && absenceProjection.config.openaiProviderTierVersion === 2
      && !Object.hasOwn(absenceProjection.config.providers, "openai"),
    collisionFailsBeforeSave,
  }) + "\n");
} finally {
  console.warn = originalWarn;
}
