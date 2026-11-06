import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EXPORT_CLIENT_IDS } from "../../src/clients/client-ids";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import {
  MatrixError,
  NATIVE_ROSTER_FILE,
  collectRows,
  defaultInputs,
  parseNativeRoster,
  renderAll,
  type MatrixInputs,
} from "../../scripts/generate-client-support-matrix";
import { EXPORT_CLIENT_METADATA, NATIVE_CLIENT_METADATA } from "../../scripts/client-support-matrix/metadata";
import { LOCALES } from "../../scripts/client-support-matrix/locales";
import { repoPath } from "../helpers/repo-root";

const BASE = defaultInputs();

/** Collect with one input replaced and return the reported problems ([] when generation succeeds). */
function problemsWith(change: Partial<MatrixInputs>): string[] {
  try {
    collectRows({ ...BASE, ...change });
    return [];
  } catch (error) {
    if (!(error instanceof MatrixError)) throw error;
    return [...error.problems];
  }
}

function withFile(path: string, rewrite: (text: string) => string): MatrixInputs["readRepoFile"] {
  return file => {
    const text = BASE.readRepoFile(file);
    return file === path && text !== undefined ? rewrite(text) : text;
  };
}

function withDocument(id: string, rewrite: (document: any) => unknown): MatrixInputs["buildDocument"] {
  return client => {
    const document = BASE.buildDocument(client);
    return client === id ? rewrite(structuredClone(document)) : document;
  };
}

describe("client support matrix", () => {
  test("every committed locale page matches the generator", () => {
    for (const [path, expected] of Object.entries(renderAll())) {
      expect(readFileSync(repoPath(path), "utf8"), `${path} is stale; run bun run docs:clients`).toBe(expected);
    }
  });

  test("every locale defines exactly the root locale's strings", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      value !== null && typeof value === "object"
        ? Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key))
        : [prefix];
    const root = keys(LOCALES.root).sort();
    for (const [locale, strings] of Object.entries(LOCALES)) {
      expect(keys(strings).sort(), locale).toEqual(root);
      for (const key of keys(strings)) {
        const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], strings);
        expect(typeof value === "string" && value.trim().length > 0, `${locale}.${key}`).toBe(true);
      }
    }
  });

  test("rows cover the export roster, the managed integrations and the native union", () => {
    const rows = collectRows();
    const nativeIds = parseNativeRoster(readFileSync(repoPath(NATIVE_ROSTER_FILE), "utf8"));
    expect(rows.map(row => row.id).sort()).toEqual([...EXPORT_CLIENT_IDS, ...nativeIds].sort());
    expect(rows.filter(row => row.managed).map(row => row.id).sort()).toEqual(Object.keys(INTEGRATION_CLIENTS).sort());
    expect(rows.filter(row => row.native).map(row => row.id).sort()).toEqual([...nativeIds].sort());
  });

  test("a new export client without metadata fails with its id", () => {
    const problems = problemsWith({
      exportIds: [...EXPORT_CLIENT_IDS, "newtool"],
      exportSpecs: { ...BASE.exportSpecs, newtool: { format: "json", loopbackOnly: true } },
    });
    expect(problems).toContain("newtool: export client without metadata; add it to EXPORT_CLIENT_METADATA");
  });

  test("a managed integration outside the export roster cannot drop out of the page", () => {
    const problems = problemsWith({ integrationSpecs: { ...BASE.integrationSpecs, orphan: {} } });
    expect(problems.some(problem => problem.startsWith("orphan: managed file integration without an export registry entry"))).toBe(true);
  });

  test("native union additions, removals and reshapes all fail", () => {
    const declaration = /^export type NativeIntegrationClientId = .+;$/m;
    const added = problemsWith({ readRepoFile: withFile(NATIVE_ROSTER_FILE, text => text.replace(declaration, m => m.replace(";", ' | "newnative";'))) });
    expect(added).toContain("newnative: native integration owner without metadata; add it to NATIVE_CLIENT_METADATA");
    const removed = problemsWith({ readRepoFile: withFile(NATIVE_ROSTER_FILE, text => text.replace(declaration, m => m.replace(' | "grok"', ""))) });
    expect(removed).toContain("grok: native metadata for an owner that is no longer in NativeIntegrationClientId; remove it");
    const reshaped = problemsWith({ readRepoFile: withFile(NATIVE_ROSTER_FILE, text => text.replace(declaration, "export type NativeIntegrationClientId = (typeof NATIVE_IDS)[number];")) });
    expect(reshaped.some(problem => problem.includes("not a pure string-literal union"))).toBe(true);
  });

  test("protocol fields must exist and carry a known value", () => {
    const changed = problemsWith({ buildDocument: withDocument("mcode", doc => { doc.custom_provider.opencodex.api = "openai-responses-next"; return doc; }) });
    expect(changed).toContain('mcode: custom_provider.opencodex.api = "openai-responses-next" is not a protocol value this matrix knows');
    const moved = problemsWith({ buildDocument: withDocument("cline", doc => { delete doc.catalog; return doc; }) });
    expect(moved).toContain("cline: protocol field catalog.providers.opencodex.provider.protocol is missing from the generated config");
  });

  test("a protocol field missing on one matched entry fails even when another entry has it", () => {
    const partial = problemsWith({ buildDocument: withDocument("workbuddy", doc => { delete doc.models[0].url; return doc; }) });
    expect(partial).toContain("workbuddy: protocol field models.*.url is missing from 1 matched entry");
  });

  test("the OMP Responses override is checked model by model", () => {
    const swapped = problemsWith({
      buildDocument: withDocument("omp", doc => {
        for (const model of doc.providers.opencodex.models) {
          if (model.api) delete model.api;
          else model.api = "openai-responses";
        }
        return doc;
      }),
    });
    expect(swapped).toContain("omp: the native OpenAI model no longer carries api = openai-responses");
    expect(swapped.some(problem => problem.startsWith("omp: model anthropic/claude-opus-4-8 carries api"))).toBe(true);
  });

  test("curated claims fail when the reviewed source changes", () => {
    const raycast = EXPORT_CLIENT_METADATA.raycast!.clientSelected!;
    const edited = problemsWith({ readRepoFile: withFile(raycast.file, text => text + "\n// edited\n") });
    expect(edited.some(problem => problem.startsWith("raycast: src/clients/config-export/raycast.ts changed since its protocol was reviewed"))).toBe(true);
    const grok = NATIVE_CLIENT_METADATA.grok!.anchors[0]!;
    const gone = problemsWith({ readRepoFile: withFile(grok.file, text => text.replace(grok.text, "")) });
    expect(gone.some(problem => problem.startsWith("grok: reviewed code"))).toBe(true);
    const codex = NATIVE_CLIENT_METADATA.codex!.anchors[0]!;
    const commentedOut = problemsWith({ readRepoFile: withFile(codex.file, text => text.replace(codex.text, `"replaced"; // ${codex.text}`)) });
    expect(commentedOut.some(problem => problem.startsWith("codex: reviewed code"))).toBe(true);
  });

  test("a test reference must be a single enabled case that names the client", () => {
    const ref = EXPORT_CLIENT_METADATA.prime!.test!;
    const quoted = JSON.stringify(ref.title);
    const renamed = problemsWith({ readRepoFile: withFile(ref.file, text => text.replace(quoted, JSON.stringify(ref.title + " (renamed)"))) });
    expect(renamed).toContain(`prime: ${ref.file} has no single test titled ${quoted}`);
    // Assembled at runtime: the PR hygiene gate rejects a literal disabled-suite call in an added line.
    const disabledSuite = ["describe", "skip"].join(".");
    const skipped = problemsWith({ readRepoFile: withFile(ref.file, text => `${disabledSuite}("hidden", () => {});\n${text}`) });
    expect(skipped).toContain(`prime: ${ref.file} uses skip/todo/only/conditional modifiers; link a test from a file without them`);
    const incidental = `test(${quoted}, () => {\n  // exercises prime\n  /* Prime */\n  expect(1).toBe(1);\n});\n`;
    const comment = problemsWith({ readRepoFile: file => (file === ref.file ? incidental : BASE.readRepoFile(file)) });
    expect(comment).toContain(`prime: test ${quoted} does not mention prime or Prime`);
  });

  test("the inbound endpoints listed on the page are admitted routes", () => {
    const routes = new Set(BASE.inboundRoutes);
    routes.delete("/v1/messages");
    expect(problemsWith({ inboundRoutes: routes })).toContain("inbound route /v1/messages is no longer admitted; update ENDPOINTS");
  });
});
