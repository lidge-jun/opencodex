// Adapted from cramt/m365-copilot-proxy (65905e8), copyright 2026 Alexandra Østermark. MIT; see LICENSE.
import { getToneForModel, isSonnet55Model } from "../../providers/m365-copilot-models";
import type { ParsedToolCall, ToolDef } from "./tools";
const BODY_PARAM_NAMES = [
    "command", "content", "code", "body", "script", "text",
    "query", "input", "patch", "cmd", "data", "contents",
];
const SEARCH_KEYS = ["old", "search", "find", "old_str", "old_string", "target"];
const REPLACE_KEYS = ["new", "replace", "replacement", "new_str", "new_string"];
const SHELL_LANGS = new Set([
    "bash", "sh", "shell", "zsh", "console", "shell-session", "shellsession", "shsession",
    "container.exec", "container.run", "container.bash",
    "powershell", "pwsh", "ps1", "posh", "cmd", "bat", "batch", "dosbatch",
]);
const SHELL_TOOL_NAME = /^(bash|sh|shell|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system)$/i;
const WRITE_PATH_PARAM = /^(path|file_path|filepath|filename|file)$/i;
const WRITE_CONTENT_PARAM = /^(content|contents|text|body)$/i;
export function findWriteTool(tools: ToolDef[]): ToolDef | undefined {
    return tools.find((t) => {
        const props = Object.keys(t.function.parameters?.properties ?? {});
        return props.some((p) => WRITE_PATH_PARAM.test(p)) &&
            props.some((p) => WRITE_CONTENT_PARAM.test(p)) &&
            !props.some((p) => SEARCH_KEYS.includes(p));
    });
}
export function findShellTool(tools: ToolDef[]): ToolDef | undefined {
    return tools.find((t) => SHELL_TOOL_NAME.test(t.function.name)) ??
        tools.find((t) => {
            const props = Object.keys(t.function.parameters?.properties ?? {});
            return props.length === 1 && /^(command|cmd|script|input)$/i.test(props[0]);
        });
}
export interface FencedToolSpec {
    name: string;
    description?: string;
    parameterTypes: Record<string, string>;
    headerParams: string[];
    bodyParam?: string;
    editPair?: {
        search: string;
        replace: string;
    };
}
export function deriveFencedSpec(tool: ToolDef): FencedToolSpec {
    const name = tool.function.name;
    const description = tool.function.description;
    const propsSchema = tool.function.parameters?.properties ?? {};
    const props = Object.keys(propsSchema);
    const parameterTypes = Object.fromEntries(Object.entries(propsSchema).map(([k, v]: any) => [
        k,
        v?.type ?? "string",
    ]));
    const search = props.find((p) => SEARCH_KEYS.includes(p));
    const replace = props.find((p) => REPLACE_KEYS.includes(p));
    if (search && replace) {
        return {
            name,
            description,
            parameterTypes,
            editPair: { search, replace },
            headerParams: props.filter((p) => p !== search && p !== replace),
        };
    }
    const bodyParam = props.find((p) => BODY_PARAM_NAMES.includes(p)) ??
        (props.length === 1 ? props[0] : undefined);
    return {
        name,
        description,
        parameterTypes,
        bodyParam,
        headerParams: props.filter((p) => p !== bodyParam),
    };
}
export function buildSpecMap(tools: ToolDef[]): Map<string, FencedToolSpec> {
    const m = new Map<string, FencedToolSpec>();
    for (const t of tools)
        m.set(t.function.name, deriveFencedSpec(t));
    const shell = findShellTool(tools);
    if (shell) {
        const shellSpec = m.get(shell.function.name)!;
        for (const lang of SHELL_LANGS) {
            if (!m.has(lang))
                m.set(lang, shellSpec);
        }
    }
    return m;
}
function scalarToString(v: unknown): string {
    if (v === null || v === undefined)
        return "";
    if (typeof v === "string")
        return v;
    return JSON.stringify(v);
}
export function renderFencedCall(spec: FencedToolSpec, args: Record<string, unknown>): string {
    const lines: string[] = [];
    for (const h of spec.headerParams) {
        if (args[h] !== undefined)
            lines.push(`${h}: ${scalarToString(args[h])}`);
    }
    if (spec.editPair) {
        lines.push("<<<<<<< SEARCH");
        lines.push(scalarToString(args[spec.editPair.search]));
        lines.push("=======");
        lines.push(scalarToString(args[spec.editPair.replace]));
        lines.push(">>>>>>> REPLACE");
    }
    else if (spec.bodyParam !== undefined) {
        if (lines.length)
            lines.push("");
        lines.push(scalarToString(args[spec.bodyParam]));
    }
    return "```" + spec.name + "\n" + lines.join("\n") + "\n```";
}
function renderFencedTemplate(spec: FencedToolSpec): string {
    const lines: string[] = [];
    for (const h of spec.headerParams)
        lines.push(`${h}: <${h}>`);
    if (spec.editPair) {
        lines.push("<<<<<<< SEARCH");
        lines.push(`<${spec.editPair.search}>`);
        lines.push("=======");
        lines.push(`<${spec.editPair.replace}>`);
        lines.push(">>>>>>> REPLACE");
    }
    else if (spec.bodyParam !== undefined) {
        if (lines.length)
            lines.push("");
        lines.push(`<${spec.bodyParam}>`);
    }
    const header = spec.description ? `${spec.name} — ${spec.description}` : spec.name;
    return `${header}\n\`\`\`${spec.name}\n${lines.join("\n")}\n\`\`\``;
}
export function formatFencedToolDefinitions(tools: ToolDef[], variantOverride?: string): string {
    const variant = variantOverride ?? currentFramingVariant();
    const key = variant === "reply_tool" ? "baseline" : variant;
    const build = FRAMING_VARIANTS[key] ?? FRAMING_VARIANTS.baseline;
    return build(tools) + hostPlatformNote(findShellTool(tools), undefined, findWriteTool(tools));
}
export function shellDialect(shell: ToolDef | undefined, platform: NodeJS.Platform = process.platform): "posix" | "powershell" | undefined {
    if (!shell)
        return undefined;
    const override: string | undefined = undefined;
    if (override === "bash" || override === "sh" || override === "posix")
        return "posix";
    if (override === "powershell" || override === "pwsh")
        return "powershell";
    const claim = `${shell.function.name} ${shell.function.description ?? ""}`.toLowerCase();
    if (/\b(powershell|pwsh|cmd\.exe)\b/.test(claim))
        return "powershell";
    if (/\b(bash|zsh|sh|posix|wsl)\b/.test(claim))
        return "posix";
    return platform === "win32" ? "powershell" : "posix";
}
export function hostPlatformNote(shell: ToolDef | undefined, platform: NodeJS.Platform = process.platform, writeTool?: ToolDef): string {
    if (platform !== "win32" || !shell)
        return "";
    if (shellDialect(shell, platform) === "posix") {
        const longWrite = writeTool
            ? `write any file longer than a few thousand characters with the \`${writeTool.function.name}\` tool, never in one heredoc`
            : "write a long file in parts: create it with the first part, then append the rest with `cat >> file <<'EOF'` in later turns";
        return `

HOST PLATFORM: Windows, but the \`${shell.function.name}\` tool is a POSIX shell on it (Git Bash or WSL), NOT PowerShell and NOT a container. Keep using \`\`\`${"bash"} blocks and POSIX idioms — \`<<'EOF'\` heredocs, \`sed -i\`, \`ls\`/\`grep\` all work. Do NOT emit PowerShell: \`Get-ChildItem\`, \`Set-Content\` and \`Write-Output\` are not commands here and the turn will fail.

The Windows command line is capped near 8,000 characters and a longer command is cut off silently, so a big heredoc leaves a truncated file. Keep each command short and ${longWrite}.

Only the filesystem is Windows: paths may be \`C:/Users/...\` or contain spaces, so quote them and prefer forward slashes. You are NOT in a Linux sandbox and have no \`/mnt/data\`; the working directory is the caller's real project directory — run \`pwd\` if you need to see it.`;
    }
    return `

HOST PLATFORM: Windows. The \`${shell.function.name}\` tool runs PowerShell on a real Windows machine — not Linux, and not a container. Any POSIX idiom named above is wrong here and will fail: there are no \`<<'EOF'\` heredocs, no \`sed -i\`, no \`ls\`/\`grep\`. Emit \`\`\`powershell blocks instead of \`\`\`bash, and use the Windows equivalents:

- create/overwrite a file: \`Set-Content -Path name -Value @'\n…\n'@\`
- edit in place: \`(Get-Content f) -replace 'old','new' | Set-Content f\`
- inspect: \`Get-Content\` / \`Get-ChildItem\` / \`Select-String\`
- paths use \`\\\` and may contain spaces — quote them.

You are NOT in a Linux sandbox and have no \`/mnt/data\`. The working directory is a real Windows path; run \`Get-Location\` if you need to see it.`;
}
export function currentFramingVariant(fallback: string = "baseline"): string {
    return fallback;
}
export function defaultFramingForTone(tone?: string): string | undefined {
    if (tone === "Claude_Opus")
        return "relay_batch";
    if (tone === "Claude_Sonnet")
        return "relay_batch";
    if (tone === "Claude_Sonnet_5")
        return SONNET_5_DEFAULT_FRAMING;
    if (tone === "Gpt_6_Reasoning")
        return "relay_batch";
    if (tone === "Gpt_6_Sol_Reasoning")
        return "relay_batch";
    if (tone === "Gpt_61_Sol_Reasoning")
        return "relay_batch";
    return undefined;
}
export function defaultFramingForModel(model: string): string | undefined {
    if (isSonnet55Model(model))
        return SONNET_5_5_DEFAULT_FRAMING;
    return defaultFramingForTone(getToneForModel(model));
}
const SONNET_5_DEFAULT_FRAMING = "relay";
const SONNET_5_5_DEFAULT_FRAMING = "relay";
export interface TranscriptStyle {
    framingTag: string | null;
    systemTag: string;
}
const SYSTEM_STYLE: TranscriptStyle = { framingTag: "system", systemTag: "system" };
const RETAG_STYLE: TranscriptStyle = { framingTag: "harness_instructions", systemTag: "harness_system_prompt" };
const USER_VOICE_STYLE: TranscriptStyle = { framingTag: null, systemTag: "harness_system_prompt" };
const TRANSCRIPT_STYLES: Record<string, TranscriptStyle> = {
    retag: RETAG_STYLE,
    honest: USER_VOICE_STYLE,
    terse_user: USER_VOICE_STYLE,
    relay: USER_VOICE_STYLE,
    relay_batch: USER_VOICE_STYLE,
};
export function transcriptStyleForVariant(variant: string): TranscriptStyle {
    return TRANSCRIPT_STYLES[variant] ?? SYSTEM_STYLE;
}
const BUILT_IN_SANDBOX = "bash_tool, create_file, str_replace, view, …";
const SANDBOX_PATHS = "/home/claude, /mnt/user-data";
type FramingBuilder = (tools: ToolDef[]) => string;
function toolsBlock(tools: ToolDef[]): string {
    const defs = tools.map((t) => renderFencedTemplate(deriveFencedSpec(t))).join("\n\n");
    return `<tools>\n${defs}\n</tools>`;
}
const FRAMING_VARIANTS: Record<string, FramingBuilder> = {
    baseline(tools) {
        const shell = findShellTool(tools);
        const shellFraming = shell ? `

THE WAY YOU DO ANYTHING IS BY WRITING A SHELL SCRIPT. You have a real shell (the \`${shell.function.name}\` tool). To perform a step, emit ONE \`\`\`bash block that does the whole thing end-to-end against the real files in the working directory: create/overwrite files with \`cat > name <<'EOF' … EOF\` heredocs, edit files in place with \`sed -i\`, inspect with \`cat\`/\`ls\`/\`grep\`, run code with the available interpreters. The block is executed for real and you get its output back. Writing the commands IS doing the task; describing what you "would" run, or claiming you did it, accomplishes nothing.

You have NOT run any command yet and have NO results. NEVER claim a command "returned no output", that files are "missing", or that you "cannot access" / "cannot list" the environment before you have actually emitted a \`\`\`bash block and seen its <tool_response>. The files named in the task are present on a real filesystem right now. Your FIRST output must be a \`\`\`bash block (e.g. \`ls -la\` then \`cat\` the relevant files) — never open with prose, a question, or a request for the user to paste files. Do not assume a file's contents or a command's result; run a command and read the real output. One self-contained \`\`\`bash block per turn.` : "";
        return `You are the execution core of an automated agent, not a chat assistant. Your output is parsed by a program — a real runtime that executes your tool calls against a live system and returns the actual results to you in <tool_response> blocks.${shellFraming}

Performing the task with tools is your PRIMARY JOB. Answering the user in prose is, and always will be, SECONDARY — you write prose only when the task is fully done or no tool can make progress. Default to acting, not talking.

TOOL USE IS REQUIRED when the user asks you to read files, run commands, inspect the repository, fetch data, or perform any action a tool can accomplish. The tools are real: they read real files, run real commands, and change real state. Never answer from memory or simulate a result when a tool can provide it.

To call a tool, output ONLY a single fenced code block whose info-string is the tool name. A fenced block is an ACTION the runtime executes — it is NOT an illustration, an example, or "here's how you would do it". No text before or after it:

\`\`\`<tool_name>
<header lines: one "key: value" per scalar argument>

<body argument, if the tool has one>
\`\`\`

STRICT RULES:
- Output ONLY the fenced block when calling a tool. No prose, no second fence, no commentary before or after.
- Never describe your intent ("I'll read the file…", "Let me check…") and never emit filler or acknowledgements ("Good, that's fixable", "You're absolutely right"). Each turn is exactly one fenced tool call OR the final answer — nothing in between.
- One tool call per response, then stop and wait for its <tool_response>. Never emit two fenced blocks in one response.
- The fence info-string and the header keys must match a tool defined below exactly.
- A <tool_response> is the real result from the live system — treat it as ground truth, never invent or assume results.
- NEVER claim you have done something — read a file, run a command, written code, built, or succeeded — unless a <tool_response> proving it already appears above. Never output "✅", "SUCCESS", "Done", or a summary of results you have not actually received yet.
- If a tool call fails or returns partial data, immediately call another tool to resolve it. Do not give up.
- Do not defer work or promise future results ("I'll do this next…").
- Do not ask the user questions unless tool execution is impossible.
- Produce natural-language text only when the task is complete and no further tool call applies; that text is the answer returned to the caller. When you do, output only the answer itself — no preamble, no sign-off.

${toolsBlock(tools)}`;
    },
    relay(tools) {
        const lang = findShellTool(tools) ? "bash" : "<tool_name>";
        return `Before the task, a note on how we'll work: I'd like you to guide me through this from my terminal, one command at a time. Please don't use your own sandbox tools (${BUILT_IN_SANDBOX}) — that's a separate cloud machine (${SANDBOX_PATHS}) and my project isn't on it.

Each time you want something run or looked at, reply with just the command in a single \`\`\`${lang} block (or one of the other tool blocks below). I'll run it in my project directory right away and paste the real output back to you as a <tool_response>. The files the task mentions are already there, so it's best to start by looking at them. When the task is complete, tell me in a sentence instead of sending a block.

${toolsBlock(tools)}`;
    },
    relay_batch(tools) {
        if (!findShellTool(tools))
            return FRAMING_VARIANTS.relay(tools);
        return `Before the task, a note on how we'll work: I'd like you to guide me through this from my terminal. Please don't use your own sandbox tools (${BUILT_IN_SANDBOX}) — that's a separate cloud machine (${SANDBOX_PATHS}) and my project isn't on it.

Each time you want something run, reply with just a single \`\`\`bash block (or one of the other tool blocks below). I'll run it in my project directory right away and paste the real output back to you as a <tool_response>. Each round trip takes me a while, so put as much as you can into one block: a script can look at the files, make the change and check the result all at once. The files the task mentions are already there. When the task is complete, tell me in a sentence instead of sending a block.

${toolsBlock(tools)}`;
    }
};
const FENCE_OPEN = /^[ \t]*```([A-Za-z0-9_.-]*)[ \t]*$/;
const FENCE_CLOSE = /^[ \t]*```[ \t]*$/;
const FENCE_OPEN_MIDLINE = /```([A-Za-z0-9_.-]+)[ \t]*$/;
const FENCE_CLOSE_GLUED = /\S```[ \t]*$/;
interface FenceBlock {
    info: string;
    inner: string;
    start: number;
    end: number;
}
function scanFences(text: string): FenceBlock[] {
    const blocks: FenceBlock[] = [];
    let depth = 0;
    let open: {
        info: string;
        start: number;
        bodyStart: number;
    } | null = null;
    let offset = 0;
    for (const raw of text.split("\n")) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        const lineEnd = offset + raw.length;
        const opener = FENCE_OPEN.exec(line)?.[1];
        if (depth === 0) {
            const midline = opener ? null : FENCE_OPEN_MIDLINE.exec(line);
            if (opener || midline) {
                open = { info: opener || midline![1], start: offset + (midline?.index ?? 0), bodyStart: lineEnd + 1 };
                depth = 1;
            }
        }
        else if (FENCE_CLOSE.test(line)) {
            if (--depth === 0 && open) {
                let inner = text.slice(open.bodyStart, Math.max(open.bodyStart, offset - 1));
                if (inner.endsWith("\r"))
                    inner = inner.slice(0, -1);
                blocks.push({ info: open.info, inner, start: open.start, end: lineEnd });
                open = null;
            }
        }
        else if (opener) {
            depth++;
        }
        else if (depth === 1 && open && FENCE_CLOSE_GLUED.test(line)) {
            const inner = text.slice(open.bodyStart, offset + line.trimEnd().length - 3);
            blocks.push({ info: open.info, inner, start: open.start, end: lineEnd });
            open = null;
            depth = 0;
        }
        offset = lineEnd + 1;
    }
    return blocks;
}
const FENCE_OPEN_REGEX = /```([A-Za-z0-9_.-]+)[ \t]*\r?\n/g;
const SEARCH_REPLACE_REGEX = /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={5,}\s*\r?\n([\s\S]*?)\r?\n>{5,}\s*REPLACE/;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NATIVE_TRAILER_LINE = String.raw `(?:<\/?(?:invoke|function_calls|parameter)\b[^\r\n]*|[^\p{L}\p{N}\r\n]{0,3})`;
function nativeCloserRegex(name: string): RegExp {
    return new RegExp(String.raw `(?:\r?\n<\/?parameter\b[^\r\n]*)*\r?\n<\/(?:invoke|function_calls|parameter|${escapeRegExp(name)})>[ \t]*(?:\r?\n${NATIVE_TRAILER_LINE})*\s*$`, "u");
}
function gluedNativeCloserRegex(name: string): RegExp {
    return new RegExp(String.raw `(?<=\S)[ \t]*<\/(invoke|function_calls|parameter|${escapeRegExp(name)})>[ \t]*(?:\r?\n${NATIVE_TRAILER_LINE})*\s*$`, "u");
}
function stripNativeCloser(inner: string, name: string): string | null {
    const m = nativeCloserRegex(name).exec(inner);
    const rest = m ? inner.slice(0, m.index) : inner;
    const g = gluedNativeCloserRegex(name).exec(rest);
    if (g) {
        const line = rest.slice(rest.lastIndexOf("\n", g.index) + 1, g.index);
        if (!new RegExp(String.raw `<${escapeRegExp(g[1])}\b`).test(line))
            return rest.slice(0, g.index);
    }
    return m ? rest : null;
}
function findUnclosedToolFence(text: string, specs: Map<string, FencedToolSpec>): {
    start: number;
    end: number;
    spec: FencedToolSpec;
    inner: string;
} | null {
    let last: RegExpExecArray | null = null;
    const re = new RegExp(FENCE_OPEN_REGEX.source, "g");
    for (let m = re.exec(text); m !== null; m = re.exec(text))
        last = m;
    if (!last)
        return null;
    const spec = specs.get(last[1]);
    if (!spec)
        return null;
    const bodyStart = last.index + last[0].length;
    const tail = text.slice(bodyStart);
    if (tail.includes("```"))
        return null;
    const inner = stripNativeCloser(tail, last[1]);
    if (inner === null)
        return null;
    return { start: last.index, end: text.length, spec, inner };
}
function makeCall(name: string, args: Record<string, unknown>): ParsedToolCall {
    return {
        id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
    };
}
const TRUE_WORDS = new Set(["true", "yes", "y", "1", "on"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "off"]);
function coerceHeaderValue(value: string, declaredType: string | undefined): unknown {
    switch (declaredType) {
        case "boolean": {
            const v = value.toLowerCase();
            if (TRUE_WORDS.has(v))
                return true;
            if (FALSE_WORDS.has(v))
                return false;
            return value;
        }
        case "integer":
        case "number": {
            if (value === "")
                return value;
            const n = Number(value);
            if (!Number.isFinite(n))
                return value;
            if (declaredType === "integer" && !Number.isInteger(n))
                return value;
            return n;
        }
        case "array": {
            if (value === "")
                return [];
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed))
                    return parsed;
            }
            catch {
                return [value];
            }
            return [value];
        }
        default:
            return value;
    }
}
const indentOf = (line: string): number => line.length - line.trimStart().length;
function yamlBlockEnd(lines: string[], from: number, isArray: boolean): number {
    let end = from;
    for (let j = from; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === "")
            continue;
        if (/^[ \t]/.test(line) || (isArray && /^-([ \t]|$)/.test(line)))
            end = j + 1;
        else
            break;
    }
    return end;
}
function parseYamlBlockValue(block: string[], declaredType: string): unknown {
    let value: unknown;
    try {
        value = parseYamlNode(block.map((l) => l.replace(/\t/g, "  ")));
    }
    catch {
        return undefined;
    }
    if (declaredType === "array")
        return Array.isArray(value) ? value : undefined;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
class YamlSubsetError extends Error {
}
function parseYamlNode(lines: string[]): unknown {
    const first = lines.findIndex((l) => l.trim() !== "");
    if (first < 0)
        throw new YamlSubsetError("empty block");
    const body = lines.slice(first);
    const indent = indentOf(body[0]);
    const head = body[0].trimStart();
    if (/^-([ \t]|$)/.test(head))
        return parseYamlSequence(body, indent);
    if (YAML_KEY.test(head))
        return parseYamlMapping(body, indent);
    if (body.slice(1).some((l) => l.trim() !== ""))
        throw new YamlSubsetError("multi-line plain scalar");
    return parseYamlScalar(head);
}
const YAML_KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#'"\-][^:]*?):(?:[ \t]+(.*)|[ \t]*)$/;
function childLines(lines: string[], from: number, indent: number): {
    lines: string[];
    next: number;
} {
    let j = from;
    for (; j < lines.length; j++) {
        if (lines[j].trim() !== "" && indentOf(lines[j]) <= indent)
            break;
    }
    return { lines: lines.slice(from, j), next: j };
}
function parseYamlSequence(lines: string[], indent: number): unknown[] {
    const items: unknown[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === "") {
            i++;
            continue;
        }
        if (indentOf(line) !== indent || !/^-([ \t]|$)/.test(line.trimStart()))
            throw new YamlSubsetError(`bad sequence line: ${line}`);
        const rest = line.trimStart().slice(1);
        const kids = childLines(lines, i + 1, indent);
        if (rest.trim() === "") {
            items.push(parseYamlNode(kids.lines));
        }
        else {
            const itemIndent = indent + 1 + (rest.length - rest.trimStart().length);
            const itemLines = [" ".repeat(itemIndent) + rest.trimStart(), ...kids.lines];
            items.push(YAML_KEY.test(rest.trimStart()) ? parseYamlMapping(itemLines, itemIndent) : parseYamlValue(rest.trim(), kids.lines, indent));
        }
        i = kids.next;
    }
    return items;
}
function parseYamlMapping(lines: string[], indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === "") {
            i++;
            continue;
        }
        const m = indentOf(line) === indent ? line.trimStart().match(YAML_KEY) : null;
        if (!m)
            throw new YamlSubsetError(`bad mapping line: ${line}`);
        const key = String(parseYamlScalar(m[1]));
        let j = i + 1;
        for (; j < lines.length; j++) {
            const l = lines[j];
            if (l.trim() === "")
                continue;
            const ind = indentOf(l);
            if (ind > indent || (ind === indent && /^-([ \t]|$)/.test(l.trimStart()) && !(m[2] ?? "").trim()))
                continue;
            break;
        }
        out[key] = parseYamlValue((m[2] ?? "").trim(), lines.slice(i + 1, j), indent);
        i = j;
    }
    return out;
}
function parseYamlValue(inline: string, nested: string[], parentIndent: number): unknown {
    const block = inline.match(/^([|>])([-+]?)$/);
    if (block)
        return parseYamlBlockScalar(nested, parentIndent, block[1] === ">", block[2]);
    if (inline === "")
        return nested.some((l) => l.trim() !== "") ? parseYamlNode(nested) : "";
    if (nested.some((l) => l.trim() !== ""))
        throw new YamlSubsetError("value with both inline text and nested lines");
    return parseYamlScalar(inline);
}
function parseYamlScalar(raw: string): unknown {
    const s = raw.trim();
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
        try {
            return JSON.parse(s);
        }
        catch {
            return s.slice(1, -1);
        }
    }
    if (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
        return s.slice(1, -1).replace(/''/g, "'");
    if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
        try {
            return JSON.parse(s);
        }
        catch {
            return s;
        }
    }
    return s;
}
function parseYamlBlockScalar(lines: string[], parentIndent: number, folded: boolean, chomp: string): string {
    const content = lines.filter((l) => l.trim() !== "");
    if (!content.length)
        return "";
    const indent = Math.min(...content.map(indentOf));
    if (indent <= parentIndent)
        throw new YamlSubsetError("block scalar not indented");
    const rows = lines.map((l) => (l.trim() === "" ? "" : l.slice(indent)));
    let text = folded
        ? rows.reduce((acc, row, k) => (k === 0 ? row : row === "" || rows[k - 1] === "" ? `${acc}\n${row}` : `${acc} ${row}`), "")
        : rows.join("\n");
    const trailing = text.match(/\n*$/)![0].length;
    if (chomp === "+")
        return `${text}\n`;
    text = text.slice(0, text.length - trailing);
    return chomp === "-" ? text : `${text}\n`;
}
function headerTextValue(inline: string, more: string[]): string {
    const rows = [...more];
    while (rows.length && rows[rows.length - 1].trim() === "")
        rows.pop();
    if (!rows.length)
        return inline;
    const block = inline.match(/^([|>])([-+]?)$/);
    if (block) {
        try {
            return parseYamlBlockScalar(rows, 0, block[1] === ">", block[2]);
        }
        catch {
            return headerTextValue("", rows);
        }
    }
    if (inline === "" || block) {
        const indent = Math.min(...rows.filter((l) => l.trim() !== "").map(indentOf));
        return rows.map((l) => l.slice(Math.min(indent, indentOf(l)))).join("\n");
    }
    return [inline, ...rows].join("\n");
}
function parseFencedInner(spec: FencedToolSpec, inner: string): Record<string, unknown> | null {
    const lines = inner.split("\n");
    const args: Record<string, unknown> = {};
    const headerOnly = !spec.editPair && spec.bodyParam === undefined;
    let open: {
        key: string;
        inline: string;
        more: string[];
    } | null = null;
    const closeOpen = () => {
        if (open?.more.length)
            args[open.key] = headerTextValue(open.inline, open.more);
        open = null;
    };
    let i = 0;
    if (spec.headerParams.length) {
        for (; i < lines.length; i++) {
            const line = lines[i];
            const m = line.match(/^([A-Za-z0-9_]+):[ \t]?(.*)$/);
            if (m && spec.headerParams.includes(m[1])) {
                closeOpen();
                const key = m[1];
                const type = spec.parameterTypes[key];
                if (m[2].trim() === "" && (type === "array" || type === "object")) {
                    const end = yamlBlockEnd(lines, i + 1, type === "array");
                    const value = end > i + 1 ? parseYamlBlockValue(lines.slice(i + 1, end), type) : undefined;
                    if (value !== undefined) {
                        args[key] = value;
                        i = end - 1;
                        continue;
                    }
                }
                args[key] = coerceHeaderValue(m[2].trim(), type);
                if (headerOnly && (type ?? "string") === "string")
                    open = { key, inline: m[2].trim(), more: [] };
            }
            else if (open) {
                open.more.push(line);
            }
            else if (line.trim() === "") {
                i++;
                break;
            }
            else {
                break;
            }
        }
        closeOpen();
    }
    const rest = lines.slice(i).join("\n");
    if (spec.editPair) {
        const sr = rest.match(SEARCH_REPLACE_REGEX);
        if (!sr) {
            return null;
        }
        args[spec.editPair.search] = sr[1];
        args[spec.editPair.replace] = sr[2];
    }
    else if (spec.bodyParam !== undefined) {
        args[spec.bodyParam] = rest;
    }
    return args;
}
export interface FencedParseResult {
    calls: ParsedToolCall[];
    leftover: string;
}
const RESTATED_SIMILARITY = 0.85;
const RESTATEMENT_GAP_CHARS = 300;
const CORRECTION_WORDS = /\b(?:oops|sorry|apolog\w*|mistake|typo|wrong|malformed|broken|incorrect\w*|corrected|correctly|fixed|same command|re-?formatted|properly formatted|try(?:ing)? again|let me redo)\b/i;
interface ToolFence {
    start: number;
    end: number;
    name: string;
    args: Record<string, unknown>;
    hadNativeCloser: boolean;
}
function argTokens(args: Record<string, unknown>): Set<string> {
    const text = Object.values(args).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
    return new Set(text.split(/\s+/).filter(Boolean));
}
function restates(prev: ToolFence, next: ToolFence, gap: string): boolean {
    if (prev.name !== next.name || gap.trim().length > RESTATEMENT_GAP_CHARS)
        return false;
    if (!prev.hadNativeCloser && !CORRECTION_WORDS.test(gap))
        return false;
    const a = argTokens(prev.args);
    const b = argTokens(next.args);
    const shared = [...a].filter((t) => b.has(t)).length;
    return shared / Math.max(1, new Set([...a, ...b]).size) >= RESTATED_SIMILARITY;
}
function toolFences(text: string, specs: Map<string, FencedToolSpec>): ToolFence[] {
    const fences: ToolFence[] = [];
    for (const block of scanFences(text)) {
        const spec = specs.get(block.info);
        if (!spec)
            continue;
        const stripped = stripNativeCloser(block.inner, block.info);
        const args = parseFencedInner(spec, stripped ?? block.inner);
        if (!args)
            continue;
        const fence: ToolFence = { start: block.start, end: block.end, name: spec.name, args, hadNativeCloser: stripped !== null };
        const prev = fences[fences.length - 1];
        if (prev && restates(prev, fence, text.slice(prev.end, fence.start))) {
            fences[fences.length - 1] = { ...fence, start: prev.start };
            continue;
        }
        fences.push(fence);
    }
    return fences;
}
export function parseFencedToolCalls(text: string, specs: Map<string, FencedToolSpec>): FencedParseResult {
    const calls: ParsedToolCall[] = [];
    let leftover = text;
    for (const fence of toolFences(text, specs)) {
        calls.push(makeCall(fence.name, fence.args));
        leftover = leftover.replace(text.slice(fence.start, fence.end), "");
    }
    if (calls.length === 0) {
        const open = findUnclosedToolFence(text, specs);
        const args = open && parseFencedInner(open.spec, open.inner);
        if (open && args) {
            calls.push(makeCall(open.spec.name, args));
            leftover = text.slice(0, open.start);
        }
    }
    return { calls, leftover };
}
export function findFirstToolFence(text: string, specs: Map<string, FencedToolSpec>): {
    start: number;
    end: number;
} | null {
    const first = toolFences(text, specs)[0];
    if (first)
        return { start: first.start, end: first.end };
    const open = findUnclosedToolFence(text, specs);
    if (open && parseFencedInner(open.spec, open.inner))
        return { start: open.start, end: open.end };
    return null;
}
