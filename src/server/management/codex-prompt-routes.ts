/**
 * /api/codex-prompt — the Codex prompt-layer surface.
 *
 * This route is an adapter over `src/codex/prompt-layers.ts`. It owns three
 * things the core module deliberately does not: the projection of
 * `LAYER_INVENTORY` into a DTO, request-shape and size policy, and the
 * translation of a `WriteError` into an HTTP status. It owns no file access of
 * its own and defines no second inventory.
 *
 * Privacy: the snapshot carries file paths and the user's own prompt text —
 * text they typed into this same dashboard. It carries no token, API key, or
 * account identifier, and nothing here is written to a log sink.
 *
 * Auth: the standard management gate covers /api/**, and unsafe methods already
 * require Origin + CSRF. This is a local-config write, not an action that spends
 * the user's GitHub identity, so it does NOT carry the `agent_consent_required`
 * treatment `sidebar-routes.ts` applies to starring.
 *
 * Plan: devlog/_plan/260802_codex_set_prompt_composer/020 + 021 (021 supersedes
 * 020 wherever the landed WP1 module moved).
 */
import { jsonResponse } from "../auth-cors";
import { readFileSync } from "node:fs";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import {
  LAYER_INVENTORY,
  MAX_BASE_VARIANTS,
  adoptDeveloperInstructions,
  composeProjection,
  computePromptProbeStateFingerprint,
  findInvalidCharacter,
  inspectOwnership,
  normalizeBody,
  previewAdopt,
  previewSalvage,
  readPromptLayers,
  salvageProjection,
  selectBaseVariant,
  setToggle,
  writeBaseVariant,
  writeCustomLayers,
  type BaseSelection,
  type CustomLayer,
  type Paths,
  type PromptLayerSnapshot,
  type WriteError,
  type WriteResult,
} from "../../codex/prompt-layers";

/**
 * Third-party extension layers cannot be enumerated (devlog 001 class E), and no
 * WP1 export can say so — it is a statement about what opencodex can know, not
 * about the user's file. Stating it explicitly beats implying the inventory is
 * exhaustive. If class E ever becomes enumerable, this constant is what changes.
 */
const EXTENSION_LAYERS_ENUMERABLE = false;

/** Route policy, not a Codex limit: Codex validates nothing beyond readable-and-non-empty. */
const MAX_LAYERS = 32;
const MAX_TITLE_CHARS = 80;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMPOSED_BYTES = 128 * 1024;

const LAYER_ID = /^[a-z0-9]{6}$/;

/**
 * Every WriteError gets a status. This is a Record, not a switch with a default:
 * a variant added to the union upstream breaks `bun run typecheck` here instead
 * of silently becoming a 500 in front of a user.
 */
const WRITE_ERROR_STATUS: Record<WriteError, number> = {
  config_unreadable: 409,
  stale_revision: 409,
  developer_instructions_not_owned: 409,
  unknown_layer: 400,
  store_unreadable: 409,
  invalid_characters: 400,
  write_superseded: 409,
  // Not the caller's fault and not a race: the filesystem refused the write and the
  // transaction rolled itself back. 500 rather than 409 — retrying the same request
  // unchanged will fail the same way until the disk or the path is fixed.
  write_failed: 500,
  recovery_required: 409,
  locked: 409,
};

/** Read-only view for the route test that asserts every mapping is a client error. */
export const WRITE_ERROR_STATUS_FOR_TESTS: Readonly<Record<WriteError, number>> = WRITE_ERROR_STATUS;

function fail(ctx: ManagementContext, code: string, status: number, message?: string, extra?: Record<string, unknown>): Response {
  return jsonResponse({ ok: false, code, ...(message ? { message } : {}), ...(extra ?? {}) }, status, ctx.req, ctx.config);
}

function failWrite(ctx: ManagementContext, result: Extract<WriteResult, { ok: false }>): Response {
  return fail(ctx, result.error, WRITE_ERROR_STATUS[result.error], result.detail);
}

function paths(ctx: ManagementContext): Paths | undefined {
  return ctx.deps.codexPromptPaths;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** The DTO. `inventory` is `LAYER_INVENTORY` serialized — never a second table. */
function serialize(snapshot: PromptLayerSnapshot, configBytes: string | null): Record<string, unknown> {
  return {
    configPath: snapshot.configPath,
    storePath: snapshot.storePath,
    configExists: snapshot.configExists,
    readable: snapshot.readable,
    developerInstructionsOwned: snapshot.developerInstructionsOwned,
    /**
     * `developerInstructionsOwned: false` conflates two very different states: the
     * key is ABSENT (an ordinary first run - the first write creates it) and the key
     * is EXTERNAL (someone else wrote it, and we must not overwrite it). A GUI that
     * cannot tell them apart hides its own create affordance from every new user,
     * which is exactly what happened. The state is named here rather than guessed
     * there.
     */
    developerInstructionsState: inspectOwnership(configBytes).state,
    drift: snapshot.drift,
    revision: snapshot.revision,
    inventory: LAYER_INVENTORY.map(d => ({
      id: d.id,
      class: d.class,
      key: d.key,
      default: d.default,
      order: d.order,
    })),
    toggles: snapshot.toggles,
    extensionLayersEnumerable: EXTENSION_LAYERS_ENUMERABLE,
    custom: snapshot.custom,
    modelInstructionsFile: snapshot.modelInstructionsFile,
    baseVariants: snapshot.baseVariants,
    /**
     * Three-valued on purpose. `external` is not folded into `default`: the key being
     * set to somebody else's file means the base prompt IS replaced, and reporting that
     * as "Codex's own prompt" would be a lie the GUI then repeats to the user.
     */
    baseSelection: snapshot.baseSelection,
    maxBaseVariants: MAX_BASE_VARIANTS,
  };
}

/** Re-read the bytes the snapshot was derived from, so the DTO can name the ownership state. */
function configBytesOf(snapshot: PromptLayerSnapshot): string | null {
  if (!snapshot.configExists) return null;
  try {
    return readFileSync(snapshot.configPath, "utf8");
  } catch {
    return null;
  }
}

function ok(ctx: ManagementContext, changed: boolean, snapshot: PromptLayerSnapshot): Response {
  return jsonResponse({ ok: true, changed, snapshot: serialize(snapshot, configBytesOf(snapshot)) }, 200, ctx.req, ctx.config);
}

/** Re-read after a mutation so the GUI can publish server truth, not optimistic state. */
function settle(ctx: ManagementContext, result: WriteResult): Response {
  return result.ok ? ok(ctx, result.changed, result.snapshot) : failWrite(ctx, result);
}

type ValidationError = { code: string; message: string; extra?: Record<string, unknown> };

/**
 * Request validation, entirely before any file access. WP1 validates characters
 * and normalizes; shape and size policy is the route's, and the GUI's identical
 * client-side rules are courtesy — this is the boundary.
 */
function validateLayers(raw: unknown): { layers: CustomLayer[] } | { error: ValidationError } {
  if (!Array.isArray(raw)) return { error: { code: "invalid_body", message: "layers must be an array" } };
  if (raw.length > MAX_LAYERS) {
    return { error: { code: "too_many_layers", message: `at most ${MAX_LAYERS} layers` } };
  }
  const seen = new Set<string>();
  const layers: CustomLayer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: { code: "invalid_body", message: "each layer must be an object" } };
    }
    const v = entry as Record<string, unknown>;
    if (typeof v.id !== "string" || !LAYER_ID.test(v.id)) {
      return { error: { code: "invalid_layer_id", message: "id must be six lowercase alphanumerics" } };
    }
    if (seen.has(v.id)) {
      return { error: { code: "duplicate_layer_id", message: `duplicate id ${v.id}` } };
    }
    seen.add(v.id);
    if (typeof v.title !== "string" || v.title.trim().length === 0
      || v.title.length > MAX_TITLE_CHARS || /[\r\n]/.test(v.title)) {
      return { error: { code: "invalid_title", message: "title must be 1-80 characters on a single line" } };
    }
    if (typeof v.body !== "string") {
      return { error: { code: "invalid_body", message: "body must be a string" } };
    }
    if (typeof v.enabled !== "boolean") {
      return { error: { code: "invalid_body", message: "enabled must be a boolean" } };
    }
    // Normalize first, then measure and scan: tabs and CRLF are normalized rather
    // than rejected, so the cap must apply to what would actually be stored.
    const body = normalizeBody(v.body);
    if (utf8Bytes(body) > MAX_BODY_BYTES) {
      return { error: { code: "body_too_large", message: `layer ${v.id} exceeds ${MAX_BODY_BYTES} bytes` } };
    }
    const invalid = findInvalidCharacter(body);
    if (invalid !== null) {
      return {
        error: {
          code: "invalid_characters",
          message: `layer ${v.id}: code point ${invalid.position} is a ${invalid.reason}`,
          extra: { layerId: v.id, position: invalid.position, reason: invalid.reason },
        },
      };
    }
    layers.push({ id: v.id, title: v.title, body, enabled: v.enabled });
  }
  const composed = composeProjection(layers);
  if (utf8Bytes(composed) > MAX_COMPOSED_BYTES) {
    return { error: { code: "composed_too_large", message: `composed prompt exceeds ${MAX_COMPOSED_BYTES} bytes` } };
  }
  return { layers };
}

function revisionOf(body: Record<string, unknown>): string | null {
  return typeof body.revision === "string" && body.revision.length > 0 ? body.revision : null;
}

/**
 * Adopt-shaped size policy, applied wherever a config value is imported as a
 * layer. The `owned-malformed` repair branch imports through the same WP1 call
 * as `/adopt`, so it must pass the same caps: a route that enforces a limit on
 * one path and not the other does not have a limit.
 *
 * Runs AFTER the read-only preview and BEFORE any write. The value being
 * measured lives in config.toml, so it cannot be checked before a read; both
 * limits are UTF-8 byte length, and the composed cap measures what
 * `composeProjection` will actually produce — the imported layer plus every
 * already-enabled custom layer.
 */
function adoptCapFailure(ctx: ManagementContext, decoded: string): Response | null {
  if (utf8Bytes(decoded) > MAX_BODY_BYTES) {
    return fail(ctx, "body_too_large", 400, `the existing value exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const existing = readPromptLayers(paths(ctx)).custom;
  const composed = composeProjection([
    { id: "adopted", title: "Imported from config.toml", body: decoded, enabled: true },
    ...existing,
  ]);
  if (utf8Bytes(composed) > MAX_COMPOSED_BYTES) {
    return fail(ctx, "composed_too_large", 400, `the composed prompt would exceed ${MAX_COMPOSED_BYTES} bytes`);
  }
  return null;
}

/**
 * Malformed JSON must be a 400, never an empty object. Swallowing a parse error
 * into `{}` made a syntactically invalid adopt or repair request return a
 * successful PREVIEW, and an invalid custom request return `stale_revision` —
 * two answers that describe neither the request nor the file.
 */
async function readBody(ctx: ManagementContext): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await readManagementJsonBody(ctx.req);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return null;
  }
}

export async function handleCodexPromptRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (!url.pathname.startsWith("/api/codex-prompt")) return null;

  // Every mutating verb on this surface requires a MINTED GUI SESSION, not merely a
  // request that passed the auth gate. The gate accepts the raw admin token before
  // it consults the session table (management-auth.ts:462), and this endpoint writes
  // the user's `$CODEX_HOME/config.toml` — the file that decides what the model
  // reads. A token any local process can read off disk is the wrong credential for
  // rewriting a prompt.
  //
  // Same principal check and the same honest limit as the star endpoint
  // (sidebar-routes.ts:42): a process running as the user can mint its own session
  // from the loopback dashboard bootstrap, and can edit config.toml directly without
  // this proxy at all. So this is not a technical barrier against a determined local
  // agent. What it removes is the CASUAL path — an agent that would have PUT here
  // because the endpoint existed and the token was lying in `~/.opencodex` — and it
  // makes the refusal legible instead of silent. The real boundary is normative and
  // lives in AGENTS.md.
  //
  // Reads stay open to the admin token: describing the prompt stack changes nothing,
  // and the dashboard's own cold load needs it.
  if (req.method !== "GET" && req.method !== "HEAD" && ctx.principal !== "gui-session") {
    return fail(
      ctx,
      "dashboard_session_required",
      403,
      "prompt layers are written from the dashboard; an admin token alone cannot rewrite config.toml",
    );
  }

  if (url.pathname === "/api/codex-prompt" && req.method === "GET") {
    // Pure read. A GET must never repair drift — it is reported here and
    // resolved only by an explicit, revision-checked POST.
    const snapshot = readPromptLayers(paths(ctx));
    return jsonResponse(serialize(snapshot, configBytesOf(snapshot)), 200, req, ctx.config);
  }

  if (url.pathname === "/api/codex-prompt/text" && req.method === "GET") {
    // The dialog used to claim Codex does not expose layer text. It does:
    // `codex debug prompt-input` renders the model-visible input list, and this
    // reads it. Bounded and fail-soft - an unavailable probe degrades to "we could
    // not read it", never to an error page.
    // No caller-supplied directory: the probe reads CODEX_HOME and nothing else.
    // A `cwd` parameter would have let any authenticated request read an arbitrary
    // folder's AGENTS.md through this endpoint.
    const { probePromptText } = await import("../../codex/prompt-text-probe");
    // A write can complete while an older probe is still running. Admission uses
    // a prompt-state fingerprint rather than the transaction revision: editing
    // the selected base variant changes its separate .md file without moving the
    // optimistic-concurrency revision.
    const promptStateFingerprint = computePromptProbeStateFingerprint(paths(ctx));
    return jsonResponse(await probePromptText(15_000, req.signal, promptStateFingerprint), 200, req, ctx.config);
  }

  if (url.pathname === "/api/codex-prompt/toggle" && req.method === "PUT") {
    const body = await readBody(ctx);
    if (!body) return fail(ctx, "invalid_body", 400, "expected a JSON object");
    const id = body.id;
    if (typeof id !== "string") return fail(ctx, "invalid_body", 400, "id must be a string");
    if (typeof body.enabled !== "boolean") return fail(ctx, "invalid_body", 400, "enabled must be a boolean");
    const revision = revisionOf(body);
    if (!revision) return fail(ctx, "stale_revision", 409, "revision required");

    // Derived from the inventory, not a hand-maintained deny-list: classes base,
    // feature-gated, runtime-conditional and extension-unknown are all covered by
    // one rule, and a new upstream layer is protected the day WP1 lists it. The
    // check must precede setToggle, which collapses every non-toggle id into
    // unknown_layer.
    const descriptor = LAYER_INVENTORY.find(d => d.id === id);
    if (!descriptor) return fail(ctx, "unknown_layer", 400, `no layer ${id}`);
    if (descriptor.class !== "config-toggle") {
      return fail(ctx, "layer_not_toggleable", 409, `${id} is ${descriptor.class} and has no switch`, {
        layerClass: descriptor.class,
      });
    }
    return settle(ctx, setToggle(id, body.enabled, revision, paths(ctx)));
  }

  if (url.pathname === "/api/codex-prompt/custom" && req.method === "PUT") {
    const body = await readBody(ctx);
    if (!body) return fail(ctx, "invalid_body", 400, "expected a JSON object");
    const revision = revisionOf(body);
    if (!revision) return fail(ctx, "stale_revision", 409, "revision required");
    const validated = validateLayers(body.layers);
    if ("error" in validated) {
      const status = validated.error.code === "invalid_characters" ? 400 : 400;
      return fail(ctx, validated.error.code, status, validated.error.message, validated.error.extra);
    }
    return settle(ctx, writeCustomLayers(validated.layers, revision, paths(ctx)));
  }

  if (url.pathname === "/api/codex-prompt/base/select" && req.method === "PUT") {
    const body = await readBody(ctx);
    if (!body) return fail(ctx, "invalid_body", 400, "expected a JSON object");
    const revision = revisionOf(body);
    if (!revision) return fail(ctx, "stale_revision", 409, "revision required");
    const kind = body.kind;
    // `external` is a state we REPORT, never one a caller may ask for: selecting it
    // would mean writing a path we do not own.
    if (kind !== "default" && kind !== "variant") {
      return fail(ctx, "invalid_body", 400, 'kind must be "default" or "variant"');
    }
    let selection: BaseSelection;
    if (kind === "default") {
      selection = { kind: "default" };
    } else {
      if (typeof body.id !== "string") return fail(ctx, "invalid_body", 400, "id must be a string");
      selection = { kind: "variant", id: body.id };
    }
    return settle(ctx, selectBaseVariant(selection, revision, paths(ctx)));
  }

  if (url.pathname === "/api/codex-prompt/base" && req.method === "PUT") {
    const body = await readBody(ctx);
    if (!body) return fail(ctx, "invalid_body", 400, "expected a JSON object");
    const revision = revisionOf(body);
    if (!revision) return fail(ctx, "stale_revision", 409, "revision required");
    // A null id CREATES; a string id edits. `default` is not an id, and the writer
    // rejects it independently - this check only makes the refusal legible.
    const id = body.id === null || body.id === undefined ? null : body.id;
    if (id !== null && typeof id !== "string") return fail(ctx, "invalid_body", 400, "id must be a string or null");
    if (id === "default") return fail(ctx, "unknown_layer", 400, "the default variant has no stored body");
    if (body.delete === true) {
      if (typeof id !== "string") return fail(ctx, "invalid_body", 400, "delete requires an id");
      return settle(ctx, writeBaseVariant({ id, delete: true }, revision, paths(ctx)));
    }
    if (typeof body.title !== "string") return fail(ctx, "invalid_body", 400, "title must be a string");
    if (typeof body.body !== "string") return fail(ctx, "invalid_body", 400, "body must be a string");
    return settle(ctx, writeBaseVariant({ id, title: body.title, body: body.body }, revision, paths(ctx)));
  }

  if (url.pathname === "/api/codex-prompt/adopt" && req.method === "POST") {
    const body = await readBody(ctx);
    if (!body) return fail(ctx, "invalid_body", 400, "expected a JSON object");
    // An unreadable file must say so. Both adopt and repair inspect read-derived
    // state before ever reaching WP1's own `config_unreadable`, so without this
    // the user was told "nothing to adopt" about a file we could not open.
    const readState = readPromptLayers(paths(ctx));
    if (!readState.readable) {
      return fail(ctx, "config_unreadable", 409, "the configuration file exists but could not be read", {
        path: readState.configPath,
      });
    }
    const preview = previewAdopt(paths(ctx));

    if (preview.reason === "nothing_to_adopt") {
      return fail(ctx, "nothing_to_adopt", 409, "developer_instructions is absent or already owned", {
        path: preview.path,
      });
    }
    if (preview.reason === "unsupported_form") {
      // Translated here because adoptDeveloperInstructions collapses this into
      // developer_instructions_not_owned, which would tell the user nothing about
      // where their text is or why it cannot be imported.
      return fail(ctx, "adopt_unsupported_form", 409, preview.detail, {
        path: preview.path,
        line: preview.line,
        rawLine: preview.rawLine,
      });
    }
    if (preview.reason === "invalid_characters") {
      return fail(ctx, "invalid_characters", 400, preview.detail, { path: preview.path, line: preview.line });
    }

    const capFailure = adoptCapFailure(ctx, preview.decodedBody ?? "");
    if (capFailure) return capFailure;

    if (body.confirm !== true) {
      // Preview writes nothing, by construction: previewAdopt is a pure read.
      return jsonResponse({
        ok: true,
        changed: false,
        preview: {
          rawLine: preview.rawLine,
          decodedBody: preview.decodedBody,
          path: preview.path,
          line: preview.line,
        },
      }, 200, req, ctx.config);
    }

    const revision = revisionOf(body);
    if (!revision) return fail(ctx, "stale_revision", 409, "revision required");
    return settle(ctx, adoptDeveloperInstructions(revision, paths(ctx)));
  }

  if (url.pathname === "/api/codex-prompt/repair" && req.method === "POST") {
    const body = await readBody(ctx);
    if (!body) return fail(ctx, "invalid_body", 400, "expected a JSON object");
    const snapshot = readPromptLayers(paths(ctx));
    const drift = snapshot.drift;
    if (!snapshot.readable) {
      return fail(ctx, "config_unreadable", 409, "the configuration file exists but could not be read", {
        path: snapshot.configPath,
      });
    }
    if (drift === null) return fail(ctx, "nothing_to_repair", 409, "no drift is present");

    const confirm = body.confirm === true;
    const revision = revisionOf(body);

    if (drift === "projection-stale") {
      if (!confirm) {
        return jsonResponse({
          ok: true,
          changed: false,
          preview: { drift, projection: composeProjection(snapshot.custom) },
        }, 200, req, ctx.config);
      }
      if (!revision) return fail(ctx, "stale_revision", 409, "revision required");
      return settle(ctx, writeCustomLayers(snapshot.custom, revision, paths(ctx)));
    }

    if (drift === "store-missing") {
      const preview = previewSalvage(paths(ctx));
      if (preview.reason !== "ok") {
        return fail(ctx, "nothing_to_repair", 409, "no live projection to salvage");
      }
      if (!confirm) {
        // backupDir, not a filename: a read-only preview must not reserve one.
        return jsonResponse({
          ok: true,
          changed: false,
          preview: {
            drift,
            body: preview.body,
            backupDir: preview.backupDir,
            unrecoverable: preview.unrecoverable,
          },
        }, 200, req, ctx.config);
      }
      if (!revision) return fail(ctx, "stale_revision", 409, "revision required");
      // Pre-check the revision against the snapshot we just read.
      // `salvageProjection` writes its durable backup BEFORE entering the
      // transaction that validates the revision (prompt-layers.ts:942-955), so a
      // stale tab would otherwise leave an orphan .salvage-*.txt behind on a
      // request that changes nothing. This closes the ordinary path; the narrow
      // race between this check and WP1's own is documented in devlog 021 §8.1
      // and is deliberately NOT fixed by reaching into WP1's write path.
      if (revision !== snapshot.revision) {
        return fail(ctx, "stale_revision", 409, "the configuration moved since it was read");
      }
      return settle(ctx, salvageProjection(revision, paths(ctx)));
    }

    if (drift === "owned-malformed") {
      const mode = body.mode;
      // Whitelist, not a single-value denial: an arbitrary or missing mode used to
      // fall through to adopt, so a client that sent `mode: "reset"` mutated the
      // file through a verb the contract never offered.
      if (mode !== undefined && mode !== "adopt" && mode !== "replace") {
        return fail(ctx, "invalid_body", 400, "mode must be \"adopt\" or \"replace\"", { drift });
      }
      if (mode === "replace") {
        // No WP1 export performs this. Writing one here would put a second write
        // path beside the journal transaction, in the one place in this unit where
        // a bug destroys a user's configuration.
        return fail(ctx, "repair_unsupported", 409,
          "replacing a reshaped developer_instructions is not supported from this route; edit the line by hand or adopt it", {
            drift, path: snapshot.configPath,
          });
      }
      const preview = previewAdopt(paths(ctx));
      if (preview.reason === "unsupported_form") {
        return fail(ctx, "adopt_unsupported_form", 409, preview.detail, {
          drift, path: preview.path, line: preview.line, rawLine: preview.rawLine,
        });
      }
      if (preview.reason !== "ok") {
        return fail(ctx, "nothing_to_repair", 409, "nothing to adopt", { drift });
      }
      if (!confirm) {
        return jsonResponse({
          ok: true,
          changed: false,
          preview: { drift, rawLine: preview.rawLine, decodedBody: preview.decodedBody, line: preview.line },
        }, 200, req, ctx.config);
      }
      if (!revision) return fail(ctx, "stale_revision", 409, "revision required");
      // Same import, same caps. This branch reaches adoptDeveloperInstructions
      // exactly as /adopt does, so skipping the size policy here would mean the
      // policy is bypassable by choosing the other endpoint. Proven by driving
      // the "BOTH import paths" test red with this call deleted.
      const capFailure = adoptCapFailure(ctx, preview.decodedBody ?? "");
      if (capFailure) return capFailure;
      return settle(ctx, adoptDeveloperInstructions(revision, paths(ctx)));
    }

    // journal-present: recovery lives inside WP1's commit and is not exported.
    // Any ordinary mutation replays it on its own path, so the honest answer is
    // to name the state rather than duplicate the transaction here.
    return fail(ctx, "repair_unsupported", 409,
      "a write journal is present; recovery runs automatically on the next write", {
        drift, storePath: snapshot.storePath,
      });
  }

  return null;
}
