import type { runCcSwitchProviderImport } from "../providers/cc-switch-import";
import { terminalSafeText } from "./runtime-api";

const USAGE = "Usage: ocx provider import-cc-switch [--source <cc-switch.db|config.json>] [--provider <id>]... [--apply | --restore] [--allow-private-network] [--json]";

export interface CcSwitchImportCommandDeps {
  runImport?: typeof runCcSwitchProviderImport;
}

const SAFE_ERROR_CODES: Readonly<Record<string, string>> = {
  "Stop the opencodex proxy before applying or restoring a CC-Switch provider import.": "proxy_running",
  "Initialize a valid opencodex configuration before importing or restoring providers.": "config_unavailable",
  "An active CC-Switch import journal already exists; run 'ocx provider import-cc-switch --restore' before applying another import.": "active_journal_exists",
  "No CC-Switch provider import journal found to restore.": "journal_missing",
  "Existing CC-Switch import journal is corrupt; inspect or restore before importing.": "journal_corrupt",
  "Existing CC-Switch import journal is unreadable; inspect or restore before importing.": "journal_unreadable",
  "CC-Switch source does not contain one or more requested --provider IDs.": "provider_not_found",
  "CC-Switch SQLite source has uncheckpointed WAL changes (-wal is non-empty); close CC-Switch (or checkpoint the database) and retry.": "sqlite_wal_active",
  "CC-Switch SQLite source has an unreadable WAL file (-wal); close CC-Switch (or checkpoint the database) and retry.": "sqlite_wal_active",
  "CC-Switch SQLite source has an active rollback journal (-journal); close CC-Switch and retry.": "sqlite_journal_active",
  "CC-Switch SQLite source has an unreadable rollback journal (-journal); close CC-Switch and retry.": "sqlite_journal_active",
  "CC-Switch SQLite source has multiple hard links; import the original CC-Switch database path directly.": "sqlite_hardlink_refused",
};

function formatCandidateLine(p: { name: string; sourceId: string; appType: string; adapter: string; baseUrl: string; defaultModel?: string }): string {
  const modelText = terminalSafeText(p.defaultModel ?? "none");
  return `  id=${terminalSafeText(p.name)} (source=${terminalSafeText(p.sourceId)}, ${terminalSafeText(p.appType)} -> ${terminalSafeText(p.adapter)}) model=${modelText} url=${terminalSafeText(p.baseUrl)}`;
}

/** Local-only keyless provider import from CC-Switch SQLite or JSON. */
export async function cmdProviderCcSwitchImport(args: string[], deps: CcSwitchImportCommandDeps = {}): Promise<number> {
  let sourcePath: string | undefined;
  const selectedProviders: string[] = [];
  let apply = false;
  let restore = false;
  let allowPrivateNetwork = false;
  const wantsJson = args.includes("--json");
  const seenBooleans = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--source" || arg === "--provider") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        console.error(USAGE);
        return 1;
      }
      if (arg === "--source") {
        if (sourcePath !== undefined) {
          console.error(USAGE);
          return 1;
        }
        sourcePath = val;
      } else {
        selectedProviders.push(val);
      }
    } else if (arg === "--apply" || arg === "--restore" || arg === "--allow-private-network" || arg === "--json") {
      if (seenBooleans.has(arg)) {
        console.error(USAGE);
        return 1;
      }
      seenBooleans.add(arg);
      if (arg === "--apply") apply = true;
      else if (arg === "--restore") restore = true;
      else if (arg === "--allow-private-network") allowPrivateNetwork = true;
    } else {
      console.error(USAGE);
      return 1;
    }
  }

  if (apply && restore) {
    console.error(USAGE);
    return 1;
  }
  if (restore) {
    if (sourcePath !== undefined || selectedProviders.length > 0 || allowPrivateNetwork) {
      console.error(USAGE);
      return 1;
    }
  } else if (!sourcePath) {
    console.error(USAGE);
    return 1;
  }

  const mode = restore ? "restore" : apply ? "apply" : "preview";
  if (mode !== "preview") {
    const refusal = (await import("./link-child")).linkChildProviderChangeRefusal("ocx provider import-cc-switch");
    if (refusal) {
      if (wantsJson) console.log(JSON.stringify({ error: "link_child_refused", message: refusal }));
      else console.error(refusal);
      return 1;
    }
  } else {
    await (await import("./link-child")).printLinkChildLocalNotice("The CC-Switch provider import preview");
  }

  try {
    const run = deps.runImport ?? (await import("../providers/cc-switch-import")).runCcSwitchProviderImport;
    let printedBeforeWrite = false;
    const result = await run({
      mode,
      sourcePath,
      selectedProviders,
      allowPrivateNetwork,
      ...(apply
        ? {
            onBeforeApplyWrite: providers => {
              const emit = wantsJson ? console.error : console.log;
              printedBeforeWrite = true;
              emit("Importing keyless provider entries (projects allowlisted non-secret metadata only; secret fields are skipped at the byte level and never decoded, written, or logged — verify IDs, models, and URLs from a trusted CC-Switch source before adding credentials):");
              for (const p of providers) {
                emit(formatCandidateLine(p));
              }
            },
          }
        : {}),
    });

    if (result.mode === "restore") {
      if (wantsJson) {
        console.log(JSON.stringify({
          mode: result.mode,
          restored: result.restored,
          restoredNames: result.restoredNames,
          alreadyAbsent: result.alreadyAbsent,
          retainedEdited: result.retainedEdited,
          retainedNames: result.retainedNames,
        }));
      } else {
        console.log(`CC-Switch restore: ${result.restored} removed, ${result.alreadyAbsent} already absent, ${result.retainedEdited} retained (edited or referenced).`);
        if (result.retainedNames.length > 0) {
          console.log(`Retained providers: ${result.retainedNames.map(terminalSafeText).join(", ")}`);
        }
      }
      return 0;
    }

    if (wantsJson) {
      console.log(JSON.stringify({
        mode: result.mode,
        discovered: result.discovered,
        eligible: result.eligible,
        imported: result.imported,
        conflicts: result.conflicts,
        conflictNames: result.conflictNames,
        invalid: result.invalid,
        invalidReasons: result.invalidReasons,
        providers: result.providers,
        ...(apply && result.imported > 0
          ? { trustNotice: "Verify imported baseUrl endpoints come from a trusted CC-Switch source before adding credentials." }
          : {}),
      }));
    } else {
      console.log(`CC-Switch (${result.mode}): ${result.discovered} discovered, ${result.eligible} eligible, ${result.imported} imported, ${result.conflicts} conflicts, ${result.invalid} invalid.`);
      if (!printedBeforeWrite) {
        if (apply && result.imported > 0) {
          console.log("Importing keyless provider entries (projects allowlisted non-secret metadata only; secret fields are skipped at the byte level and never decoded, written, or logged — verify IDs, models, and URLs from a trusted CC-Switch source before adding credentials):");
        }
        for (const p of result.providers) {
          console.log(formatCandidateLine(p));
        }
      }
      if (result.invalid > 0) {
        const reasons = Object.entries(result.invalidReasons).map(([k, v]) => `${k}=${v}`).join(", ");
        console.log(`Invalid reasons: ${reasons}`);
      }
      console.log(apply
        ? (result.imported > 0
          ? "Keyless provider entries saved. Only add credentials to endpoints you trust: start the proxy ('ocx start') and run 'ocx account add-key <provider>' (piped stdin) or 'ocx login <provider>', or undo while stopped with 'ocx provider import-cc-switch --restore'."
          : "No eligible non-conflicting providers were imported; configuration and journal are unchanged.")
        : "Preview only (projects allowlisted non-secret metadata only; secret fields are skipped at the byte level and never decoded, written, or logged). Verify IDs, models, and destination URLs from a trusted source and stop the proxy before repeating with --apply.");
    }
    return result.invalid > 0 && result.eligible === 0 ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const code = SAFE_ERROR_CODES[msg] ?? "cc_switch_import_failed";
    const safeMsg = SAFE_ERROR_CODES[msg] || msg.startsWith("CC-Switch ")
      ? terminalSafeText(msg)
      : "CC-Switch provider import failed. Verify the source file, destination config, and stopped proxy.";
    if (wantsJson) console.log(JSON.stringify({ error: code, message: safeMsg }));
    else console.error(safeMsg);
    return 1;
  }
}
