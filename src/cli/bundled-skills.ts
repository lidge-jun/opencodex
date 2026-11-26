import { parseArgs } from "node:util";
import { packageVersion } from "../lib/package-version";
import guide from "../../skills/ocx/SKILL.md" with { type: "text" };
import management from "../../skills/ocx/references/01_management_surface.md" with { type: "text" };
import access from "../../skills/ocx/references/01_surface_access-remote.md" with { type: "text" };
import accounts from "../../skills/ocx/references/01_surface_accounts.md" with { type: "text" };
import agents from "../../skills/ocx/references/01_surface_agents-routing.md" with { type: "text" };
import integrations from "../../skills/ocx/references/01_surface_integrations.md" with { type: "text" };
import lab from "../../skills/ocx/references/01_surface_lab.md" with { type: "text" };
import lifecycle from "../../skills/ocx/references/01_surface_lifecycle.md" with { type: "text" };
import observe from "../../skills/ocx/references/01_surface_observe-system.md" with { type: "text" };
import providers from "../../skills/ocx/references/01_surface_providers-models.md" with { type: "text" };
import json from "../../skills/ocx/references/02_json_shapes.md" with { type: "text" };
import recipes from "../../skills/ocx/references/03_recipes.md" with { type: "text" };
import failures from "../../skills/ocx/references/04_failure_semantics.md" with { type: "text" };
import hub from "../../skills/ocx/references/05_remote_hub.md" with { type: "text" };

// Static text imports preserve the same files in npm and in Bun-compiled standalone builds.
const references = new Map([
  ["01_management_surface", management],
  ["01_surface_access-remote", access],
  ["01_surface_accounts", accounts],
  ["01_surface_agents-routing", agents],
  ["01_surface_integrations", integrations],
  ["01_surface_lab", lab],
  ["01_surface_lifecycle", lifecycle],
  ["01_surface_observe-system", observe],
  ["01_surface_providers-models", providers],
  ["02_json_shapes", json],
  ["03_recipes", recipes],
  ["04_failure_semantics", failures],
  ["05_remote_hub", hub],
]);

function usageError(hint = "ocx help skills"): 2 {
  console.error(`Invalid skill request. See: ${hint}`);
  return 2;
}

export async function runBundledSkills(args: string[]): Promise<number> {
  const action = args[0] ?? "list";
  if (action !== "list" && action !== "get") return usageError();
  let parsed;
  try {
    parsed = parseArgs({
      args: args.slice(1), allowPositionals: true,
      options: {
        json: { type: "boolean" },
        reference: { type: "string" },
        references: { type: "boolean" },
      },
    });
  } catch {
    return usageError(`ocx help skills ${action}`);
  }
  const { positionals, values } = parsed;
  const name = "ocx";
  const version = packageVersion();
  const description = "Operate OpenCodex: configuration, providers, accounts, models, routing and diagnostics.";
  if (action === "list") {
    if (positionals.length || values.reference !== undefined || values.references) return usageError("ocx help skills list");
    console.log(values.json ? JSON.stringify({ version, skills: [{ name, description }] }) : `${name}\t${description}`);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== name) return usageError("ocx skills list");
  if (values.references && values.reference !== undefined) return usageError("ocx help skills get");
  if (values.references) {
    const files = [...references.keys()].map(ref => `references/${ref}.md`);
    console.log(values.json ? JSON.stringify({ name, version, references: files }) : files.join("\n"));
    return 0;
  }
  // Match only a bundled id. No filesystem path is constructed from an operand.
  const ref = values.reference?.replace(/^references\//, "").replace(/\.md$/, "");
  const markdown = ref === undefined ? guide : references.get(ref);
  if (markdown === undefined) return usageError("ocx skills get ocx --references");
  const file = ref === undefined ? "SKILL.md" : `references/${ref}.md`;
  const output = values.json ? `${JSON.stringify({ name, version, file, markdown })}\n` : markdown;
  // The CLI exits explicitly after dispatch. Wait for a piped consumer to drain large references.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, error => error ? reject(error) : resolve());
  });
  return 0;
}
