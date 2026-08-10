/**
 * Trusted facts captured by the plain-Node npm launcher before Bun auto-loads
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

export type TrustedNodeLaunchContext = {
  anthropicEnvSlots: readonly AnthropicParentEnvSlot[];
};

let trustedContext: TrustedNodeLaunchContext | null = null;

function isLaunchProof(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
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

  if (proofArgs.length !== 1 || !raw || raw.length > 2048) return null;
  const proof = proofArgs[0]!;
  if (!isLaunchProof(proof)) return null;

  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      proof?: unknown;
      anthropicEnvSlots?: unknown;
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
    trustedContext = { anthropicEnvSlots: slots };
    return trustedContext;
  } catch {
    return null;
  }
}

export function trustedNodeLauncherContext(): TrustedNodeLaunchContext | null {
  return trustedContext;
}
