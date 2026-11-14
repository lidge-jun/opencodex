/**
 * Antigravity desktop app (2.15+): ~/.antigravity/settings.json "gateway" block.
 * Field facts and the stash-and-restore idea follow Magpie (MIT, (c) yetone), internal/agent/antigravity.go.
 */
import { join } from "node:path";
import {
  GATEWAY_PLACEHOLDER_KEY, adminGatewayOverride, dropStash, envGatewayOverride, mkdirTracked, normalizeUrl,
  readBytes, readStash, removeFile, rmdirsIfEmpty, sha256, writeBytes, writeStash,
} from "./io";
import { GATEWAY_NOTE_TEXT, gatewayNote, type GatewayClientConnector, type GatewayClientContext, type GatewayClientResult, type GatewayClientStatus, type GatewayNoteCode, type GatewayTarget } from "./types";

type Json = Record<string, unknown>;
interface Prior { present: boolean; value?: unknown }
interface Stash {
  version: 1;
  path: string;
  originalBytes: string | null;
  createdDirs: string[];
  prior: { gateway: Prior; defaultModelId: Prior; list: Prior; modelsPresent: boolean };
  written: { gateway: unknown; defaultModelId: string | null };
  writtenSha256: string;
}

const ID = "antigravity";
const BOM = String.fromCharCode(0xfeff);
const settingsPath = (ctx: GatewayClientContext) => join(ctx.home, ".antigravity", "settings.json");
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const prior = (o: Json | undefined, k: string): Prior => o && k in o ? { present: true, value: o[k] } : { present: false };

interface Parsed { doc: Json; indent: string | number | undefined; eol: string; trailing: boolean; bom: boolean }
/** A note code instead of a parse when the file cannot be round-tripped. */
function parseSettings(bytes: Buffer | null): Parsed | GatewayNoteCode {
  if (!bytes) return { doc: {}, indent: 2, eol: "\n", trailing: true, bom: false };
  let text = bytes.toString("utf8");
  const bom = text.startsWith(BOM);
  if (bom) text = text.slice(1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let doc: unknown = {};
  if (text.trim() !== "") {
    try { doc = JSON.parse(text); } catch {
      return "settings-not-json";
    }
  }
  if (!isObj(doc)) return "settings-not-object";
  const m = /\n([ \t]+)\S/.exec(text);
  const indent = m ? m[1] : text.trim().includes("\n") || text.trim().length <= 2 ? 2 : undefined;
  return { doc, indent, eol, trailing: text === "" || /\n\s*$/.test(text), bom };
}

function serialize(p: Parsed): Buffer {
  let text = JSON.stringify(p.doc, null, p.indent);
  if (p.eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  return Buffer.from((p.bom ? BOM : "") + text + (p.trailing ? p.eol : ""));
}

function ours(gw: unknown, target?: GatewayTarget): "match" | "other-url" | "no" {
  if (!isObj(gw) || gw.enabled !== true) return "no";
  if (target && normalizeUrl(gw.url) === normalizeUrl(target.url)) return "match";
  if (!target) return gw.apiKey === GATEWAY_PLACEHOLDER_KEY ? "match" : "no";
  return gw.apiKey === GATEWAY_PLACEHOLDER_KEY ? "other-url" : "no";
}

function status(ctx: GatewayClientContext, target?: GatewayTarget): GatewayClientStatus {
  const path = settingsPath(ctx);
  const bytes = readBytes(path);
  const parsed = parseSettings(bytes);
  const gw = typeof parsed === "string" ? undefined : parsed.doc.gateway;
  const stash = readStash<Stash>(ctx, ID);
  const match = ours(gw, target) === "match";
  const state = match ? "connected" : stash ? "drifted" : "disconnected";
  const overrides: GatewayClientStatus["overrides"] = [];
  const admin = adminGatewayOverride(ctx);
  if (admin) overrides.push(admin);
  const env = envGatewayOverride(ctx, target?.url);
  if (env) overrides.push(env);
  const notes = (["restart-app", "no-google-sign-in", "agy-follows-app"] as GatewayNoteCode[]).map(gatewayNote);
  if (typeof parsed === "string") notes.push(gatewayNote(parsed));
  if (match && !stash) notes.push(gatewayNote("no-restore-record"));
  const models = typeof parsed === "string" || !isObj(parsed.doc.models) ? undefined : parsed.doc.models;
  const defaultModel = typeof models?.defaultModelId === "string" ? models.defaultModelId : undefined;
  return { id: ID, label: "Antigravity", state, files: [{ path, role: "user settings", exists: bytes !== null }], overrides, notes, ...(defaultModel ? { defaultModel } : {}) };
}

const fail = (code: GatewayClientResult["code"], message: string): GatewayClientResult =>
  ({ ok: false, code, message, changed: false, changedFiles: [], notes: [] });

function connect(ctx: GatewayClientContext, target: GatewayTarget): GatewayClientResult {
  const path = settingsPath(ctx);
  const bytes = readBytes(path);
  const parsed = parseSettings(bytes);
  if (typeof parsed === "string") return fail("unsupported-file", GATEWAY_NOTE_TEXT[parsed]);
  const { doc } = parsed;
  let stash = readStash<Stash>(ctx, ID);
  const keep = stash !== null && ours(doc.gateway, undefined) === "match";
  const models = isObj(doc.models) ? doc.models : undefined;
  const dir = join(ctx.home, ".antigravity");
  let newDirs: string[] = [];
  try { newDirs = mkdirTracked(dir); } catch (error) { return fail("io-error", `Could not create ${dir}: ${(error as Error).message}`); }
  if (!keep) {
    stash = {
      version: 1, path, originalBytes: bytes ? bytes.toString("base64") : null, createdDirs: [...(stash?.createdDirs ?? []), ...newDirs],
      prior: { gateway: prior(doc, "gateway"), defaultModelId: prior(models, "defaultModelId"), list: prior(models, "list"), modelsPresent: models !== undefined },
      written: { gateway: null, defaultModelId: null }, writtenSha256: "",
    };
  }
  const gateway = { enabled: true, url: target.url, apiKey: target.apiKey, wireProtocol: "openai" };
  doc.gateway = gateway;
  if (target.defaultModel || models?.list !== undefined) {
    const m: Json = models ?? {};
    if (target.defaultModel) m.defaultModelId = target.defaultModel;
    delete m.list;
    doc.models = m;
  }
  const out = serialize(parsed);
  const next = stash as Stash;
  next.written = { gateway, defaultModelId: target.defaultModel ?? (keep ? next.written.defaultModelId : null) };
  next.writtenSha256 = sha256(out);
  try {
    writeStash(ctx, ID, next);
    writeBytes(path, out);
  } catch (error) { return fail("io-error", `Could not write ${path}: ${(error as Error).message}`); }
  const unchanged = bytes !== null && sha256(bytes) === next.writtenSha256;
  return { ok: true, changed: !unchanged, changedFiles: unchanged ? [] : [path], message: "Antigravity now uses the OpenCodex gateway. Restart Antigravity to apply it.", notes: status(ctx, target).notes };
}

function disconnect(ctx: GatewayClientContext): GatewayClientResult {
  const stash = readStash<Stash>(ctx, ID);
  if (!stash) return { ok: true, changed: false, changedFiles: [], restore: "none", message: "Not connected by OpenCodex; nothing was changed.", notes: [] };
  const path = stash.path;
  const bytes = readBytes(path);
  const done = (restore: "exact" | "path-wise" | "none", message: string, files: string[]): GatewayClientResult => {
    dropStash(ctx, ID);
    return { ok: true, changed: files.length > 0, changedFiles: files, restore, message, notes: [gatewayNote("restart-app")] };
  };
  if (bytes && sha256(bytes) === stash.writtenSha256) {
    if (stash.originalBytes === null) { removeFile(path); rmdirsIfEmpty(stash.createdDirs); }
    else writeBytes(path, Buffer.from(stash.originalBytes, "base64"));
    return done("exact", "Antigravity settings restored byte for byte.", [path]);
  }
  if (!bytes) return done("none", "The settings file is already gone; the restore record was cleared.", []);
  const parsed = parseSettings(bytes);
  if (typeof parsed === "string") return { ok: false, code: "unsupported-file", message: `${GATEWAY_NOTE_TEXT[parsed]} The restore record was kept.`, changed: false, changedFiles: [], notes: [] };
  const { doc } = parsed;
  const kept: string[] = [];
  if (same(doc.gateway, stash.written.gateway)) {
    if (stash.prior.gateway.present) doc.gateway = stash.prior.gateway.value; else delete doc.gateway;
  } else kept.push("gateway");
  const models = isObj(doc.models) ? doc.models : undefined;
  if (models && stash.written.defaultModelId !== null) {
    if (models.defaultModelId === stash.written.defaultModelId) {
      if (stash.prior.defaultModelId.present) models.defaultModelId = stash.prior.defaultModelId.value; else delete models.defaultModelId;
    } else kept.push("models.defaultModelId");
  }
  if (stash.prior.list.present) {
    const m: Json = models ?? {};
    if (!("list" in m)) m.list = stash.prior.list.value; else kept.push("models.list");
    doc.models = m;
  }
  const finalModels = isObj(doc.models) ? doc.models : undefined;
  if (finalModels && Object.keys(finalModels).length === 0 && !stash.prior.modelsPresent) delete doc.models;
  writeBytes(path, serialize(parsed));
  return done("path-wise", `The file changed after OpenCodex wrote it, so only the gateway, models.defaultModelId and models.list entries were restored; your other edits were kept.${kept.length ? ` Left as you had them: ${kept.join(", ")}.` : ""}`, [path]);
}

export const ANTIGRAVITY_CONNECTOR: GatewayClientConnector = { id: ID, label: "Antigravity", status, connect, disconnect };
