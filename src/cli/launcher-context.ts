/**
 * Trusted facts captured by the plain-Node package launcher before Bun auto-loads
 * project dotenv files. The random proof travels in argv while the context
 * travels in the environment, so a project `.env` cannot forge the pair during
 * an ordinary `ocx ...` invocation.
 */
export const NODE_LAUNCH_CONTEXT_ENV = "OCX_NODE_LAUNCH_CONTEXT";
export const NODE_LAUNCH_PROOF_PREFIX = "--ocx-internal-launch-proof=";

export const ANTHROPIC_PARENT_ENV_SLOTS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

export type AnthropicParentEnvSlot = typeof ANTHROPIC_PARENT_ENV_SLOTS[number];
export type CodexCliVersionManagerRootEnvSlot = typeof CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS[number];

type CodexCliVersionManagerRoots = Readonly<Partial<Record<CodexCliVersionManagerRootEnvSlot, string>>>;

export type TrustedNodeLaunchContext = {
  anthropicEnvSlots: readonly AnthropicParentEnvSlot[];
  codexCliInspectionEnv: Readonly<{
    codexCliPath: string | null;
    path: string | null;
    pathExt: string | null;
    home: string | null;
    nodePath: string | null;
    managerRoots: CodexCliVersionManagerRoots | null;
    transportEnv: Readonly<Record<string, string>>;
    arch: NodeJS.Architecture | null;
    configDir: string;
  }> | null;
};

let trustedContext: TrustedNodeLaunchContext | null = null;

function isLaunchProof(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function parseVersionManagerRoots(value: unknown): CodexCliVersionManagerRoots | null | undefined {
  // Missing means an older launcher. Preserve compatibility for unrelated
  // commands, but updater inspection treats the incomplete snapshot as
  // untrusted and fails closed.
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const allowed = new Set<string>(CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS);
  const entries = Object.entries(value);
  if (entries.length > allowed.size || entries.some(([name, root]) =>
    !allowed.has(name) || typeof root !== "string" || root.length === 0 || root.length > 32 * 1024)) {
    return undefined;
  }
  return Object.freeze(Object.fromEntries(entries)) as CodexCliVersionManagerRoots;
}

function parseTransportEnv(value: unknown): Readonly<Record<string, string>> | undefined {
  // Older snapshots convey no transport settings. Never fill them from Bun's ambient env.
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([name, setting]) => !CODEX_CLI_TRANSPORT_ENV_KEYS.includes(name.toLowerCase())
    || typeof setting !== "string" || setting.length > 32 * 1024)) return undefined;
  return Object.freeze(Object.fromEntries(entries));
}

const NODE_ARCHITECTURES: ReadonlySet<string> = new Set<NodeJS.Architecture>([
  "arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc64", "riscv64", "s390x", "x64",
]);

function parseLauncherArch(value: unknown): NodeJS.Architecture | null | undefined {
  // Older snapshots predate the field; absent stays null (Bun's own arch is the
  // pre-existing fallback). Any other non-architecture value is untrusted.
  if (value === undefined || value === null) return null;
  return typeof value === "string" && NODE_ARCHITECTURES.has(value) ? value as NodeJS.Architecture : undefined;
}

/** Consume the internal proof before normal CLI argument parsing. */
export function initializeNodeLauncherContext(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): TrustedNodeLaunchContext | null {
  const proofArgs: string[] = [];
  for (let index = argv.length - 1; index >= 2; index -= 1) {
    const value = argv[index];
    if (!value?.startsWith(NODE_LAUNCH_PROOF_PREFIX)) continue;
    proofArgs.push(value.slice(NODE_LAUNCH_PROOF_PREFIX.length));
    argv.splice(index, 1);
  }

  const raw = env[NODE_LAUNCH_CONTEXT_ENV];
  delete env[NODE_LAUNCH_CONTEXT_ENV];
  // Older launchers used this unauthenticated marker. Never let a project
  // dotenv resurrect it as a trusted provenance channel.
  delete env.OCX_PRE_BUN_ANTHROPIC_ENV;
  trustedContext = null;

  if (proofArgs.length !== 1 || !raw || raw.length > NODE_LAUNCH_CONTEXT_MAX_CHARS) return null;
  const proof = proofArgs[0]!;
  if (!isLaunchProof(proof)) return null;

  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      proof?: unknown;
      anthropicEnvSlots?: unknown;
      codexCliInspectionEnv?: unknown;
    };
    if (parsed.version !== 1 || parsed.proof !== proof || !Array.isArray(parsed.anthropicEnvSlots)) {
      return null;
    }
    const allowed = new Set<string>(ANTHROPIC_PARENT_ENV_SLOTS);
    const slots = parsed.anthropicEnvSlots.filter(
      (slot): slot is AnthropicParentEnvSlot => typeof slot === "string" && allowed.has(slot),
    );
    if (slots.length !== parsed.anthropicEnvSlots.length || new Set(slots).size !== slots.length) {
      return null;
    }
    const inspection = parsed.codexCliInspectionEnv;
    const managerRoots = inspection && typeof inspection === "object" && !Array.isArray(inspection)
      ? parseVersionManagerRoots((inspection as Record<string, unknown>).managerRoots)
      : null;
    const transportEnv = inspection && typeof inspection === "object" && !Array.isArray(inspection)
      ? parseTransportEnv((inspection as Record<string, unknown>).transportEnv)
      : undefined;
    const arch = inspection && typeof inspection === "object" && !Array.isArray(inspection)
      ? parseLauncherArch((inspection as Record<string, unknown>).arch)
      : undefined;
    const codexCliInspectionEnv = inspection === null || inspection === undefined
      ? null
      : inspection && typeof inspection === "object" && !Array.isArray(inspection)
        && ["codexCliPath", "path", "pathExt"].every(key => {
          const value = (inspection as Record<string, unknown>)[key];
          return value === null || typeof value === "string";
        })
        // Older launchers predate the lookup-seed slots; absent stays null so
        // the fallback lane simply remains unverifiable rather than untrusted.
        && ["home", "nodePath"].every(key => {
          const value = (inspection as Record<string, unknown>)[key];
          return value === undefined || value === null || typeof value === "string";
        })
        && typeof (inspection as Record<string, unknown>).configDir === "string"
        && (inspection as Record<string, string>).configDir.length > 0
        && (inspection as Record<string, string>).configDir.length <= 32 * 1024
        && managerRoots !== undefined
        && transportEnv !== undefined
        && arch !== undefined
        ? Object.freeze({
            codexCliPath: (inspection as Record<string, string | null>).codexCliPath ?? null,
            path: (inspection as Record<string, string | null>).path ?? null,
            pathExt: (inspection as Record<string, string | null>).pathExt ?? null,
            home: (inspection as Record<string, string | null>).home ?? null,
            nodePath: (inspection as Record<string, string | null>).nodePath ?? null,
            managerRoots,
            transportEnv,
            arch,
            configDir: (inspection as Record<string, string>).configDir,
          })
        : undefined;
    if (codexCliInspectionEnv === undefined) return null;
    trustedContext = { anthropicEnvSlots: slots, codexCliInspectionEnv };
    return trustedContext;
  } catch {
    return null;
  }
}

export function trustedNodeLauncherContext(): TrustedNodeLaunchContext | null {
  return trustedContext;
}
import {
  CODEX_CLI_TRANSPORT_ENV_KEYS,
  CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS,
  NODE_LAUNCH_CONTEXT_MAX_CHARS,
} from "../update/codex-cli-update-launch-policy.mjs";
