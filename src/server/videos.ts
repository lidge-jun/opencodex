/**
 * Public OpenAI Videos API routes (#9110): `POST /v1/videos`, `GET /v1/videos/{id}` and
 * `GET /v1/videos/{id}/content`.
 *
 * A request's `model` selects the destination the way a routed model does: `<provider>/<model>`
 * names a configured row, and a bare model goes to `images.videoProvider`. The row must pass the
 * same validation as the `video_gen` bridge destination (`resolveVideoProviderRow`) and must opt in
 * with `videoApi: "openai"`; nothing else serves these routes, and a refused row never falls back.
 * The returned job `id` is an OCX handle (`video-handle.ts`) that brings poll and content back to
 * that row with that row's key. A configured key's provider/model scope is checked on all three
 * routes before any credential is used. Usage is recorded through the request log the dispatcher
 * writes for each call.
 */
import { formatErrorResponse } from "../bridge";
import { sanitizeUpstreamErrorText } from "../adapters/upstream-http-error";
import {
  createOpenAiVideo,
  fetchOpenAiVideoContent,
  OPENAI_VIDEO_CONTENT_VARIANTS,
  retrieveOpenAiVideo,
  VideoUpstreamError,
} from "../images/openai-video-client";
import { resolveVideoProviderRow } from "../images/plan";
import type { VideoOutboundDependencies, VideoProviderAuth } from "../images/xai-video-client";
import type { OcxConfig } from "../types";
import { admissionScopeDenial } from "./admission-model-scope";
import type { DataPlaneAdmission } from "./auth-cors";
import type { RequestLogContext } from "./request-log";
import { readBoundedRequestBodyBytes, readJsonRequestBody, resolveInboundBodyLimitBytes } from "./request-decompress";
import { decodeRequestErrorResponse } from "./responses";
import { ensureVideoHandleKey, isVideoHandleKeyError, openVideoHandle, sealVideoHandle, videoHandleClaimsError, videoHandlePrincipal } from "./video-handle";
import { safeXaiErrorDetail } from "../images/xai-upstream-error";
import type { VideoRoute } from "./video-routes";

let outboundDependencies: VideoOutboundDependencies = {};

/** Test seam: inject DNS and the pinned transport so route tests never open a socket. */
export function setVideoOutboundDependenciesForTests(dependencies: VideoOutboundDependencies | undefined): void {
  outboundDependencies = dependencies ?? {};
}

/** Largest rendered asset relayed from `/content` (matches the bridge's video artifact cap). */
export const VIDEO_CONTENT_MAX_BYTES = 200 * 1024 * 1024;
/** Largest multipart `input_reference` file accepted (OpenAI's documented data URL bound is 20 MiB). */
const MAX_INPUT_REFERENCE_BYTES = 15 * 1024 * 1024;
const INPUT_REFERENCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const CONTENT_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "image/png", "image/jpeg", "image/webp", "application/json"]);

type Target = { providerName: string; modelId: string | undefined; auth: VideoProviderAuth };

function invalid(message: string): Response {
  return formatErrorResponse(400, "invalid_request_error", message);
}

/** Resolve and validate the row for a provider name; every refusal is final. */
function videoRow(config: OcxConfig, providerName: string): { auth: VideoProviderAuth } | Response {
  const selection = resolveVideoProviderRow(config, providerName, `video provider "${providerName}"`);
  if (!selection.ok) {
    return /is paused/.test(selection.error)
      ? formatErrorResponse(403, "permission_error", selection.error)
      : invalid(selection.error);
  }
  if (selection.auth.videoApi !== "openai") {
    return invalid(`video provider "${providerName}" does not serve the OpenAI Videos API; set "videoApi": "openai" on it`);
  }
  return { auth: selection.auth };
}

function resolveCreateTarget(config: OcxConfig, model: string | undefined): Target | Response {
  let providerName: string | undefined;
  let modelId = model;
  // A model with a slash always names its provider first: `<provider>/<model>`, where the model part may
  // contain more slashes. An unknown prefix is refused rather than sent whole to images.videoProvider,
  // so a typo never reaches a different paid backend.
  const slash = model?.indexOf("/") ?? -1;
  if (model !== undefined && slash >= 0) {
    const prefix = model.slice(0, slash);
    if (!prefix || !Object.prototype.hasOwnProperty.call(config.providers, prefix)) {
      return invalid(`model "${model.slice(0, 80)}" names no configured provider; write <provider>/<model>`);
    }
    providerName = prefix;
    modelId = model.slice(slash + 1) || undefined;
  }
  if (providerName === undefined) {
    const configured = config.images?.videoProvider;
    if (typeof configured === "string" && configured.trim()) providerName = configured.trim();
  }
  if (providerName === undefined) {
    return invalid("no video provider: name one in model as <provider>/<model>, or set images.videoProvider");
  }
  const row = videoRow(config, providerName);
  if (row instanceof Response) return row;
  return { providerName, modelId, auth: row.auth };
}

/** Upstream and transport failures, mapped without reflecting raw upstream text or URLs. */
function failureResponse(error: unknown, req: Request, what: string): Response {
  if (req.signal.aborted) return formatErrorResponse(499, "client_closed_request", `${what} canceled by client`);
  if (error instanceof VideoUpstreamError) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    return formatErrorResponse(status, "upstream_error", `${what} failed: upstream returned ${error.status}${error.detail ? `: ${error.detail}` : ""}`);
  }
  if (error instanceof Error && error.name === "TimeoutError") return formatErrorResponse(504, "upstream_error", `${what} timed out`);
  const message = sanitizeUpstreamErrorText(error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[upstream-url]")
    .slice(0, 300);
  return formatErrorResponse(502, "upstream_error", `${what} failed: ${message}`);
}

async function readMultipartCreateBody(req: Request, maxBytes: number): Promise<Record<string, unknown> | Response> {
  const bytes = await readBoundedRequestBodyBytes(req, maxBytes);
  let form: FormData;
  try {
    form = await new Response(bytes as unknown as BodyInit, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return invalid("Invalid multipart body");
  }
  const body: Record<string, unknown> = {};
  for (const [name, entry] of form.entries()) {
    const value = entry as unknown as string | File;
    if (Object.prototype.hasOwnProperty.call(body, name)) return invalid(`multipart field ${name.slice(0, 64)} is repeated`);
    if (typeof value === "string") { body[name] = value; continue; }
    // The one file the Videos API takes. It becomes the JSON form, a data URL in image_url.
    if (name !== "input_reference") return invalid(`multipart file field ${name.slice(0, 64)} is not supported`);
    const type = value.type.toLowerCase().split(";")[0]!.trim();
    if (!INPUT_REFERENCE_TYPES.has(type)) return invalid("input_reference must be a PNG, JPEG or WebP image");
    if (value.size > MAX_INPUT_REFERENCE_BYTES) return invalid("input_reference image is too large");
    body.input_reference = { image_url: `data:${type};base64,${Buffer.from(await value.arrayBuffer()).toString("base64")}` };
  }
  return body;
}

async function handleCreate(req: Request, config: OcxConfig, logCtx: RequestLogContext, admission: DataPlaneAdmission): Promise<Response> {
  const limit = resolveInboundBodyLimitBytes(config.maxInboundBodyBytes);
  let body: unknown;
  try {
    body = /^multipart\/form-data\b/i.test(req.headers.get("content-type") ?? "")
      ? await readMultipartCreateBody(req, limit)
      : await readJsonRequestBody(req, undefined, limit);
  } catch (error) {
    return decodeRequestErrorResponse(error, "videos");
  }
  if (body instanceof Response) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  if (fields.model !== undefined && (typeof fields.model !== "string" || !fields.model.trim())) return invalid("model must be a nonblank string");
  if (typeof fields.prompt !== "string" || !fields.prompt.trim()) return invalid("prompt is required and must not be empty");
  const requested = fields.model as string | undefined;
  if (requested) logCtx.model = requested;

  const principal = videoHandlePrincipal(admission, req.headers);
  if (principal === undefined) return formatErrorResponse(401, "authentication_error", "opencodex API key required");
  const target = resolveCreateTarget(config, requested);
  if (target instanceof Response) return target;
  const claimsError = videoHandleClaimsError(target.providerName, target.modelId);
  if (claimsError) return invalid(claimsError);
  const denial = admissionScopeDenial(config, admission, requested, { providerName: target.providerName, modelId: target.modelId });
  if (denial) return denial;
  logCtx.provider = target.providerName;
  logCtx.model = target.modelId ?? "video";

  const upstreamBody: Record<string, unknown> = { ...fields };
  if (target.modelId === undefined) delete upstreamBody.model;
  else upstreamBody.model = target.modelId;
  // The handle must be sealable before anything is paid for: a key failure here sends nothing.
  ensureVideoHandleKey();
  let job: Record<string, unknown>;
  try {
    // Video creation is paid, non-idempotent work: one attempt, no retry.
    job = await createOpenAiVideo(upstreamBody, target.auth, req.signal, outboundDependencies);
  } catch (error) {
    return failureResponse(error, req, "video create");
  }
  const handle = sealVideoHandle({
    provider: target.providerName, upstreamId: job.id as string, ...(target.modelId !== undefined ? { model: target.modelId } : {}),
  }, principal);
  return Response.json(publicVideoJob(job, handle, target.modelId));
}

const SAFE_STATUS = /^[a-z_]{1,32}$/;
const SAFE_SECONDS = /^\d{1,4}$/;
const SAFE_SIZE = /^\d{2,5}x\d{2,5}$/;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * The public job object: an allowlist of the OpenAI Videos fields, each held to a closed shape, with
 * the OCX handle as `id` and the model OCX sent. No upstream free text passes through: an error keeps
 * a token-shaped code and an allowlisted detail, or a generic message, so an upstream that echoes a
 * credential or arbitrary text in any field cannot hand it to the caller.
 */
function publicVideoJob(job: Record<string, unknown>, handle: string, model: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { id: handle, object: "video" };
  if (model !== undefined) out.model = model;
  for (const field of ["created_at", "completed_at", "expires_at"] as const) {
    const value = job[field];
    if (value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) out[field] = value;
  }
  if (typeof job.progress === "number" && Number.isFinite(job.progress)) out.progress = Math.max(0, Math.min(100, Math.round(job.progress)));
  if (typeof job.status === "string" && SAFE_STATUS.test(job.status)) out.status = job.status;
  if (typeof job.seconds === "string" && SAFE_SECONDS.test(job.seconds)) out.seconds = job.seconds;
  else if (typeof job.seconds === "number" && Number.isInteger(job.seconds) && job.seconds >= 0 && job.seconds < 10_000) out.seconds = String(job.seconds);
  if (typeof job.size === "string" && SAFE_SIZE.test(job.size)) out.size = job.size;
  const error = job.error;
  if (error === null) out.error = null;
  else if (error && typeof error === "object" && !Array.isArray(error)) {
    const e = error as { code?: unknown; message?: unknown };
    out.error = {
      ...(typeof e.code === "string" && SAFE_CODE.test(e.code) ? { code: e.code } : {}),
      message: safeXaiErrorDetail(e.message) ?? "video generation failed",
    };
  }
  return out;
}

async function openHandle(
  req: Request,
  config: OcxConfig,
  handle: string,
  logCtx: RequestLogContext,
  admission: DataPlaneAdmission,
): Promise<{ claims: { provider: string; upstreamId: string; model?: string }; auth: VideoProviderAuth } | Response> {
  const principal = videoHandlePrincipal(admission, req.headers);
  const claims = principal === undefined ? undefined : openVideoHandle(handle, principal);
  if (!claims) return formatErrorResponse(404, "not_found", "video not found");
  logCtx.provider = claims.provider;
  logCtx.model = claims.model ?? "video";
  const row = videoRow(config, claims.provider);
  if (row instanceof Response) return row;
  const requested = claims.model === undefined ? undefined : `${claims.provider}/${claims.model}`;
  const denial = admissionScopeDenial(config, admission, requested, { providerName: claims.provider, modelId: claims.model });
  if (denial) return denial;
  return { claims, auth: row.auth };
}

async function handleRetrieve(req: Request, config: OcxConfig, handle: string, logCtx: RequestLogContext, admission: DataPlaneAdmission): Promise<Response> {
  const opened = await openHandle(req, config, handle, logCtx, admission);
  if (opened instanceof Response) return opened;
  try {
    const job = await retrieveOpenAiVideo(opened.claims.upstreamId, opened.auth, req.signal, outboundDependencies);
    return Response.json(publicVideoJob(job, handle, opened.claims.model));
  } catch (error) {
    return failureResponse(error, req, "video retrieve");
  }
}

function cappedBody(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new Error("video content exceeds size cap"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

async function handleContent(req: Request, url: URL, config: OcxConfig, handle: string, logCtx: RequestLogContext, admission: DataPlaneAdmission): Promise<Response> {
  const variant = url.searchParams.get("variant") ?? undefined;
  if (variant !== undefined && !OPENAI_VIDEO_CONTENT_VARIANTS.has(variant)) return invalid("variant must be video, thumbnail or spritesheet");
  const opened = await openHandle(req, config, handle, logCtx, admission);
  if (opened instanceof Response) return opened;
  let upstream: Response;
  try {
    upstream = await fetchOpenAiVideoContent(opened.claims.upstreamId, opened.auth, {
      signal: req.signal, ...(variant !== undefined ? { variant } : {}),
    }, outboundDependencies);
  } catch (error) {
    return failureResponse(error, req, "video content");
  }
  const declared = upstream.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > VIDEO_CONTENT_MAX_BYTES) {
    try { await upstream.body?.cancel(); } catch { /* ignore */ }
    return formatErrorResponse(502, "upstream_error", "video content exceeds size cap");
  }
  const type = (upstream.headers.get("content-type") ?? "").toLowerCase().split(";")[0]!.trim();
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES.has(type) && type !== "application/json" ? type : "application/octet-stream",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (declared !== null && /^\d+$/.test(declared)) headers["content-length"] = declared;
  return new Response(upstream.body ? cappedBody(upstream.body, VIDEO_CONTENT_MAX_BYTES) : null, { status: 200, headers });
}

export async function handleVideos(
  req: Request,
  url: URL,
  config: OcxConfig,
  route: VideoRoute,
  logCtx: RequestLogContext,
  admission: DataPlaneAdmission,
): Promise<Response> {
  try {
    if (route.kind === "create") return await handleCreate(req, config, logCtx, admission);
    if (route.kind === "retrieve") return await handleRetrieve(req, config, route.handle, logCtx, admission);
    return await handleContent(req, url, config, route.handle, logCtx, admission);
  } catch (error) {
    // The handle key file is the one local failure left; it names no secret.
    if (isVideoHandleKeyError(error)) {
      console.error("[videos] " + (error as Error).message);
      return formatErrorResponse(500, "server_error", "video handle key is unavailable");
    }
    throw error;
  }
}
