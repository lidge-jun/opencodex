import { normalizeRequestBodyFacts, type RequestBodyEncoding, type RequestBodyFacts } from "../usage/request-body";

export { requestBodyField } from "../usage/request-body";

/** The row side: `requestBody` on RequestLogEntry. */
export interface RequestBodyEntryField { requestBody?: RequestBodyFacts }

/**
 * Where the shared JSON body reader leaves what it measured for a request, so the request's log row
 * can carry it (#3023). One holder per Request object: the admitted-turn wrapper binds the holder of
 * the request it hands to the handler to that request's log context, and the reader fills the holder
 * of the request it reads. Nothing is retained beyond the Request itself (WeakMap).
 */
export interface RequestBodyFactsHolder { facts?: RequestBodyFacts }

const holders = new WeakMap<Request, RequestBodyFactsHolder>();

export function requestBodyFactsHolder(req: Request): RequestBodyFactsHolder {
  let holder = holders.get(req);
  if (!holder) { holder = {}; holders.set(req, holder); }
  return holder;
}

function encodingOf(header: string | null): RequestBodyEncoding | null {
  const value = (header ?? "").trim().toLowerCase();
  if (value === "" || value === "identity") return "identity";
  if (value === "x-gzip") return "gzip";
  return value === "zstd" || value === "gzip" || value === "deflate" ? value : null;
}

/** Called once a body was read and decoded in full. */
export function recordRequestBodyFacts(req: Request, wireBytes: number, contentEncoding: string | null, decodedBytes: number): void {
  const encoding = encodingOf(contentEncoding);
  if (encoding === null) return;
  const facts = normalizeRequestBodyFacts({ wireBytes, encoding, decodedBytes });
  if (facts) requestBodyFactsHolder(req).facts = facts;
}

/** The log context side: the facts of the request the turn read, if it read one. */
export interface RequestBodyLogContext {
  /** Internal holder; never serialized. */
  requestBodyHolder?: RequestBodyFactsHolder;
}

export function requestBodyLogField(logCtx: RequestBodyLogContext): { requestBody?: RequestBodyFacts } {
  const facts = logCtx.requestBodyHolder?.facts;
  return facts ? { requestBody: { ...facts } } : {};
}
