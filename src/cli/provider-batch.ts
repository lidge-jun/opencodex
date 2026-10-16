import { parseProviderEditorConfigDTO } from "../server/auth-cors";
import { readJsonInput, serializeManagementJson } from "./json-input";
import { printProviderReceipt, runProviderAction } from "./provider-result";
import {
  CliUsageError, printData, runtimeBaseUrl, runtimeRequest, takeFlag,
  takeOptionWithSyntax, type RuntimeApiDeps,
} from "./runtime-api";

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function editorInput(value: unknown) {
  const parsed = parseProviderEditorConfigDTO(value);
  if (!parsed.ok) throw new CliUsageError("Provider batch input must be an editable provider snapshot without secret, derived or unknown fields.");
  return parsed.value;
}

async function snapshot(wantsJson: boolean, deps: RuntimeApiDeps): Promise<number> {
  const baseUrl = await runtimeBaseUrl(deps);
  const fetched = await runtimeRequest("/api/config", { method: "GET", redirect: "error" }, { ...deps, baseUrl });
  if (!record(fetched) || !record(fetched.providers)) throw new Error("Invalid provider snapshot response.");
  const entries = Object.entries(fetched.providers).map(([name, provider]) => {
    if (!record(provider)) throw new Error("Invalid provider snapshot response.");
    // These are the four dashboard decorations, not editor fields. Any other
    // unexpected field must reach the canonical parser and fail closed.
    const { hasApiKey, hasHeaders, xaiResponsesOptInState, initialModelSelection, ...editable } = provider;
    return [name, editable] as const;
  });
  const parsed = parseProviderEditorConfigDTO({
    defaultProvider: fetched.defaultProvider,
    providers: Object.fromEntries(entries),
  });
  if (!parsed.ok) throw new Error("Invalid provider snapshot response.");
  printData(parsed.value, wantsJson);
  return 0;
}

async function apply(args: string[], wantsJson: boolean, deps: RuntimeApiDeps): Promise<number> {
  const baselinePath = takeOptionWithSyntax(args, "--baseline")?.value;
  const nextPath = takeOptionWithSyntax(args, "--file")?.value;
  const confirmed = takeFlag(args, "--yes");
  if (args.length || !baselinePath?.trim() || !nextPath?.trim()) {
    throw new CliUsageError("Provider apply requires --baseline FILE and --file FILE, with optional --yes and --json.");
  }
  if (baselinePath === "-" && nextPath === "-") {
    throw new CliUsageError("Provider apply accepts at most one stdin source.");
  }
  // Parse both documents as supplied: normalizing a public baseline would
  // change the server's CAS comparison and can discard unseen private data.
  const baseline = editorInput(await readJsonInput(baselinePath, deps, "Provider baseline"));
  const next = editorInput(await readJsonInput(nextPath, deps, "Provider next snapshot"));
  if (!confirmed && Object.keys(baseline.providers).some(name => !Object.hasOwn(next.providers, name))) {
    throw new CliUsageError("Provider removals or renames require --yes. Batch apply does not perform single-provider DELETE OAuth account cleanup.");
  }
  const body = serializeManagementJson({ baseline, next });
  const baseUrl = await runtimeBaseUrl(deps);
  const result = await runtimeRequest("/api/providers", {
    method: "PUT", redirect: "error", headers: { "content-type": "application/json" }, body,
  }, { ...deps, baseUrl });
  return printProviderReceipt(result, wantsJson, "Provider batch");
}

/** Public editor snapshots and one server-authoritative compare-and-swap. */
export async function handleProviderBatchCommand(
  sub: "snapshot" | "apply", args: string[], deps: RuntimeApiDeps = {},
): Promise<number> {
  return runProviderAction(async () => {
    const argv = [...args];
    const wantsJson = takeFlag(argv, "--json");
    if (sub === "apply") return apply(argv, wantsJson, deps);
    if (argv.length) throw new CliUsageError("Provider snapshot accepts only --json.");
    return snapshot(wantsJson, deps);
  });
}
