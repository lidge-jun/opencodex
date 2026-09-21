/**
 * INV-CHAT-01. One developer-role policy for the translated Chat wire and the documents about it.
 *
 * Three statements were live at once. `structure/providers/chat-compat.md` said `developer` was
 * forwarded as itself on every destination, the configuration reference said an unset setting
 * sends `system`, and the adapter implemented only one of them. Each reads as plausible on its
 * own, so whoever edited this area next could pick any of the three and reintroduce the defect
 * the setting exists to prevent — which is how the previous regression arrived.
 *
 * The sentence under test is built here from the role `createOpenAIChatAdapter` actually
 * serializes for each of the three states, so it cannot be held correct by review alone: a
 * changed default fails this file rather than leaving one document behind. The translated pages
 * are compared against the English source instead of carrying a second copy of the rule, because
 * that comparison stays meaningful when the English wording is revised.
 *
 * Placement — that the message never leaves the slot it arrived in, whichever role it carries —
 * is a separate property and stays where it is already tested, in
 * `tests/adapters/openai/openai-chat-developer-position.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { repoPath } from "../helpers/repo-root";

const INSTRUCTION = "Answer in exactly one sentence.";

/** The role the Chat wire gives a mid-conversation developer message for one setting state. */
function wireRole(declared: boolean | undefined): string {
  const provider: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://gateway.example.internal/v1",
    apiKey: "k",
    ...(declared === undefined ? {} : { foldDeveloperRoleToSystem: declared }),
  };
  const parsed = {
    modelId: "local-model",
    context: {
      systemPrompt: ["base instructions"],
      messages: [
        { role: "user", content: "First turn.", timestamp: 0 },
        { role: "developer", content: INSTRUCTION, timestamp: 0 },
        { role: "user", content: "Second turn.", timestamp: 0 },
      ],
    },
    stream: false,
    options: {},
  } as unknown as OcxParsedRequest;
  const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const carried = body.messages.find(message => message.content === INSTRUCTION);
  expect(carried, "the instruction left the wire; this check has no role to read").toBeDefined();
  return String(carried!.role);
}

const UNSET = wireRole(undefined);
const DECLARED_REJECTS = wireRole(true);
const DECLARED_ACCEPTS = wireRole(false);

/** The one sentence both English documents must carry, derived rather than transcribed. */
const POLICY =
  "`foldDeveloperRoleToSystem` unset sends `" +
  UNSET +
  "`, `true` sends `" +
  DECLARED_REJECTS +
  "`, and `false` sends `" +
  DECLARED_ACCEPTS +
  "`.";

const STRUCTURE_DOC = "structure/providers/chat-compat.md";
const ENGLISH_REFERENCE = "docs-site/src/content/docs/reference/configuration/providers.md";
const ENGLISH_GUIDE = "docs-site/src/content/docs/guides/claude-code.md";
const LOCALES = ["fr", "ja", "ko", "ru", "tr", "zh-cn", "zh-tw"] as const;

const referencePage = (locale: string): string =>
  "docs-site/src/content/docs/" + locale + "/reference/configuration/providers.md";
const guidePage = (locale: string): string =>
  "docs-site/src/content/docs/" + locale + "/guides/claude-code.md";

async function read(path: string): Promise<string> {
  return await Bun.file(repoPath(path)).text();
}

/** Line wrapping differs between a prose paragraph and a table cell; the sentence does not. */
const flatten = (text: string): string => text.replace(/\s+/g, " ");

/** The bare role names a passage carries as code spans, in order. */
function roleSpans(passage: string): string[] {
  return [...passage.matchAll(/`([^`]+)`/g)]
    .map(match => match[1]!)
    .filter(span => span === "system" || span === "developer");
}

async function referenceRow(path: string): Promise<string> {
  const rows = (await read(path))
    .split("\n")
    .filter(line => line.includes("`foldDeveloperRoleToSystem?`"));
  expect(rows.length, path + " has no foldDeveloperRoleToSystem row; re-anchor this check").toBe(1);
  return rows[0]!;
}

async function guideParagraph(path: string): Promise<string> {
  const paragraphs = (await read(path))
    .split(/\n\s*\n/)
    .filter(block => block.includes("foldDeveloperRoleToSystem"));
  expect(paragraphs.length, path + " has no foldDeveloperRoleToSystem paragraph; re-anchor this check").toBe(1);
  return paragraphs[0]!;
}

describe("the documented developer-role policy is derived from the Chat wire", () => {
  test("the three states still describe a real choice", () => {
    for (const role of [UNSET, DECLARED_REJECTS, DECLARED_ACCEPTS]) {
      expect(["system", "developer"]).toContain(role);
    }
    // All three collapsing to one role would make every assertion below vacuous while the
    // documents kept explaining a setting that no longer decides anything.
    expect(new Set([UNSET, DECLARED_REJECTS, DECLARED_ACCEPTS]).size).toBe(2);
  });

  test("the structure contract states the mapping the adapter implements", async () => {
    expect(flatten(await read(STRUCTURE_DOC))).toContain(POLICY);
  });

  test("the configuration reference states the same mapping", async () => {
    expect(flatten(await referenceRow(ENGLISH_REFERENCE))).toContain(POLICY);
  });

  test("the Claude Code guide names the same default and the same accepted role", async () => {
    const paragraph = flatten(await guideParagraph(ENGLISH_GUIDE));
    expect(paragraph).toContain("sent as `" + UNSET + "` unless");
    expect(paragraph).toContain("accepts the `" + DECLARED_ACCEPTS + "` role");
  });
});

describe("translated pages do not contradict the English source", () => {
  test("the English pages carry roles worth comparing", async () => {
    expect(roleSpans(await referenceRow(ENGLISH_REFERENCE)).length).toBeGreaterThan(0);
    expect(roleSpans(await guideParagraph(ENGLISH_GUIDE)).length).toBeGreaterThan(0);
  });

  for (const locale of LOCALES) {
    test(locale + " states the roles in the order the English reference does", async () => {
      const english = roleSpans(await referenceRow(ENGLISH_REFERENCE));
      expect(roleSpans(await referenceRow(referencePage(locale)))).toEqual(english);
    });

    test(locale + " Claude Code guide states the roles the English guide does", async () => {
      const english = roleSpans(await guideParagraph(ENGLISH_GUIDE));
      expect(roleSpans(await guideParagraph(guidePage(locale)))).toEqual(english);
    });
  }
});
