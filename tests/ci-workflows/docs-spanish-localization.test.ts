import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { FRONTIER_STRINGS } from "../../docs-site/src/data/frontier-i18n";
import { codeBlockLocale } from "../../docs-site/src/data/code-block-locale";

const root = repoPath("docs-site/src/content/docs");
const source = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const config = source(repoPath("docs-site/astro.config.mjs"));
// Use the configured locale directories rather than freezing today's page count.
const localeFolders = new Set([...config.matchAll(/^\s*["']?([a-z]{2}(?:-[a-z]{2})?)["']?:\s*\{\s*label:/gm)]
  .map(match => match[1]!));
/** List Markdown pages, excluding configured translation trees only at the canonical root. */
function pages(directory: string, canonical = false): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory() && canonical && localeFolders.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? pages(path).map(child => `${entry.name}/${child}`)
      : /\.mdx?$/.test(entry.name) ? [entry.name] : [];
  }).sort();
}
/** Locate quoted or indented fences; a close needs the same marker and at least its opening length. */
function fencedBlocks(markdown: string): { start: number; end: number; content: string }[] {
  const lines = [...markdown.matchAll(/[^\n]*(?:\n|$)/g)].filter(line => line[0].length);
  const blocks: { start: number; end: number; content: string }[] = [];
  const unquote = (line: string): string => line.replace(/^(?:[ \t]*>[ \t]?)+/, "");
  const quoteDepth = (line: string): number => (line.match(/^(?:[ \t]*>[ \t]?)+/)?.[0].match(/>/g) ?? []).length;
  for (let i = 0; i < lines.length; i++) {
    const depth = quoteDepth(lines[i]![0]);
    const opening = /^[ \t]*(`{3,}|~{3,})([^\n]*)\n?$/.exec(unquote(lines[i]![0]));
    if (!opening || (opening[1]![0] === "`" && opening[2]!.includes("`"))) continue;
    const start = lines[i]!.index!;
    const contentStart = start + lines[i]![0].length;
    let closing = i + 1;
    for (; closing < lines.length; closing++) {
      if (quoteDepth(lines[closing]![0]) !== depth) continue;
      const fence = /^[ \t]*(`+|~+)[ \t]*\n?$/.exec(unquote(lines[closing]![0]))?.[1];
      if (fence?.[0] === opening[1]![0] && fence.length >= opening[1]!.length) break;
    }
    const contentEnd = lines[closing]?.index ?? markdown.length;
    const end = closing < lines.length ? contentEnd + lines[closing]![0].length : markdown.length;
    blocks.push({ start, end, content: markdown.slice(contentStart, contentEnd) });
    i = closing;
  }
  return blocks;
}
/** Preserve fenced example bytes so translations cannot silently change executable commands. */
function codeBlocks(markdown: string): string[] {
  return fencedBlocks(markdown).map(block => block.content);
}
/** Remove the same detected fence ranges before checking identifiers in translated prose. */
function withoutFencedCode(markdown: string): string {
  let prose = "", previous = 0;
  for (const block of fencedBlocks(markdown)) {
    prose += markdown.slice(previous, block.start) + "\n";
    previous = block.end;
  }
  return prose + markdown.slice(previous);
}
/** Read prose code spans, respecting escaped openers, matching backtick runs and wrapped lines. */
function inlineCode(markdown: string): Set<string> {
  const prose = withoutFencedCode(markdown);
  const values = new Set<string>();
  const escaped = (at: number): boolean => {
    let slashes = 0;
    for (let i = at - 1; i >= 0 && prose[i] === "\\"; i--) slashes++;
    return slashes % 2 === 1;
  };
  for (let at = 0; at < prose.length; at++) {
    if (prose[at] !== "`" || escaped(at)) continue;
    let length = 1;
    while (prose[at + length] === "`") length++;
    const closing = new RegExp("(?<!`)`{" + length + "}(?!`)", "g");
    closing.lastIndex = at + length;
    // Backslashes are literal inside code spans, including immediately before the closing run.
    const match = closing.exec(prose);
    if (!match || /\n[ \t]*\n/.test(prose.slice(at + length, match.index))) { at += length - 1; continue; }
    // Markdown code spans can cross lines; their rendered whitespace is normalized.
    values.add(prose.slice(at + length, match.index).replace(/\s*\n\s*/g, " ").trim());
    at = match.index + length - 1;
  }
  return values;
}
/** Find exact canonical code identifiers absent from the translation, across all model families. */
function missingInlineIdentifiers(english: string, spanish: string): string[] {
  const translated = inlineCode(spanish);
  return [...inlineCode(english)].filter(value => !translated.has(value));
}

describe("Spanish documentation localization", () => {
  test("code spans keep a trailing backslash literal without swallowing later identifiers", () => {
    const english = "Paths `~\\` and `~/` keep `models` unchanged.";
    const spanish = "Las rutas `~\\` y `~/` conservan `models`.";
    expect([...inlineCode(english)]).toEqual(["~\\", "~/", "models"]);
    expect(missingInlineIdentifiers(english, spanish)).toEqual([]);
    expect(missingInlineIdentifiers(english, spanish.replace("`~\\`", "`wrong-path`"))).toEqual(["~\\"]);
    expect(missingInlineIdentifiers(english, spanish.replace("`models`", "`other-models`"))).toEqual(["models"]);
    expect([...inlineCode("\\`ordinary prose\\` then `models`.")]).toEqual(["models"]);
  });

  test("code-block controls use the content locale on Windows and POSIX", () => {
    expect(codeBlockLocale({ path: "C:\\Work\\Docs Site\\src\\content\\docs\\es\\guides\\pi.md" })).toBe("es");
    expect(codeBlockLocale({ url: new URL("file:///C:/Work/Docs%20Site/src/content/docs/es/guides/pi.md") })).toBe("es");
    expect(codeBlockLocale({ path: "/workspace/docs-site/src/content/docs/zh-cn/guides/pi.md" })).toBe("zh-CN");
    expect(codeBlockLocale({ url: new URL("https://opencodex.me/es/guides/pi/") })).toBe("es");
    expect(codeBlockLocale({ path: "/workspace/docs-site/src/content/docs/guides/pi.md" })).toBe("en");
    expect(codeBlockLocale({})).toBe("en");
    expect(config).toContain("getBlockLocale");
  });

  test("compares list-indented command fences and excludes them from inline prose", () => {
    for (const [indent, fence] of [["", "```"], ["  ", "```"], ["   ", "~~~"], ["\t", "````"]]) {
      const canonical = ["1. Run `droid exec`:", "", `${indent}${fence}bash`,
        `${indent}droid exec --model glm-5.2 'Reply with DROID_OK only.'`,
        `${indent}printf '\`fenced-code-only\`'`, `${indent}${fence}`, ""].join("\n");
      expect(codeBlocks(canonical)).toHaveLength(1);
      expect(codeBlocks(canonical.replace("glm-5.2", "wrong-model"))).not.toEqual(codeBlocks(canonical));
      expect([...inlineCode(canonical)]).toEqual(["droid exec"]);
    }
  });

  test("longer closing fences cannot hide changed commands or leak code into prose", () => {
    for (const indent of ["", "  ", "   ", "\t"]) {
      for (const marker of ["`", "~"]) {
        const markdown = ["Run `ocx export`:", "", `${indent}${marker.repeat(3)}bash`,
          `${indent}ocx export --client pi`, `${indent}echo '\`code-only\`'`,
          `${indent}${marker.repeat(4)}`, "", "Then use `models.json`."].join("\n");
        expect(codeBlocks(markdown)).toHaveLength(1);
        expect(codeBlocks(markdown.replace("--client pi", "--client wrong"))).not.toEqual(codeBlocks(markdown));
        expect([...inlineCode(markdown)]).toEqual(["ocx export", "models.json"]);
        expect(withoutFencedCode(markdown)).not.toContain("code-only");
      }
    }
  });

  test("shorter or mixed fences stay inside the block and an unclosed block reaches EOF", () => {
    for (const marker of ["`", "~"]) {
      const other = marker === "`" ? "~" : "`";
      const body = ["ocx start", marker.repeat(3), other.repeat(5), "echo '`code-only`'", ""].join("\n");
      const opening = marker.repeat(4) + "bash\n";
      expect(codeBlocks(opening + body + marker.repeat(4) + "\n")).toEqual([body]);
      expect(codeBlocks(opening + body)).toEqual([body]);
      expect([...inlineCode(opening + body)]).toEqual([]);
    }
    expect(codeBlocks("```not `an opening`\nordinary prose\n")).toEqual([]);
  });

  test("checks commands inside quoted examples and removes them from prose", () => {
    const markdown = ["Read `config.json`:", "", "> ```bash", "> ocx start", "> echo '`quoted-code`'", "> ````", ""].join("\n");
    expect(codeBlocks(markdown)).toEqual(["> ocx start\n> echo '`quoted-code`'\n"]);
    expect(codeBlocks(markdown.replace("ocx start", "ocx wrong"))).not.toEqual(codeBlocks(markdown));
    expect([...inlineCode(markdown)]).toEqual(["config.json"]);
  });

  test("closing fences must match the opening quote context", () => {
    for (const quote of ["", "> ", "> > "]) {
      for (const marker of ["`", "~"]) {
        const fence = marker.repeat(3);
        const body = [`${quote}> ${fence}`, `${quote}ocx start`, `${quote}echo '\`code-only\`'`, ""].join("\n");
        const markdown = [`Read \`config.json\`:`, "", `${quote}${fence}text`, body + `${quote}${fence}`,
          "", "Then use `models.json`."].join("\n");
        expect(codeBlocks(markdown)).toEqual([body]);
        expect(codeBlocks(markdown.replace("ocx start", "ocx wrong"))).not.toEqual(codeBlocks(markdown));
        expect([...inlineCode(markdown)]).toEqual(["config.json", "models.json"]);
        expect(withoutFencedCode(markdown)).not.toContain("code-only");
      }
    }
  });

  test("registers Spanish and covers every current canonical documentation path", () => {
    expect(localeFolders.has("es")).toBe(true);
    expect(config).toMatch(/es:\s*\{\s*label:\s*["']Español["'],\s*lang:\s*["']es["']/);
    const english = pages(root, true);
    expect(english.length).toBeGreaterThan(50);
    expect(pages(join(root, "es"))).toEqual(english);
  });

  test("foreground proxy recipes separate subsequent terminal commands in every locale", () => {
    let checked = 0;
    for (const [guide, start, next] of [
      ["guides/remote-workspace.md", "OCX_REMOTE_WORKSPACE_ENABLED=1 ocx start", "ocx gui"],
      ["guides/web-dashboard.md", "ocx start\n", "bun run dev:gui"],
    ] as const) {
      for (const locale of ["", ...localeFolders]) {
        const path = join(root, locale, guide);
        if (!existsSync(path)) continue;
        const blocks = codeBlocks(source(path));
        const foreground = blocks.find(block => block.includes(start));
        expect(foreground, path).toBeDefined();
        expect(foreground, `${path} foreground start blocks later shell commands`).not.toContain(next);
        expect(blocks, `${path} next command runs in a separate terminal block`).toContain(next + "\n");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1);
  });

  test("keeps executable examples and frontmatter in the current English shape", () => {
    for (const path of pages(root, true)) {
      const english = source(join(root, path));
      const spanish = source(join(root, "es", path));
      expect(spanish, path).toMatch(/^---\ntitle:\s*\S/);
      expect(spanish, path).toMatch(/\ndescription:\s*\S/);
      expect(codeBlocks(spanish), `${path} code examples`).toEqual(codeBlocks(english));
      // Exact code spans cover every model family and namespace without a family allowlist.
      expect(missingInlineIdentifiers(english, spanish), `${path} inline and model identifiers`).toEqual([]);
      const htmlCode = (text: string): string[] => [...text.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)].map(match => match[1]!);
      expect(htmlCode(spanish), `${path} HTML code`).toEqual(htmlCode(english));
      const directives = (text: string): string[] => [...text.matchAll(/^:::(\w*)/gm)].map(match => match[1]!);
      expect(directives(spanish), `${path} admonition structure`).toEqual(directives(english));
      const prose = withoutFencedCode;
      const tables = (text: string): number => [...prose(text).matchAll(/^\s*\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?/gm)].length;
      const items = (text: string): number => [...prose(text).matchAll(/^\s*(?:[-*]|[1-9]\d*\.)\s+/gm)].length;
      expect(tables(spanish), `${path} complete tables`).toBe(tables(english));
      const tableShapes = (text: string): number[][] => prose(text).split(/\n\s*\n/)
        .filter(block => /^\s*\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?/m.test(block))
        .map(block => block.split("\n").filter(line => line.trimStart().startsWith("|"))
          .map(line => [...line.matchAll(/(?<!\\)\|/g)].length));
      expect(tableShapes(spanish), `${path} table rows and columns`).toEqual(tableShapes(english));
      expect(items(spanish), `${path} complete instruction lists`).toBeGreaterThanOrEqual(items(english));
      expect(spanish, path).not.toMatch(/ZXQ\d|QXZ|\u2047|\uFFFD/);
      expect(spanish, path).not.toMatch(/locale=["']en["']/);
      expect(relative(root, join(root, "es", path)).replaceAll("\\", "/")).toBe(`es/${path}`);
    }
  });

  test("provider quickstarts pass environment references without shell expansion", () => {
    for (const locale of ["", ...localeFolders]) {
      const examples = codeBlocks(source(join(root, locale, "getting-started/for-agents.md"))).join("\n");
      expect(examples, `${locale || "en"} provider CLI reference`).toContain("--api-key '${ANTHROPIC_API_KEY}'");
    }
    for (const locale of ["", "es"]) {
      const examples = codeBlocks(source(join(root, locale, "guides/combos.md"))).join("\n");
      expect(examples, `${locale || "en"} JEV CLI reference`).toContain("--api-key '${TYPESAFE_API_KEY}'");
    }
  });

  test("remote credential examples require a protected transport in every locale", () => {
    for (const locale of ["", ...localeFolders]) {
      const opencode = codeBlocks(source(join(root, locale, "guides/opencode.md")))
        .find(block => block.includes('"x-opencodex-api-key"'));
      expect(opencode, `${locale || "en"} OpenCode example`).toBeDefined();
      const options = JSON.parse(`{${opencode}}`).options;
      expect(new URL(options.baseURL).protocol, `${locale || "en"} OpenCode transport`).toBe("https:");
      expect(options.headers["x-opencodex-api-key"]).toBe("{env:OPENCODEX_OPENCODE_API_KEY}");
      const grok = codeBlocks(source(join(root, locale, "guides/grok-build.md")))
        .find(block => block.includes("[model_providers.opencodex]")
          && /api_key = "(?!opencodex-loopback")[^"]+"/.test(block));
      expect(grok, `${locale || "en"} Grok remote example`).toBeDefined();
      expect(grok, `${locale || "en"} Grok transport`).toMatch(/base_url = "https:\/\//);
    }
  });

  test("Video Bridge key-auth examples parse and reference the environment in every locale", () => {
    for (const locale of ["", ...localeFolders]) {
      const path = join(root, locale, "guides/video-bridge.md");
      if (!existsSync(path)) continue;
      const block = codeBlocks(source(path)).find(text => text.includes('"xai"'));
      expect(block, path).toBeDefined();
      const config = JSON.parse(block!.replace(/^[ \t]*>[ \t]?/gm, ""));
      expect(config.providers.xai, path).toMatchObject({ apiKey: "${XAI_API_KEY}", authMode: "key" });
      expect(source(path).match(/`authMode: "key"`/g)?.length ?? 0, path).toBeGreaterThan(0);
    }
  });

  test("Executor pairing examples read secrets silently and clear variables in every locale", () => {
    for (const locale of ["", ...localeFolders]) {
      const path = join(root, locale, "guides/remote-workspace.md");
      if (!existsSync(path)) continue;
      const blocks = codeBlocks(source(path)).filter(text => text.includes("ocx remote-workspace pair"));
      expect(blocks.length, path).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block, path).not.toContain("ONE-TIME-CODE");
        expect(block, path).toMatch(/read -r -s|Read-Host [^\n]+-AsSecureString/);
        expect(block, path).toContain("--pairing-code-stdin");
        expect(block, path).toMatch(/unset pairing_code|Remove-Variable pairingCode/);
      }
    }
  });

  test("model identifier parity rejects extended tokens across families and namespaces", () => {
    const identifiers = ["gpt-6-astra", "whisper-1", "claude-opus-5", "o1-mini", "o3-mini", "o4-mini",
      "codex-mini-latest", "qwen/qwen3-coder-plus", "tev1:4b"];
    const canonical = identifiers.map(id => `\`${id}\``).join(", ");
    expect(missingInlineIdentifiers(canonical, canonical)).toEqual([]);
    for (const id of identifiers) {
      const extended = canonical.replace(`\`${id}\``, `\`${id}-translated\``);
      expect(missingInlineIdentifiers(canonical, extended)).toEqual([id]);
    }
  });

  test("keeps literal model names intact in surrounding prose", () => {
    for (const path of pages(root, true)) {
      const english = source(join(root, path));
      const spanish = source(join(root, "es", path));
      const identifiers = [...inlineCode(english)].filter(value =>
        /^(?:[a-z0-9._-]+\/)*[a-z][a-z0-9._-]*-[a-z0-9._-]+$/i.test(value) && /\d/.test(value));
      for (const identifier of identifiers) {
        const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const token = new RegExp(`(?<![\\w./*-])${escaped}(?![\\w./*-])`, "g");
        expect(spanish.match(token)?.length ?? 0, `${path} model ${identifier}`)
          .toBeGreaterThanOrEqual(english.match(token)?.length ?? 0);
      }
    }
  });

  test("keeps client product names recognizable in the integration table and metadata", () => {
    const english = source(join(root, "guides/integrations.md"));
    const spanish = source(join(root, "es/guides/integrations.md"));
    const clientNames = (text: string): string[] => {
      const table = text.split(/\n\s*\n/).find(block => /^\|[^\n]+\n\|[-:| \t]+\|/.test(block));
      return table?.split("\n").slice(2).map(row => row.split("|")[1]?.trim() ?? "").filter(Boolean) ?? [];
    };
    const names = clientNames(english);
    expect(names.length).toBeGreaterThan(10);
    expect(clientNames(spanish)).toEqual(names);
    const metadata = (text: string): string => text.match(/^---\n[\s\S]*?\n---/)?.[0] ?? "";
    for (const name of names.filter(name => metadata(english).includes(name))) {
      expect(metadata(spanish), `client product name ${name}`).toContain(name);
    }
  });

  test("preserves external links, references and API response status codes", () => {
    const targets = (text: string): string[] => [...text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)]
      .map(match => match[1]!.replace(/^(https:\/\/opencodex\.me)\/es\//, "$1/")).sort();
    for (const path of pages(root, true)) {
      const english = source(join(root, path));
      const spanish = source(join(root, "es", path));
      expect(targets(spanish), `${path} external links`).toEqual(targets(english));
      const references = spanish.match(/#\d+\b/g) ?? [];
      for (const reference of english.match(/#\d+\b/g) ?? []) {
        const index = references.indexOf(reference);
        expect(index, `${path} reference ${reference}`).toBeGreaterThanOrEqual(0);
        if (index >= 0) references.splice(index, 1);
      }
      const apiRows = (text: string): string[][] => text.split("\n")
        .filter(line => /^\|\s*`(?:GET|POST|PUT|PATCH|DELETE)\b/.test(line))
        .map(line => line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim()));
      const rowKey = (row: string[]): string => [...inlineCode(row[0] ?? "")].join("\u0000");
      const translatedRows = new Map<string, string[][]>();
      for (const row of apiRows(spanish)) {
        const key = rowKey(row);
        translatedRows.set(key, [...translatedRows.get(key) ?? [], row]);
      }
      for (const row of apiRows(english)) {
        const translated = translatedRows.get(rowKey(row))?.shift();
        expect(translated, `${path} API row ${row[0]}`).toBeDefined();
        for (const status of row.at(-1)?.match(/\b[1-5]\d{2}\b/g) ?? []) {
          expect(translated?.at(-1), `${path} ${row[0]} status ${status}`).toMatch(new RegExp(`\\b${status}\\b`));
        }
      }
    }
  });

  test("landing, language navigation, metadata and benchmark copy include Spanish", () => {
    for (const file of ["Landing.astro", "Header.astro", "SiteJsonLd.astro"]) {
      const text = source(repoPath(`docs-site/src/components/${file}`));
      expect(text, file).toContain("'es'");
    }
    expect(source(join(root, "es/index.mdx"))).toContain('<Landing locale="es" />');
    expect(source(repoPath("docs-site/src/components/Header.astro"))).toContain("Español");
    expect(source(repoPath("docs-site/src/data/frontier-i18n.ts"))).toMatch(/\bes:\s*\{/);
    const landing = source(repoPath("docs-site/src/components/Landing.astro"));
    const decodeKey = (key: string): string => key.replace(/\\(['"\\])/g, "$1");
    const keys = (block: string): string[] => [...block.matchAll(/^\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*:/gm)]
      .map(match => decodeKey(match[1] ?? match[2] ?? "")).sort();
    const french = keys(landing.match(/const fr = \{([\s\S]*?)^\}(?: as const)?;/m)?.[1] ?? "");
    const spanish = keys(landing.match(/const es:[^=]+ = \{([\s\S]*?)^\};/m)?.[1] ?? "");
    expect(french.length).toBeGreaterThan(0);
    expect(spanish).toEqual(french);
    for (const call of landing.matchAll(/\bt\((?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/g)) {
      expect(french, "visible or accessible landing copy").toContain(decodeKey(call[1] ?? call[2] ?? ""));
    }
  });

  test("every translated Pi quickstart keeps the non-secret loopback export contract", () => {
    for (const locale of localeFolders) {
      const text = source(join(root, locale, "guides/pi.md"));
      const examples = codeBlocks(text);
      const provider = examples.find(block => block.includes('"providers"'));
      expect(provider, `${locale} Pi provider example`).toBeDefined();
      expect(JSON.parse(provider!).providers.opencodex.apiKey, `${locale} Pi apiKey`).toBe("opencodex-loopback");
      expect(examples.join("\n"), `${locale} Pi export commands`).not.toContain("export OPENCODEX_API_KEY");
    }
  });

  test("benchmark names and placeholders retain their canonical meaning", () => {
    const english = FRONTIER_STRINGS.en;
    const spanish = FRONTIER_STRINGS.es;
    expect(Object.keys(spanish).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english) as (keyof typeof english)[]) {
      expect(spanish[key].trim(), key).not.toBe("");
      expect(spanish[key].match(/\{\w+\}/g) ?? [], key).toEqual(english[key].match(/\{\w+\}/g) ?? []);
      if (key.endsWith(".title")) expect(spanish[key], key).toBe(english[key]);
    }
  });

  test("documents the current archive limits and recoverable refusal codes", () => {
    const spanish = source(join(root, "es/reference/configuration/server.md"));
    expect(spanish).toContain('<a id="native-reasoning-retention"></a>');
    for (const value of ["512 MiB", "256", "reasoning_archive_quota_exceeded", "reasoning_archive_busy", "reasoning_archive_unavailable"]) {
      expect(spanish).toContain(value);
    }
  });
});
