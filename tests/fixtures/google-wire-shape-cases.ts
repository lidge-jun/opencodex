/**
 * Synthetic compiled Google wire bodies for the #5008 structural projection.
 *
 * Builders rather than recorded traffic: a captured Antigravity request is exactly the artifact
 * this projection exists so that nobody has to handle. Every string below is a marker, and the
 * tests assert that none of them survives into a summary.
 */

export const WIRE_MARKERS = {
  prompt: "MARKER-PROMPT-TEXT",
  systemText: "MARKER-SYSTEM-INSTRUCTION",
  toolName: "MARKER_TOOL_NAME",
  toolArgument: "MARKER-TOOL-ARGUMENT",
  toolResult: "MARKER-TOOL-RESULT",
  signature: "MARKERSIGNATUREBLOB0123456789",
  sessionId: "-1234567890123456789",
} as const;

/** Mirrors THOUGHT_SIGNATURE_BYPASS in src/adapters/google-antigravity-replay.ts. */
export const THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";

export type WirePart = Record<string, unknown>;
export type WireTurn = { role: string; parts: WirePart[] };
export type WireBody = Record<string, unknown>;

export function callId(ordinal: number): string {
  return `MARKER-CALL-ID-${ordinal}`;
}

export function userTurn(text: string = WIRE_MARKERS.prompt): WireTurn {
  return { role: "user", parts: [{ text }] };
}

export function modelTextTurn(text: string = WIRE_MARKERS.prompt): WireTurn {
  return { role: "model", parts: [{ text }] };
}

export function modelCallTurn(ids: readonly string[], options: { signature?: string } = {}): WireTurn {
  return {
    role: "model",
    parts: ids.map(id => ({
      functionCall: { name: WIRE_MARKERS.toolName, args: { query: WIRE_MARKERS.toolArgument }, id },
      ...(options.signature === undefined ? {} : { thoughtSignature: options.signature }),
    })),
  };
}

/** A function call the translator could not give a usable id, as an id-less wire part. */
export function unidentifiedCallTurn(): WireTurn {
  return {
    role: "model",
    parts: [{ functionCall: { name: WIRE_MARKERS.toolName, args: { query: WIRE_MARKERS.toolArgument } } }],
  };
}

export function toolResultTurn(ids: readonly string[]): WireTurn {
  return {
    role: "user",
    parts: ids.map(id => ({
      functionResponse: { name: WIRE_MARKERS.toolName, response: { result: WIRE_MARKERS.toolResult }, id },
    })),
  };
}

export function compiledWireBody(
  contents: readonly WireTurn[],
  options: { toolDeclarations?: number; systemInstruction?: boolean; sessionId?: string } = {},
): WireBody {
  const body: WireBody = { contents: [...contents] };
  if (options.systemInstruction !== false) {
    body.systemInstruction = { parts: [{ text: WIRE_MARKERS.systemText }] };
  }
  const declarations = options.toolDeclarations ?? 0;
  if (declarations > 0) {
    body.tools = [{
      functionDeclarations: Array.from({ length: declarations }, (_unused, i) => ({
        name: `${WIRE_MARKERS.toolName}_${i}`,
        description: WIRE_MARKERS.toolArgument,
        parameters: { type: "object", properties: {} },
      })),
    }];
  }
  body.sessionId = options.sessionId ?? WIRE_MARKERS.sessionId;
  return body;
}

/**
 * The shape a well-formed tool round trip reaches the wire as: user, then the model call turn,
 * then the adjacent function-response turn.
 */
export function toolRoundTrip(round: number, options: { signature?: string } = {}): WireTurn[] {
  const id = callId(round);
  return [modelCallTurn([id], options), toolResultTurn([id])];
}

/**
 * A long tool-heavy session of the kind #5008 reports: one opening user turn followed by
 * `rounds` adjacent call/response pairs. Deterministic, so a projection of it is stable.
 */
export function longToolSession(rounds: number, options: { signature?: string } = {}): WireTurn[] {
  const contents: WireTurn[] = [userTurn()];
  for (let round = 1; round <= rounds; round++) contents.push(...toolRoundTrip(round, options));
  contents.push(userTurn());
  return contents;
}

/** Compaction keeps the tail and replaces the head; the structure survives, the text does not. */
export function compactedToolSession(rounds: number, keptRounds: number): WireTurn[] {
  const contents: WireTurn[] = [userTurn("MARKER-COMPACTION-SUMMARY")];
  for (let round = rounds - keptRounds + 1; round <= rounds; round++) contents.push(...toolRoundTrip(round));
  contents.push(userTurn());
  return contents;
}
