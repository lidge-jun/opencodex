import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeBaseUrl,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";
import { parseTargets } from "./combo";
import { serializeManagementJson } from "./json-input";

export const DESKTOP_REMOTE_USAGE = `Usage:
  ocx combo desktop-remote [show] [--json]
  ocx combo desktop-remote apply [--sol <target>] [--terra <target>] [--luna <target>] [--json]
  ocx combo desktop-remote clear --yes [--json]`;

export interface DesktopRemoteSlotDef {
  slot: "sol" | "terra" | "luna";
  alias: string;
  defaultComboId: string;
  defaultLabel: string;
}

export const DESKTOP_REMOTE_SLOTS: readonly DesktopRemoteSlotDef[] = [
  { slot: "sol", alias: "gpt-5.6-sol", defaultComboId: "desktop-sol", defaultLabel: "Desktop Remote - Sol" },
  { slot: "terra", alias: "gpt-5.6-terra", defaultComboId: "desktop-terra", defaultLabel: "Desktop Remote - Terra" },
  { slot: "luna", alias: "gpt-5.6-luna", defaultComboId: "desktop-luna", defaultLabel: "Desktop Remote - Luna" },
] as const;

type ComboRow = Record<string, unknown> & {
  id?: string;
  alias?: string;
  nativeAlias?: boolean;
  displayName?: string;
  targets?: Array<{ provider?: string; model?: string; weight?: number }>;
};

type ProviderRow = {
  name: string;
  models?: string[];
};

function extractPort(baseUrl?: string): number | undefined {
  if (!baseUrl) return undefined;
  try {
    const parsed = new URL(baseUrl);
    return parsed.port ? Number(parsed.port) : undefined;
  } catch {
    return undefined;
  }
}

function formatTargets(targets?: Array<{ provider?: string; model?: string; weight?: number }>): string {
  if (!targets || targets.length === 0) return "[empty]";
  return targets.map(t => `${t.provider ?? ""}/${t.model ?? ""}${t.weight && t.weight > 1 ? `:${t.weight}` : ""}`).join(", ");
}

function findExistingTarget(combos: ComboRow[], alias: string): string | undefined {
  const match = combos.find(c => c.alias === alias && c.nativeAlias === true);
  if (!match?.targets || match.targets.length === 0) return undefined;
  return formatTargets(match.targets);
}

function discoverAvailableTargets(providers: ProviderRow[]): Record<"sol" | "terra" | "luna", string | undefined> {
  const candidates: string[] = [];
  for (const p of providers) {
    if (p.name === "openai" || p.name === "combo") continue;
    for (const m of p.models ?? []) {
      candidates.push(`${p.name}/${m}`);
    }
  }

  const sol = candidates.find(c => /auto|sonnet/i.test(c)) ?? candidates[0];
  const remainingAfterSol = candidates.filter(c => c !== sol);
  const terra = remainingAfterSol.find(c => /gemini|flash/i.test(c)) ?? remainingAfterSol[0];
  const remainingAfterTerra = remainingAfterSol.filter(c => c !== terra);
  const luna = remainingAfterTerra.find(c => /opus|grok|deepseek/i.test(c)) ?? remainingAfterTerra[0];

  return { sol, terra, luna };
}

async function showDesktopRemote(args: string[], deps: RuntimeApiDeps): Promise<void> {
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, DESKTOP_REMOTE_USAGE);

  deps = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
  const result = await runtimeRequest<{ combos?: ComboRow[] }>("/api/combos", {}, deps);
  const combos = result.combos ?? [];

  const effectivePort = extractPort(deps.baseUrl) ?? 10100;
  const sshConfigLine = `RemoteForward ${effectivePort} 127.0.0.1:${effectivePort}`;
  const codexBaseUrl = `http://127.0.0.1:${effectivePort}/v1`;

  const slotsData: Record<string, unknown> = {
    "gpt-6.1-sol": {
      slot: "native-sol",
      type: "native",
      description: "OpenAI Native / Multi-account pool (default route)",
    },
  };

  const textLines: string[] = [
    "Codex Desktop Remote Allowlist Slots:",
    "  • gpt-6.1-sol   (Slot 1): OpenAI Native / Multi-account pool (default route)",
  ];

  for (const slot of DESKTOP_REMOTE_SLOTS) {
    const match = combos.find(c => c.alias === slot.alias && c.nativeAlias === true);
    if (match) {
      const targetStr = formatTargets(match.targets);
      slotsData[slot.alias] = {
        slot: slot.slot,
        comboId: match.id,
        target: targetStr,
        displayName: match.displayName ?? null,
        active: true,
      };
      textLines.push(`  • ${slot.alias.padEnd(14)} (Slot ${slot.slot}): combo/${match.id} → ${targetStr} [Active]`);
    } else {
      slotsData[slot.alias] = {
        slot: slot.slot,
        active: false,
      };
      textLines.push(`  • ${slot.alias.padEnd(14)} (Slot ${slot.slot}): [Unassigned]`);
    }
  }

  textLines.push(
    "",
    "Remote SSH Configuration:",
    "  1. In ~/.ssh/config on your local machine, add:",
    `       ${sshConfigLine}`,
    "  2. In ~/.codex/config.toml on the remote machine, set:",
    `       openai_base_url = "${codexBaseUrl}"`,
    "  3. In Codex Desktop, select GPT-5.6 Sol, Terra, or Luna to use these mapped models.",
  );

  const payload = {
    slots: slotsData,
    remoteForward: {
      port: effectivePort,
      sshConfig: sshConfigLine,
      codexBaseUrl,
    },
  };

  printData(payload, wantsJson, textLines);
}

async function applyDesktopRemote(args: string[], deps: RuntimeApiDeps): Promise<void> {
  const wantsJson = takeFlag(args, "--json");
  const solTarget = takeOption(args, "--sol")?.trim();
  const terraTarget = takeOption(args, "--terra")?.trim();
  const lunaTarget = takeOption(args, "--luna")?.trim();
  rejectArgs(args, DESKTOP_REMOTE_USAGE);

  deps = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
  const currentCombos = (await runtimeRequest<{ combos?: ComboRow[] }>("/api/combos", {}, deps)).combos ?? [];

  const providersResult = await runtimeRequest<ProviderRow[]>("/api/providers", {}, deps).catch(() => []);
  const availableTargets = discoverAvailableTargets(providersResult);

  const slotTargets: Record<"sol" | "terra" | "luna", string | undefined> = {
    sol: solTarget ?? findExistingTarget(currentCombos, "gpt-5.6-sol") ?? availableTargets.sol,
    terra: terraTarget ?? findExistingTarget(currentCombos, "gpt-5.6-terra") ?? availableTargets.terra,
    luna: lunaTarget ?? findExistingTarget(currentCombos, "gpt-5.6-luna") ?? availableTargets.luna,
  };

  const configuredSlots: Array<{ slot: string; alias: string; comboId: string; target: string }> = [];

  for (const def of DESKTOP_REMOTE_SLOTS) {
    const target = slotTargets[def.slot];
    if (!target) continue;

    const parsed = parseTargets(target, DESKTOP_REMOTE_USAGE);
    const comboPayload = {
      strategy: "failover",
      stickyLimit: 1,
      targets: parsed,
      alias: def.alias,
      nativeAlias: true,
      displayName: `${def.defaultLabel} (${target})`,
    };

    await runtimeRequest("/api/combos", {
      method: "PUT",
      redirect: "error",
      body: serializeManagementJson({ id: def.defaultComboId, combo: comboPayload }),
    }, deps);

    configuredSlots.push({
      slot: def.slot,
      alias: def.alias,
      comboId: def.defaultComboId,
      target,
    });
  }

  if (configuredSlots.length === 0) {
    throw new CliUsageError(
      "No candidate targets found. Specify targets using --sol <target>, --terra <target>, and/or --luna <target>.",
      DESKTOP_REMOTE_USAGE,
    );
  }

  await runtimeRequest("/api/sync", { method: "POST" }, deps).catch(() => {});

  const effectivePort = extractPort(deps.baseUrl) ?? 10100;
  const sshConfigLine = `RemoteForward ${effectivePort} 127.0.0.1:${effectivePort}`;
  const codexBaseUrl = `http://127.0.0.1:${effectivePort}/v1`;

  const textLines: string[] = [
    `Configured ${configuredSlots.length} Codex Desktop remote slot(s):`,
    ...configuredSlots.map(s => `  • ${s.alias.padEnd(14)} → ${s.target} (combo/${s.comboId})`),
    "",
    "Remote SSH Configuration:",
    "  1. In ~/.ssh/config on your local machine, add:",
    `       ${sshConfigLine}`,
    "  2. In ~/.codex/config.toml on the remote machine, set:",
    `       openai_base_url = "${codexBaseUrl}"`,
    "  3. In Codex Desktop, select GPT-5.6 Sol, Terra, or Luna to use these mapped models.",
  ];

  printData(
    { ok: true, configured: configuredSlots, remoteForward: { port: effectivePort, sshConfig: sshConfigLine, codexBaseUrl } },
    wantsJson,
    textLines,
  );
}

async function clearDesktopRemote(args: string[], deps: RuntimeApiDeps): Promise<void> {
  const wantsJson = takeFlag(args, "--json");
  const yes = takeFlag(args, "--yes");
  if (!yes) throw new CliUsageError("clear requires --yes", DESKTOP_REMOTE_USAGE);
  rejectArgs(args, DESKTOP_REMOTE_USAGE);

  deps = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
  const currentCombos = (await runtimeRequest<{ combos?: ComboRow[] }>("/api/combos", {}, deps)).combos ?? [];

  const cleared: string[] = [];
  for (const def of DESKTOP_REMOTE_SLOTS) {
    const toDelete = currentCombos.filter(c => c.id === def.defaultComboId || (c.alias === def.alias && c.nativeAlias === true));
    for (const c of toDelete) {
      if (c.id && !cleared.includes(c.id)) {
        await runtimeRequest(`/api/combos?id=${encodeURIComponent(c.id)}`, { method: "DELETE" }, deps);
        cleared.push(c.id);
      }
    }
  }

  await runtimeRequest("/api/sync", { method: "POST" }, deps).catch(() => {});

  const textLines = cleared.length
    ? [`Cleared ${cleared.length} desktop remote combo(s): ${cleared.join(", ")}. Native catalog slots restored.`]
    : ["No desktop remote combos found to clear."];

  printData({ ok: true, cleared }, wantsJson, textLines);
}

export async function handleDesktopRemoteCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    let action = args[0] && !args[0].startsWith("-") ? args.shift() : "show";
    if (action === "preset") {
      action = args[0] && !args[0].startsWith("-") ? args.shift() : "show";
    }

    if (action === "show" || action === "list" || action === "status") {
      await showDesktopRemote(args, deps);
    } else if (action === "apply" || action === "set") {
      await applyDesktopRemote(args, deps);
    } else if (action === "clear" || action === "remove" || action === "delete") {
      await clearDesktopRemote(args, deps);
    } else {
      throw new CliUsageError(`unknown desktop-remote action "${action}"`, DESKTOP_REMOTE_USAGE);
    }
  });
}
