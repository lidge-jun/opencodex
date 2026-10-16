/** Runtime-owned Desktop profile editing. Saving never applies a native configuration. */
import { DESKTOP_FAMILIES, parseDesktopProfile, type DesktopProfile } from "../claude/desktop-profile";
import { runCatalogAction } from "./catalog-command-result";
import { readJsonInput, serializeManagementJson } from "./json-input";
import { CliUsageError, printData, runtimeRequest, takeFlag, type RuntimeApiDeps } from "./runtime-api";

export interface DesktopProfileCliDeps extends RuntimeApiDeps {
  runtimeRequestImpl?: typeof runtimeRequest;
}

const USAGE = "Usage: ocx claude desktop profile show [--json]\n       ocx claude desktop profile import FILE|- [--json]";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Desktop state");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.length) throw new Error("Invalid Desktop text");
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid Desktop flag");
  return value;
}

function modelIdentity(row: Record<string, unknown>) {
  const route = text(row.route);
  if (!route.includes("/")) throw new Error("Invalid Desktop route");
  if (row.contextWindow !== undefined && (typeof row.contextWindow !== "number"
    || !Number.isSafeInteger(row.contextWindow) || row.contextWindow <= 0)) throw new Error("Invalid Desktop context window");
  return { route, label: text(row.label), ...(row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow as number }) };
}

function desktopState(raw: unknown, saved: boolean) {
  const value = record(raw);
  if (saved && value.ok !== true) throw new Error("Desktop save was not confirmed");
  const profile = parseDesktopProfile(value.profile);
  if (!Array.isArray(value.models) || !Array.isArray(value.rendered)
    || !Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) {
    throw new Error("Invalid Desktop state");
  }
  const seen = new Set<string>();
  const models = value.models.map(rawModel => {
    const row = record(rawModel), identity = modelIdentity(row), assignment = record(row.assignment);
    const expected = profile.assignments[identity.route];
    if (!expected || seen.has(identity.route) || assignment.family !== expected.family || assignment.alias !== expected.alias) {
      throw new Error("Invalid Desktop assignment");
    }
    seen.add(identity.route);
    return { ...identity, available: boolean(row.available), effortSupported: boolean(row.effortSupported),
      supports1m: boolean(row.supports1m), assignment: { family: expected.family, alias: expected.alias } };
  });
  if (seen.size !== Object.keys(profile.assignments).length) throw new Error("Incomplete Desktop models");
  const renderedSeen = new Set<string>();
  const rendered = value.rendered.map(rawModel => {
    const row = record(rawModel), identity = modelIdentity(row);
    if (!DESKTOP_FAMILIES.includes(row.family as typeof DESKTOP_FAMILIES[number])
      || profile.assignments[identity.route]?.family !== row.family || renderedSeen.has(identity.route)
      || !models.some(model => model.route === identity.route && model.available)) throw new Error("Invalid rendered Desktop model");
    renderedSeen.add(identity.route);
    return { ...identity, name: text(row.name), family: row.family as typeof DESKTOP_FAMILIES[number],
      isFamilyDefault: boolean(row.isFamilyDefault), supports1m: boolean(row.supports1m) };
  });
  if (renderedSeen.size !== models.filter(model => model.available).length) throw new Error("Incomplete rendered Desktop models");
  return { ...(saved ? { ok: true as const } : {}), profile, models, rendered, port: value.port as number };
}

/** Arguments start immediately after `claude desktop profile`. */
export async function handleClaudeDesktopProfileCommand(argv: string[], deps: DesktopProfileCliDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv], wantsJson = takeFlag(args, "--json");
    const action = args.shift();
    if ((action !== "show" && action !== "import") || (action === "show" && args.length !== 0)
      || (action === "import" && (args.length !== 1 || !args[0]?.trim() || (args[0]!.startsWith("-") && args[0] !== "-")))) {
      throw new CliUsageError("Desktop profile accepts show or import with an explicit file or '-'. Saving and applying are separate actions.", USAGE);
    }
    let body: string | undefined;
    if (action === "import") {
      const input = await readJsonInput(args[0]!, deps);
      let profile: DesktopProfile;
      try { profile = parseDesktopProfile(input); }
      catch { throw new CliUsageError("Desktop profile input is invalid. Supply a version-1 profile with valid assignments and family defaults."); }
      body = serializeManagementJson({ profile });
    }
    const raw = await (deps.runtimeRequestImpl ?? runtimeRequest)("/api/claude-desktop", {
      method: action === "show" ? "GET" : "PUT", redirect: "error",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
    }, deps);
    const state = desktopState(raw, action === "import");
    printData(state, wantsJson, [
      action === "import" ? "Desktop profile saved on the selected proxy. It has not been applied by this command." : "Desktop profile on the selected proxy.",
      `Models: ${state.models.length}; available: ${state.models.filter(model => model.available).length}; port: ${state.port}`,
      ...DESKTOP_FAMILIES.map(family => `${family}: ${state.profile.defaults[family] ?? "none"}`),
      ...(action === "import" ? ["Next: review with ocx claude desktop profile show; apply separately with ocx claude desktop apply."] : []),
    ]);
    return 0;
  });
}
