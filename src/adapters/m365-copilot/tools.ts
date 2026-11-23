// Adapted from cramt/m365-copilot-proxy (65905e8), copyright 2026 Alexandra Østermark. MIT; see LICENSE.
import { buildSpecMap, currentFramingVariant, deriveFencedSpec, findToolFenceRanges, formatFencedToolDefinitions, parseFencedToolCalls, removeEmptyToolWrappers, renderFencedCall, transcriptStyleForVariant, type FenceRange } from "./fenced";
export interface ToolFunction {
    name: string;
    description?: string;
    parameters?: {
        properties?: Record<string, {
            type?: string;
            [k: string]: unknown;
        }>;
        required?: string[];
        [k: string]: unknown;
    };
}
export interface ToolDef {
    type?: string;
    function: ToolFunction;
}
export interface Message {
    role: string;
    content?: string | Array<{
        type: string;
        text?: string;
        image_url?: {
            url: string;
        };
    }> | null;
    tool_calls?: Array<{
        id: string;
        function: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
    name?: string;
}
export type ToolChoice = "auto" | "none" | "required" | {
    type: "function";
    function: {
        name: string;
    };
} | undefined;
interface JsonEnvelope { start: number; end: number; valueStart: number; valueEnd: number }

/** Keep the original inline and fenced grammars. Advance both boundaries once per envelope. */
function jsonToolEnvelopes(text: string, fenced: boolean): JsonEnvelope[] {
    const opener = fenced ? /```tool_call\s*\n(?=\{)/g : /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{/g;
    const closer = fenced ? /\}[^\S\n]*\n\s*```/g : /\}\s*\}/g;
    const ranges: JsonEnvelope[] = [];
    let opening: RegExpExecArray | null;
    while ((opening = opener.exec(text)) !== null) {
        closer.lastIndex = opener.lastIndex;
        const closing = closer.exec(text);
        if (!closing) break;
        ranges.push({ start: opening.index, end: closer.lastIndex, valueStart: fenced ? opener.lastIndex : opening.index,
            valueEnd: fenced ? closing.index + 1 : closer.lastIndex });
        opener.lastIndex = closer.lastIndex;
    }
    return ranges;
}

function proseOutsideEnvelopes(text: string, inline: JsonEnvelope[], fenced: JsonEnvelope[]): string {
    if (!inline.length && !fenced.length) return text;
    const prose: string[] = [];
    let cursor = 0, i = 0, j = 0;
    // An inline envelope can be inside a JSON fence. Both ranges refer to the original answer.
    while (i < inline.length || j < fenced.length) {
        const takeInline = j === fenced.length || (i < inline.length && inline[i]!.start < fenced[j]!.start);
        const next = takeInline ? inline[i++]! : fenced[j++]!;
        if (next.start > cursor) prose.push(text.slice(cursor, next.start));
        cursor = Math.max(cursor, next.end);
    }
    prose.push(text.slice(cursor));
    return prose.join("");
}
const CONFIDENCE_REGEX = /\{\s*"confidence"\s*:\s*-?[0-9.]+\s*\}/g;
const FINAL_OBJECT_REGEX = /\{\s*"final"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;
function cleanLooseText(text: string): string | null {
    let out = text;
    for (const m of out.match(FINAL_OBJECT_REGEX) ?? []) {
        try {
            const value = JSON.parse(m).final;
            if (typeof value === "string")
                out = out.replace(m, value);
        }
        catch {
            continue;
        }
    }
    out = out.replace(CONFIDENCE_REGEX, "").trim();
    return out.length ? out : null;
}
export function formatToolDefinitions(tools: ToolDef[], variantOverride?: string): string {
    return formatFencedToolDefinitions(tools, variantOverride);
}
export function formatToolChoiceInstruction(toolChoice: ToolChoice): string {
    if (!toolChoice || toolChoice === "auto")
        return "";
    if (toolChoice === "none")
        return "\nDo NOT call tools. Text only.";
    if (toolChoice === "required")
        return "\nYou MUST call at least one tool.";
    if (typeof toolChoice === "object" && toolChoice.function) {
        return `\nYou MUST call "${toolChoice.function.name}".`;
    }
    return "";
}
export function getMessageContent(msg: Message): string {
    if (msg.content === null || msg.content === undefined)
        return "";
    if (typeof msg.content === "string")
        return msg.content;
    return msg.content.map((p) => p.text || "").join("");
}
function toolCallSummary(rawArgs: string): string {
    let args: Record<string, unknown> = {};
    try {
        args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
    }
    catch {
        return "";
    }
    const primary = args.command ?? args.cmd ?? args.script ?? args.path ?? args.file ??
        args.filename ?? args.query ?? Object.values(args).find((v) => typeof v === "string");
    if (typeof primary !== "string")
        return "";
    return primary.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 100);
}
export function formatToolResponse(m: Message, history: Message[]): string {
    let meta: {
        name: string;
        summary: string;
    } | undefined;
    if (m.tool_call_id) {
        for (const a of history) {
            const tc = a.role === "assistant" ? a.tool_calls?.find((c) => c.id === m.tool_call_id) : undefined;
            if (tc) {
                meta = { name: tc.function.name, summary: toolCallSummary(tc.function.arguments) };
                break;
            }
        }
    }
    const name = m.name || meta?.name || "tool";
    const cmdAttr = meta?.summary ? ` command="${meta.summary}"` : "";
    return `<tool_response tool="${name}"${cmdAttr}>\n${getMessageContent(m)}\n</tool_response>`;
}
function maybeInjectReplyTool(tools: ToolDef[]): ToolDef[] {
    return tools;
}
export function formatMessages(messages: Message[], tools?: ToolDef[], toolChoice?: ToolChoice, conversationId?: string, framingVariant?: string): string {
    const parts: string[] = [];
    if (conversationId) {
        parts.push(`<conversation_id>${conversationId}</conversation_id>`);
    }
    const effectiveTools = tools ? maybeInjectReplyTool(tools) : tools;
    const specMap = effectiveTools ? buildSpecMap(effectiveTools) : null;
    const style = transcriptStyleForVariant(framingVariant ?? currentFramingVariant());
    if (effectiveTools && effectiveTools.length > 0 && toolChoice !== "none") {
        const framing = `${formatToolDefinitions(effectiveTools, framingVariant)}${formatToolChoiceInstruction(toolChoice)}`;
        parts.push(style.framingTag ? `<${style.framingTag}>\n${framing}\n</${style.framingTag}>` : framing);
    }
    for (const m of messages) {
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            const calls = m.tool_calls.map((tc) => {
                const rawArgs = tc.function.arguments;
                let argsObj: Record<string, unknown> = {};
                try {
                    argsObj = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
                }
                catch {
                    argsObj = {};
                }
                const spec = specMap?.get(tc.function.name) ?? deriveFencedSpec({
                    type: "function",
                    function: {
                        name: tc.function.name,
                        parameters: {
                            properties: Object.fromEntries(Object.keys(argsObj).map((k) => [k, { type: "string" }])),
                        },
                    },
                });
                return renderFencedCall(spec, argsObj);
            }).join("\n");
            const content = getMessageContent(m);
            parts.push(`<assistant>${content ? "\n" + content : ""}\n${calls}\n</assistant>`);
        }
        else if (m.role === "tool") {
            parts.push(formatToolResponse(m, messages));
        }
        else if (m.role === "system") {
            parts.push(`<${style.systemTag}>\n${getMessageContent(m)}\n</${style.systemTag}>`);
        }
        else {
            parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
        }
    }
    return parts.join("\n\n");
}
export interface ParsedToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
export interface ParseResult {
    hasToolCalls: boolean;
    toolCalls: ParsedToolCall[];
    textContent: string | null;
}
const SELF_WRITTEN_RESULT = /<tool_(?:response|result)\b/i;
const ANY_FENCE_OPEN = /```[A-Za-z0-9_.-]+[ \t]*\r?\n/;
export function truncateAtFabricatedToolResponse(text: string, tools?: ToolDef[]): string {
    const i = fabricatedToolResponseAt(text, tools);
    return i < 0 ? text : text.slice(0, i).trimEnd();
}
export function fabricatedToolResponseAt(text: string, tools?: ToolDef[]): number {
    return precedingToolCall(text, tools?.length ? buildSpecMap(tools) : null)?.index ?? -1;
}
type ToolSpecs = ReturnType<typeof buildSpecMap> | null;
interface ToolInspection { result: ParseResult; firstFenceStart?: number; inline?: JsonEnvelope[]; documentRanges?: FenceRange[] }

function precedingToolCall(text: string, specs: ToolSpecs) {
    const index = text.search(SELF_WRITTEN_RESULT);
    if (index < 0) return;
    const head = text.slice(0, index).trimEnd();
    const inspection = specs ? inspectToolCalls(head, specs) : undefined;
    if (inspection) return inspection.result.hasToolCalls ? { index, head, inspection } : undefined;
    const open = ANY_FENCE_OPEN.exec(head);
    if (open && head.indexOf("```", open.index + open[0].length) >= 0) return { index, head, inspection };
}

/** Classify the same source ranges that supplied the accepted calls. */
export function parseToolAnswer(text: string, tools: ToolDef[]) {
    const specs = buildSpecMap(tools);
    const prefix = precedingToolCall(text, specs);
    const accepted = prefix?.head ?? text;
    const inspection = prefix?.inspection ?? inspectToolCalls(accepted, specs);
    return { accepted, result: inspection.result, truncated: prefix !== undefined, document: proseDocument(inspection, accepted) };
}
export function isProseDocument(parsed: ParseResult, text?: string, tools?: ToolDef[]): boolean {
    if (!parsed.hasToolCalls || parsed.toolCalls.length < 2)
        return false;
    const documentRanges = text !== undefined && tools?.length ? findToolFenceRanges(text, buildSpecMap(tools)) : undefined;
    const inline = !documentRanges?.length && text !== undefined && parsed.toolCalls.length < 4 ? jsonToolEnvelopes(text, false) : undefined;
    return proseDocument({ result: parsed, firstFenceStart: documentRanges?.[0]?.start, inline, documentRanges }, text);
}
function proseDocument({ result: parsed, firstFenceStart, inline, documentRanges }: ToolInspection, text?: string): boolean {
    if (parsed.toolCalls.length < 2) return false;
    if (text !== undefined && firstFenceStart !== undefined && !looksLikeDocumentPreamble(text.slice(0, firstFenceStart))) return false;
    if (parsed.toolCalls.length >= 4) return true;
    // Only two or three calls depend on the exact heading and length of the old prose.
    // Preserve that decision without reparsing calls, their arguments or IDs.
    let prose = parsed.textContent?.trim() ?? "";
    if (text !== undefined && (documentRanges?.length === 2 || documentRanges?.length === 3)) {
        // Each original fence was removed at its first text match, which may have been in a document.
        let legacy = text;
        for (const range of documentRanges) legacy = legacy.replace(text.slice(range.start, range.end), "");
        prose = cleanLooseText(legacy) ?? "";
    } else if (text !== undefined && inline && text.includes("`")) {
        // JSON cleanup removed inline envelopes first, then fenced envelopes from the remaining text.
        const afterInline = proseOutsideEnvelopes(text, inline, []);
        const fenced = afterInline.includes("```tool_call") ? jsonToolEnvelopes(afterInline, true) : [];
        prose = proseOutsideEnvelopes(afterInline, [], fenced)
            .replace(CONFIDENCE_REGEX, "").replace(FINAL_OBJECT_REGEX, "")
            .replace(/```(?:json|tool_call)?\s*```/g, "").replace(/```(?:json|tool_call)?/g, "").trim();
    }
    return /^#{1,6}\s/m.test(prose) || prose.length >= 300;
}
function looksLikeDocumentPreamble(preamble: string): boolean {
    return /^#{1,6}\s/m.test(preamble) || preamble.includes("```") || preamble.trim().length >= 200;
}
export function parseToolCalls(text: string, tools?: ToolDef[]): ParseResult {
    return inspectToolCalls(text, tools?.length ? buildSpecMap(tools) : null).result;
}
function inspectToolCalls(text: string, specMap: ToolSpecs): ToolInspection {
    if (specMap) {
        const { calls, leftover, firstStart, documentRanges } = parseFencedToolCalls(text, specMap);
        if (calls.length > 0) {
            return { firstFenceStart: firstStart, documentRanges, result: { hasToolCalls: true, toolCalls: calls, textContent: cleanLooseText(leftover) } };
        }
    }
    const resolveName = (raw: unknown): string | undefined => typeof raw === "string" ? (specMap?.get(raw)?.name ?? raw) : undefined;
    const toolCalls: ParsedToolCall[] = [];
    function readCall(range: JsonEnvelope, fenced: boolean): void {
        try {
            const parsed = JSON.parse(text.slice(range.valueStart, range.valueEnd));
            const name = resolveName(fenced ? parsed.tool || parsed.name : parsed.tool);
            if (name) {
                toolCalls.push({
                    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
                    type: "function",
                    function: {
                        name,
                        arguments: typeof parsed.arguments === "string"
                            ? parsed.arguments
                            : JSON.stringify(parsed.arguments ?? {}),
                    },
                });
            }
        }
        catch {
            // Preserve the text fallback when there is no accepted call.
        }
    }
    const inline = jsonToolEnvelopes(text, false);
    for (const range of inline) readCall(range, false);
    const useInline = toolCalls.length > 0;
    const fenced = jsonToolEnvelopes(text, true);
    if (!useInline) {
        for (const range of fenced) readCall(range, true);
        if (!toolCalls.length) return { result: { hasToolCalls: false, toolCalls: [], textContent: cleanLooseText(text) } };
    }
    const remaining = removeEmptyToolWrappers(proseOutsideEnvelopes(text, useInline ? inline : [], fenced)
        .replace(CONFIDENCE_REGEX, "")
        .replace(FINAL_OBJECT_REGEX, "")).trim();
    return { inline, result: {
        hasToolCalls: true,
        toolCalls,
        textContent: remaining || null,
    } };
}
