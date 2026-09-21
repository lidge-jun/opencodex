import { normalizeKiroModelId } from "../../providers/kiro-models";
import { namespacedToolName } from "../../types";
import type {
  OcxAssistantMessage,
  OcxContentPart,
  OcxParsedRequest,
  OcxTextContent,
  OcxTool,
  OcxToolCall,
  OcxToolResultMessage,
} from "../../types";
import {
  KIRO_ANSWER_DELIVERED_MESSAGE,
  KIRO_COMPLETION_INSTRUCTIONS,
  KIRO_COMPLETION_RETRY_MESSAGE,
  KIRO_COMPLETION_TOOL_NAME,
  KIRO_CONTINUATION_MESSAGE,
  KIRO_EMPTY_TOOL_RESULT_MESSAGE,
  KIRO_TOOL_RESULT_CARRIER_MESSAGE,
  MAX_KIRO_INJECTED_INSTRUCTION_CHARS,
  type KiroCompletionMode,
} from "../kiro-constants";
import { EMPTY_EXEC_OUTPUT_MESSAGE, annotateCodeModeHostFailure, normalizeEmptyExecToolResultText } from "../exec-tool-result-normalize";
import { identifyRoutedModel } from "../identity";
import {
  countKiroUninlinableImages,
  extractKiroImages,
  kiroUninlinableImageMarker,
  type KiroImage,
} from "../kiro-images";
import { convertKiroToolContext } from "../kiro-tools";
import { createKiroToolNameRegistry, mapModelId, normalizeToolId, stableConversationId } from "../kiro-wire";
import { buildNonOpenAIToolCatalogNudgeFromNames, isBareShellBridgeTool, isCodexCodeModeExecTool } from "../tool-catalog-nudge";
import {
  appendTurnText,
  hasTrailingDeliveredFinalAnswer,
  validateKiroCapabilities,
  validateKiroConversationState,
  type KiroTurn,
} from "./conversation";
import {
  injectKiroThinkingTags,
  kiroNativeEffortField,
  kiroReasoningContent,
  KIRO_NATIVE_EFFORTS,
} from "./reasoning";
import { kiroPayloadMessages, userContentText } from "./usage";
import {
  kiroToolWireNames,
  type KiroHistoryEntry,
  type KiroToolResult,
  type KiroToolUse,
  type KiroWireClient,
} from "./wire";

export function boundedInjectedInstruction(text: string, used: { value: number }): string | undefined {
  const remaining = MAX_KIRO_INJECTED_INSTRUCTION_CHARS - used.value;
  if (remaining <= 0 || !text) return undefined;
  let result = text.length <= remaining ? text : text.slice(0, remaining);
  // Never end the slice on a lone high surrogate: encoding it substitutes
  // U+FFFD into the injected instruction. One step back keeps a valid pair
  // out instead of a broken half.
  if (result.length > 0) {
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
  }
  used.value += result.length;
  return result.length > 0 ? result : undefined;
}

/** Test-only: exercise the surrogate-safe instruction bound directly. */
export function boundedInjectedInstructionForTests(text: string, used: { value: number }): string | undefined {
  return boundedInjectedInstruction(text, used);
}

export function kiroCompletionTool(): Record<string, unknown> {
  return {
    toolSpecification: {
      name: KIRO_COMPLETION_TOOL_NAME,
      // The shared tool-catalog nudge enumerates this name next to ordinary tools and tells every
      // listed name to count a call only after its tool result returns. Nothing returns a result
      // here: a valid call becomes the turn's terminal. Left undescribed, the model reads one more
      // deferrable work tool and keeps calling tools with a finished answer already written as
      // commentary. So the description states the distinction, the obligation, and the terminality
      // where the model is actually choosing between tools.
      //
      // It also has to name the blocked-on-user state, for the same reason the prose contract does.
      // This is the surface the model reads while CHOOSING; if it admits only "fully complete", a
      // model holding a question that blocks progress reads this tool as unavailable and keeps
      // working instead, which is the measured defect. The two surfaces must not disagree.
      description: "Terminal completion channel, not an ordinary work tool. When the task is fully complete and no more work or tool calls are needed, you must call this tool exactly once instead of providing the final answer as ordinary assistant text. Call it the same way when you cannot continue until the user supplies a decision, information, or a clarification that only they can give: the question itself is the answer. Put the complete user-facing final answer in `answer`. The call is complete when issued: it ends the turn, returns no tool result, and no text or tool call may follow it.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              description: "The complete final answer to show the user, or the blocking question you need the user to answer before you can continue.",
            },
          },
          required: ["answer"],
        },
      },
    },
  };
}

export function buildKiroPayload(
  parsed: OcxParsedRequest,
  profileArn: string | undefined,
  forcedCompletionMode?: KiroCompletionMode,
  wireClient: KiroWireClient = "ide",
): {
  payload: Record<string, unknown>;
  nameMap: Map<string, string>;
  conversationId: string;
  completionMode: KiroCompletionMode;
} {
  validateKiroCapabilities(parsed);
  const modelId = mapModelId(parsed.modelId);
  const registry = createKiroToolNameRegistry();
  const toolContext = convertKiroToolContext(parsed, registry);
  const ordinaryTools = toolContext.tools;
  // A turn whose history already ENDS with a delivered final answer has nothing to complete.
  // Leaving completion "required" here would keep advertising codex_kiro_final_answer with its
  // instructions, so the model answers again, or replies with ordinary text and trips the
  // `needsFallback` retry, which ends its payload with KIRO_COMPLETION_RETRY_MESSAGE and reopens
  // the finished task. Suppressing the mode is what actually closes that loop; the neutral
  // acknowledgement below only stops the resume wording.
  //
  // Read from parsed messages because `completionMode` is needed to build the tool catalog, which
  // happens before the turn list exists. `forcedCompletionMode` still wins: the fallback retry
  // passes "text_fallback" explicitly and must not be silently downgraded.
  const trailingDeliveredAnswer = hasTrailingDeliveredFinalAnswer(kiroPayloadMessages(parsed), parsed);
  const completionMode: KiroCompletionMode = forcedCompletionMode
    ?? (ordinaryTools.length > 0 && !trailingDeliveredAnswer ? "required" : "disabled");
  const kiroTools = completionMode === "disabled"
    ? ordinaryTools
    : [...ordinaryTools, kiroCompletionTool()];
  const nameMap = toolContext.nameMap;
  const systemParts: string[] = [];
  const injectedChars = { value: 0 };
  // Name the Kiro model id actually sent on the wire without leaking the proxy identity upstream.
  if (parsed.context.systemPrompt?.length) {
    systemParts.push(identifyRoutedModel(parsed.context.systemPrompt.join("\n\n"), modelId));
  }
  for (const addition of toolContext.systemAdditions) {
    const boundedAddition = boundedInjectedInstruction(addition, injectedChars);
    if (boundedAddition) systemParts.push(boundedAddition);
  }
  // Kiro renames tools to satisfy its wire constraints, so resolve neighbor names through the
  // registry's existing aliases; a bare-name comparison would forbid tools this turn actually
  // advertises. Read the recorded mapping instead of calling `alias()`, which would REGISTER a
  // name for a tool that was never advertised and pollute the collision domain.
  const advertisedAlias = new Map<string, string>();
  for (const [alias, wireName] of registry.nameMap) advertisedAlias.set(wireName, alias);
  // Code mode is decided on the EMITTED catalog, not the requested list.
  //
  // `freeform` only exists on the requested tool objects -- `kiroToolWireNames` has already
  // reduced the emitted catalog to strings -- so the predicates must read the objects. But the
  // SHAPE that matters is the one the model receives: the count/byte budget can drop a requested
  // `exec_command` while `exec` survives, and scanning the requested list would then find a shell
  // bridge the model cannot call and suppress code mode for a catalog that is code-mode-shaped.
  // Intersecting the two keeps `tool_choice: "none"` and budget omission correct for free: both
  // empty the emitted set, so nothing can be named.
  const emittedToolNames = new Set(kiroToolWireNames(kiroTools));
  const emittedAlias = (tool: OcxTool): string | undefined => {
    const wireName = namespacedToolName(tool.namespace, tool.name);
    // Read the recorded mapping; `registry.alias()` would REGISTER a name here.
    const alias = advertisedAlias.get(wireName) ?? wireName;
    return emittedToolNames.has(alias) ? alias : undefined;
  };
  const requestedTools = parsed.context.tools ?? [];
  const emittedCodeModeExec = requestedTools.find(tool => isCodexCodeModeExecTool(tool) && emittedAlias(tool));
  const emittedShellBridge = requestedTools.some(tool => isBareShellBridgeTool(tool) && emittedAlias(tool));
  const codeModeExecName = emittedCodeModeExec && !emittedShellBridge
    ? emittedAlias(emittedCodeModeExec)
    : undefined;
  const toolCatalogNudge = buildNonOpenAIToolCatalogNudgeFromNames(
    kiroToolWireNames(kiroTools),
    name => advertisedAlias.get(name) ?? name,
    codeModeExecName,
  );
  const boundedNudge = toolCatalogNudge ? boundedInjectedInstruction(toolCatalogNudge, injectedChars) : undefined;
  if (boundedNudge) systemParts.push(boundedNudge);
  if (completionMode !== "disabled") {
    const boundedCompletion = boundedInjectedInstruction(KIRO_COMPLETION_INSTRUCTIONS, injectedChars);
    if (boundedCompletion) systemParts.push(boundedCompletion);
  }
  const systemPrefix = systemParts.length > 0 ? `${systemParts.join("\n\n")}\n\n` : "";
  const turns: KiroTurn[] = [];
  const priorCalls = new Map<string, { wireName: string; rawId: string }>();
  const pushUser = (content: string, images: KiroImage[] = [], toolResults: KiroToolResult[] = []): void => {
    const last = turns.at(-1);
    if (last?.kind === "user") {
      last.content = appendTurnText(last.content, content);
      last.images.push(...images);
      last.toolResults.push(...toolResults);
    } else {
      turns.push({ kind: "user", content, images: [...images], toolResults: [...toolResults] });
    }
  };
  const pushAssistant = (content: string, toolUses: KiroToolUse[], redactedReasoning?: string, finalAnswer?: boolean): void => {
    const last = turns.at(-1);
    if (last?.kind === "assistant") {
      last.content = appendTurnText(last.content, content);
      last.toolUses.push(...toolUses);
      // Merged turns keep the newest blob: it covers the reasoning up to the merged turn's end.
      if (redactedReasoning) last.redactedReasoning = redactedReasoning;
      // A merged turn is final only if its LAST component was: commentary appended after a final
      // answer means the model kept working, so the turn is no longer terminal.
      last.finalAnswer = finalAnswer === true;
    } else {
      turns.push({
        kind: "assistant",
        content,
        toolUses: [...toolUses],
        ...(redactedReasoning ? { redactedReasoning } : {}),
        ...(finalAnswer ? { finalAnswer: true } : {}),
      });
    }
  };

  let adjacentResult: {
    rawId: string;
    result: KiroToolResult;
    texts: string[];
    count: number;
    hasImages: boolean;
  } | undefined;
  const finishAdjacentResult = (): void => {
    if (adjacentResult && adjacentResult.count > 1) {
      if (adjacentResult.texts.some(text => text.trim())) {
        adjacentResult.result.content = adjacentResult.texts.map(text => ({ text }));
      } else if (adjacentResult.hasImages || adjacentResult.result.status === "error") {
        adjacentResult.result.content = [{ text: KIRO_EMPTY_TOOL_RESULT_MESSAGE }];
      }
    }
    adjacentResult = undefined;
  };

  for (const msg of kiroPayloadMessages(parsed)) {
    // Original-message adjacency matters even when a turn is collapsed or skipped below.
    if (msg.role !== "toolResult") finishAdjacentResult();
    if (msg.role === "user" || msg.role === "developer") {
      const content = (msg as { content: string | OcxContentPart[] }).content;
      const images = extractKiroImages(content);
      // Kiro inlines base64 bytes only. A remote reference used to vanish with neither
      // bytes nor a trace; attach a bounded, URL-free marker so the loss is visible.
      const marker = kiroUninlinableImageMarker(countKiroUninlinableImages(content));
      const text = userContentText(content);
      pushUser(marker ? (text ? text + "\n" + marker : marker) : text, images);
    } else if (msg.role === "assistant") {
      const aMsg = msg as OcxAssistantMessage;
      const text = (aMsg.content || [])
        .filter((b): b is OcxTextContent => b.type === "text")
        .map(b => b.text)
        .join("");
      const toolCalls = (aMsg.content || [])
        .filter((b): b is OcxToolCall => b.type === "toolCall");
      const toolUses: KiroToolUse[] = toolCalls.map(tc => {
        const toolUseId = normalizeToolId(tc.id);
        if (!toolUseId) throw new Error("Kiro history contains a tool call with an empty id");
        if (priorCalls.has(toolUseId)) throw new Error(`Kiro history contains duplicate tool call id ${JSON.stringify(tc.id)}`);
        const wireName = namespacedToolName(tc.namespace, tc.name);
        const name = registry.alias(wireName);
        priorCalls.set(toolUseId, { wireName, rawId: tc.id });
        return { name, input: (tc.arguments ?? {}) as Record<string, unknown>, toolUseId };
      });
      if (!text && toolUses.length === 0) {
        const hasReasoning = aMsg.content.some(part => part.type === "thinking" && part.thinking.trim());
        if (hasReasoning) continue;
      }
      // `phase` survives the Responses round trip (parser.ts assistant branch), so a replayed
      // final answer is identifiable here rather than guessed from turn position.
      pushAssistant(text, toolUses, aMsg.kiroRedactedReasoning, aMsg.phase === "final_answer" && toolUses.length === 0);
    } else if (msg.role === "toolResult") {
      const tr = msg as OcxToolResultMessage;
      if (tr.containsEncryptedContent) {
        throw new Error(`Kiro cannot translate encrypted output for tool call ${JSON.stringify(tr.toolCallId)}`);
      }
      const text = userContentText(tr.content);
      // An empty code-mode exec result needs the SPECIFIC reason, not the generic fallback: the
      // model otherwise reads a blank result, concludes its earlier context was lost, and restarts
      // the task instead of calling text()/notify(). Checked before `text.trim()` because the
      // wrapper form ("Script completed\nWall time ...\nOutput:\n") is non-blank and would
      // otherwise pass through as if it were real output.
      const execOptions = { toolName: tr.toolName, toolNamespace: tr.toolNamespace };
      const normalizedExecText = normalizeEmptyExecToolResultText(text, execOptions);
      // A host failure string inside a non-empty exec result gets the rule it broke appended, but
      // only when this request's emitted catalog is genuinely code mode (`codeModeExecName` above):
      // a structured tool named exec, or exec beside a shell bridge, never ran the isolate. This is
      // the only substitution the grouping path below also carries: whitespace and empty/failed
      // wrappers keep their existing raw policy.
      const annotatedExecText = normalizedExecText === undefined && codeModeExecName !== undefined
        ? annotateCodeModeHostFailure(text, execOptions)
        : undefined;
      const uninlinableMarker = kiroUninlinableImageMarker(countKiroUninlinableImages(tr.content));
      // Appended to the SELECTED result text, not to `text`: when an exec normalization
      // fires, resultText below takes normalizedExecText/annotatedExecText instead, and
      // a marker attached to `text` would be dropped — reinstating the silent loss this
      // exists to remove.
      const chosenText = normalizedExecText ?? annotatedExecText ?? (text.trim() ? text : KIRO_EMPTY_TOOL_RESULT_MESSAGE);
      const resultText = uninlinableMarker
        ? (chosenText ? chosenText + "\n" + uninlinableMarker : uninlinableMarker)
        : chosenText;
      const images = extractKiroImages(tr.content);
      const toolUseId = normalizeToolId(tr.toolCallId);
      const call = priorCalls.get(toolUseId);
      if (!call || call.rawId !== tr.toolCallId) {
        throw new Error(`Kiro history contains an orphaned tool result for call ${JSON.stringify(tr.toolCallId)}`);
      }
      // Keep real whitespace and failed wrappers, but no empty-success wrapper boilerplate.
      const rawGroupBase = text.length > 0 && (!text.trim() || normalizedExecText !== EMPTY_EXEC_OUTPUT_MESSAGE)
        ? (annotatedExecText ?? text) : undefined;
      // The grouping path rebuilds a collapsed turn's content from these texts, so the
      // marker has to ride along here too or an adjacent-result turn loses it.
      const rawGroupText = uninlinableMarker
        ? (rawGroupBase ? rawGroupBase + "\n" + uninlinableMarker : uninlinableMarker)
        : rawGroupBase;
      const last = turns.at(-1);
      if (
        adjacentResult?.rawId === tr.toolCallId
        && last?.kind === "user"
        && last.toolResults.at(-1) === adjacentResult.result
      ) {
        adjacentResult.count += 1;
        adjacentResult.hasImages ||= images.length > 0;
        if (rawGroupText !== undefined) adjacentResult.texts.push(rawGroupText);
        last.images.push(...images);
        if (tr.isError) adjacentResult.result.status = "error";
        continue;
      }
      finishAdjacentResult();
      // Carrier text is a placeholder for an OTHERWISE EMPTY tool-result turn, not a prefix.
      // Passing it here would push proxy filler AHEAD of a human instruction that Claude Code
      // sends in the same turn (mid-turn steering / queued_command, issue #543), burying the
      // newest user intent behind boilerplate. Backfill below only when nothing else speaks.
      const result: KiroToolResult = {
        content: [{ text: resultText }],
        status: tr.isError ? "error" : "success",
        toolUseId,
      };
      pushUser("", images, [result]);
      adjacentResult = {
        rawId: tr.toolCallId, result,
        texts: rawGroupText === undefined ? [] : [rawGroupText],
        count: 1, hasImages: images.length > 0,
      };
    }
  }
  finishAdjacentResult();

  if (turns.length === 0 || turns[0].kind === "assistant") {
    turns.unshift({ kind: "user", content: KIRO_CONTINUATION_MESSAGE, images: [], toolResults: [] });
  }
  // Kiro requires the request to end with a user turn, so a trailing assistant turn always gets
  // one appended (the pop below throws otherwise). What that turn SAYS is the load-bearing part.
  //
  // Normally a trailing assistant turn means the model stopped mid-task, and a continuation/retry
  // prompt is correct. A DELIVERED final answer is the exception: the turn already ended, and
  // telling that model to "continue" or to call the completion tool again reopens finished work —
  // the completed-task-behaves-like-an-open-goal loop. It gets a neutral acknowledgement instead:
  // structurally valid, but carrying no instruction to resume.
  const trailing = turns.at(-1);
  if (trailing?.kind === "assistant") {
    const resumeText = completionMode === "text_fallback" ? KIRO_COMPLETION_RETRY_MESSAGE : KIRO_CONTINUATION_MESSAGE;
    turns.push({
      kind: "user",
      content: trailing.finalAnswer ? KIRO_ANSWER_DELIVERED_MESSAGE : resumeText,
      images: [],
      toolResults: [],
      ...(trailing.finalAnswer ? { answerDeliveredAck: true } : {}),
    });
  }

  // Give tool-result turns a carrier sentence ONLY when they carry no other text. This runs
  // before the pop below so the current turn is covered too: skipping it there would ship an
  // empty current content, which validateKiroConversationState accepts (tool results count as
  // payload) and would therefore fail silently.
  for (const turn of turns) {
    if (turn.kind === "user" && !turn.content.trim() && turn.toolResults.length > 0) {
      turn.content = KIRO_TOOL_RESULT_CARRIER_MESSAGE;
    }
  }

  const currentTurn = turns.pop();
  if (!currentTurn || currentTurn.kind !== "user") throw new Error("Kiro request must end with a user turn");
  // Survives the pop as state, so the checks below never infer intent from user-supplied text.
  const answerDeliveredAck = currentTurn.answerDeliveredAck === true;
  const toEntry = (turn: KiroTurn): KiroHistoryEntry => turn.kind === "assistant"
    ? {
        assistantResponseMessage: {
          content: turn.content,
          ...(turn.toolUses.length > 0 ? { toolUses: turn.toolUses } : {}),
          // Replayed on the field it was received on: the GPT-5.6 signature is not base64 and is
          // rejected when sent as `redactedContent`.
          ...(turn.redactedReasoning
            ? { reasoningContent: kiroReasoningContent(turn.redactedReasoning) }
            : {}),
        },
      }
    : {
        userInputMessage: {
          content: turn.content,
          modelId,
          origin: wireClient === "cli" ? "KIRO_CLI" : "AI_EDITOR",
          ...(turn.images.length > 0 ? { images: turn.images } : {}),
          ...(turn.toolResults.length > 0 ? { userInputMessageContext: { toolResults: turn.toolResults } } : {}),
        },
      };
  const history = turns.map(toEntry);
  const currentEntry = toEntry(currentTurn);
  const currentUim = currentEntry.userInputMessage!;

  if (systemPrefix) {
    const firstUser = history.find(e => e.userInputMessage)?.userInputMessage;
    if (firstUser) firstUser.content = systemPrefix + firstUser.content;
    else currentUim.content = systemPrefix + currentUim.content;
  }
  if (kiroTools.length > 0) {
    currentUim.userInputMessageContext = { ...(currentUim.userInputMessageContext ?? {}), tools: kiroTools };
  }
  if (completionMode === "text_fallback") {
    // Never append the retry instruction onto the answer-delivered acknowledgement: it exists
    // precisely to avoid asking a finished turn for another completion call, and appending here
    // would reinstate the loop it prevents.
    if (currentUim.content !== KIRO_COMPLETION_RETRY_MESSAGE && !answerDeliveredAck) {
      currentUim.content = appendTurnText(currentUim.content, KIRO_COMPLETION_RETRY_MESSAGE);
    }
  } else if (
    !currentUim.userInputMessageContext?.toolResults
    && currentUim.content !== KIRO_CONTINUATION_MESSAGE
    && !answerDeliveredAck
  ) {
    currentUim.content = injectKiroThinkingTags(currentUim.content, parsed);
  }

  validateKiroConversationState(history, currentEntry);
  const conversationId = stableConversationId(parsed);
  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      ...(wireClient === "cli" ? {
        agentContinuationId: crypto.randomUUID(),
        agentTaskType: "vibe",
      } : {}),
      conversationId,
      currentMessage: { userInputMessage: currentUim },
      ...(history.length > 0 ? { history } : {}),
    },
  };
  const effort = parsed.options.reasoning;
  const effortField = kiroNativeEffortField(parsed.modelId);
  if (effortField && effort && effort !== "none") {
    if (!KIRO_NATIVE_EFFORTS.includes(effort)) {
      throw new Error(`Kiro ${normalizeKiroModelId(parsed.modelId)} does not support reasoning effort ${JSON.stringify(effort)}`);
    }
    // Model eligibility still owns unsupported-effort validation above; wire eligibility
    // is narrower for luna/terra, whose unverified rungs retain the thinking-tag path.
    const verifiedEffortField = kiroNativeEffortField(parsed.modelId, effort);
    if (verifiedEffortField) {
      payload.additionalModelRequestFields = { [verifiedEffortField]: { effort } };
    }
  }
  if (profileArn) payload.profileArn = profileArn;
  return { payload, nameMap, conversationId, completionMode };
}
