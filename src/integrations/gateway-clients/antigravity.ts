/**
 * Antigravity desktop app (2.15+): ~/.antigravity/settings.json "gateway" block.
 * Field facts and the stash-and-restore idea follow Magpie (MIT, (c) yetone), internal/agent/antigravity.go.
 */
import { join } from "node:path";
import {
  GATEWAY_PLACEHOLDER_KEY, adminGatewayOverride, dropStash, envGatewayOverride, mkdirTracked, normalizeUrl,
  assertClientSize, checkedClientDestination, clientRefusal, inspectClientFile, inspectStashPresence, isRestoreFile, mutateClient,
  readClientFile, readStash, removeCreatedClientFile, rmdirsIfEmpty, sha256, writeClientFile, writeStash,
} from "./io";
import { GATEWAY_NOTE_TEXT, gatewayNote, type GatewayClientConnector, type GatewayClientContext, type GatewayClientResult, type GatewayClientStatus, type GatewayNoteCode, type GatewayTarget } from "./types";

type Json = Record<string, unknown>;
interface Prior { present: boolean; value?: unknown }
interface Written { written: { gateway: unknown; defaultModelId: string | null }; writtenSha256: string }
/**
 * `written`/`writtenSha256` is the last state known to be on disk; `pending` is a write that may or may not
 * have landed, journaled before it starts so an interrupted or failed write still leaves both recognisable.
 * `pathWiseOnly`: the user edited the file while connected, so disconnect never restores the old bytes.
 */
interface Stash extends Written {
  version: 1;
  path: string;
  resolvedPath?: string;
  originalBytes: string | null;
  createdDirs: string[];
  prior: { gateway: Prior; defaultModelId: Prior; list: Prior; modelsPresent: boolean };
  pending?: Written;
  pathWiseOnly?: true;
}
const statesOf = (stash: Stash): Written[] => [stash, ...(stash.pending ? [stash.pending] : [])];

const ID = "antigravity";
const BOM = String.fromCharCode(0xfeff);
const settingsPath = (ctx: GatewayClientContext) => join(ctx.home, ".antigravity", "settings.json");
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => Bun.deepEquals(a, b, true);
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
  const file = inspectClientFile(ctx, path);
  const parsed = parseSettings(file?.bytes ?? null);
  const gw = typeof parsed === "string" ? undefined : parsed.doc.gateway;
  const hasRecord = inspectStashPresence(ctx, ID);
  const match = ours(gw, target) === "match";
  const state = match ? "connected" : hasRecord || file === undefined ? "drifted" : "disconnected";
  const overrides: GatewayClientStatus["overrides"] = [];
  const admin = adminGatewayOverride(ctx);
  if (admin) overrides.push(admin);
  const env = envGatewayOverride(ctx, target?.url);
  if (env) overrides.push(env);
  const notes = (["restart-app", "no-google-sign-in", "agy-follows-app"] as GatewayNoteCode[]).map(gatewayNote);
  if (typeof parsed === "string") notes.push(gatewayNote(parsed));
  if (match && !hasRecord) notes.push(gatewayNote("no-restore-record"));
  const models = typeof parsed === "string" || !isObj(parsed.doc.models) ? undefined : parsed.doc.models;
  const defaultModel = typeof models?.defaultModelId === "string" ? models.defaultModelId : undefined;
  return { id: ID, label: "Antigravity", state, files: [{ path, role: "user settings", exists: file !== null }], overrides, notes, ...(defaultModel ? { defaultModel } : {}) };
}

function checkedStash(ctx: GatewayClientContext, path: string): Stash | null {
  const stash = readStash<Stash>(ctx, ID);
  if (stash && (stash.path !== path || !isRestoreFile(ctx.home, path, stash))) {
    throw new Error("Antigravity restore record does not name the expected settings file");
  }
  return stash;
}

function assertSameTarget(stash: Stash | null, target: string | undefined): void {
  if (target && stash?.resolvedPath && stash.resolvedPath !== target) {
    throw new Error("Antigravity settings now resolve to a different file");
  }
}

function connect(ctx: GatewayClientContext, target: GatewayTarget): GatewayClientResult {
  const path = settingsPath(ctx);
  const file = readClientFile(ctx, path);
  const bytes = file?.bytes ?? null;
  const parsed = parseSettings(bytes);
  if (typeof parsed === "string") return clientRefusal(GATEWAY_NOTE_TEXT[parsed], "unsupported-file");
  const { doc } = parsed;
  let stash = checkedStash(ctx, path);
  assertSameTarget(stash, file?.target);
  const keep = stash !== null && ours(doc.gateway, undefined) === "match";
  const onDisk = keep && file ? statesOf(stash!).find(st => st.writtenSha256 === file.hash) : undefined;
  const models = isObj(doc.models) ? doc.models : undefined;
  const dir = join(ctx.home, ".antigravity");
  const resolvedPath = checkedClientDestination(ctx, path, file);
  assertSameTarget(stash, resolvedPath);
  const newDirs = mkdirTracked(dir);
  if (!keep) {
    stash = {
      version: 1, path, resolvedPath, originalBytes: bytes ? bytes.toString("base64") : null, createdDirs: [...(stash?.createdDirs ?? []), ...newDirs],
      prior: { gateway: prior(doc, "gateway"), defaultModelId: prior(models, "defaultModelId"), list: prior(models, "list"), modelsPresent: models !== undefined },
      // Until the new bytes land, the file on disk is the original; exact restoration of it is a no-op.
      written: { gateway: null, defaultModelId: null }, writtenSha256: file?.hash ?? "",
    };
  } else {
    // A file that matches neither the applied nor the pending write was edited by the user.
    const base = onDisk ?? stash!;
    const pending = onDisk ? undefined : stash!.pending?.written;
    const written = {
      gateway: pending && same(doc.gateway, pending.gateway) ? pending.gateway : base.written.gateway,
      defaultModelId: pending && models?.defaultModelId === pending.defaultModelId
        ? pending.defaultModelId : base.written.defaultModelId,
    };
    stash = { ...stash!, resolvedPath, written, writtenSha256: base.writtenSha256, ...(stash!.pathWiseOnly || !onDisk ? { pathWiseOnly: true as const } : {}) };
    delete stash.pending;
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
  const outSha = sha256(out);
  const next = stash as Stash;
  const applied: Written = { written: { gateway, defaultModelId: target.defaultModel ?? (keep ? next.written.defaultModelId : null) }, writtenSha256: outSha };
  assertClientSize(out);
  writeStash(ctx, ID, { ...next, pending: applied });
  writeClientFile(ctx, path, file, out);
  // The settings are applied; if this promotion fails, the journaled pending state still describes them.
  try { writeStash(ctx, ID, { ...next, ...applied }); } catch { /* pending stays recognisable */ }
  const unchanged = file?.hash === outSha;
  return { ok: true, changed: !unchanged, changedFiles: unchanged ? [] : [path], message: "Antigravity now uses the OpenCodex gateway. Restart Antigravity to apply it.", notes: status(ctx, target).notes };
}

function disconnect(ctx: GatewayClientContext): GatewayClientResult {
  const path = settingsPath(ctx);
  const stash = checkedStash(ctx, path);
  if (!stash) return { ok: true, changed: false, changedFiles: [], restore: "none", message: "Not connected by OpenCodex; nothing was changed.", notes: [] };
  const file = readClientFile(ctx, path);
  assertSameTarget(stash, file?.target);
  const done = (restore: "exact" | "path-wise" | "none", message: string, files: string[]): GatewayClientResult => {
    try { dropStash(ctx, ID); }
    catch (error) { return clientRefusal(`Could not remove the Antigravity restore record: ${(error as Error).message}`, "io-error", files); }
    return { ok: true, changed: files.length > 0, changedFiles: files, restore, message, notes: [gatewayNote("restart-app")] };
  };
  const states = statesOf(stash);
  if (file && !stash.pathWiseOnly && states.some(st => st.writtenSha256 === file.hash)) {
    if (stash.originalBytes === null) { removeCreatedClientFile(ctx, path, file); rmdirsIfEmpty(ctx, stash.createdDirs); }
    else writeClientFile(ctx, path, file, Buffer.from(stash.originalBytes, "base64"));
    return done("exact", "Antigravity settings restored byte for byte.", [path]);
  }
  if (!file) return done("none", "The settings file is already gone; the restore record was cleared.", []);
  const parsed = parseSettings(file.bytes);
  if (typeof parsed === "string") return clientRefusal(`${GATEWAY_NOTE_TEXT[parsed]} The restore record was kept.`, "unsupported-file");
  const { doc } = parsed;
  const models = isObj(doc.models) ? doc.models : undefined;
  const saved = stash.prior;
  const writtenModels = states.map(st => st.written.defaultModelId).filter((id): id is string => id !== null);
  const gatewayMatches = states.some(st => st.written.gateway !== null && same(doc.gateway, st.written.gateway));
  const defaultMatches = writtenModels.some(id => models?.defaultModelId === id);
  const listWasRemoved = saved.list.present && (models !== undefined || doc.models === undefined) && models?.list === undefined;

  // A prior value may already be in place if a previous restore could not remove the record.
  const conflicts: string[] = [];
  if (!gatewayMatches && !same(doc.gateway, saved.gateway.value)) conflicts.push("gateway");
  if (writtenModels.length > 0 && !defaultMatches && !same(models?.defaultModelId, saved.defaultModelId.value)) {
    conflicts.push("models.defaultModelId");
  }
  if (saved.list.present && !listWasRemoved && !same(models?.list, saved.list.value)) conflicts.push("models.list");
  if (conflicts.length) {
    return clientRefusal(`Antigravity settings changed at ${conflicts.join(", ")}. The restore record was kept.`, "unsupported-file");
  }

  if (gatewayMatches) {
    if (saved.gateway.present) doc.gateway = saved.gateway.value; else delete doc.gateway;
  }
  if (models && defaultMatches) {
    if (saved.defaultModelId.present) models.defaultModelId = saved.defaultModelId.value; else delete models.defaultModelId;
  }
  if (listWasRemoved) {
    const m: Json = models ?? {};
    m.list = saved.list.value;
    doc.models = m;
  }
  const finalModels = isObj(doc.models) ? doc.models : undefined;
  if (finalModels && Object.keys(finalModels).length === 0 && !stash.prior.modelsPresent) delete doc.models;
  writeClientFile(ctx, path, file, serialize(parsed));
  return done("path-wise", `The file changed after OpenCodex wrote it, so only the gateway, models.defaultModelId and models.list entries were restored; your other edits were kept.`, [path]);
}

export const ANTIGRAVITY_CONNECTOR: GatewayClientConnector = {
  id: ID, label: "Antigravity", status,
  connect: (ctx, target) => mutateClient(ctx, () => connect(ctx, target)),
  disconnect: ctx => mutateClient(ctx, () => disconnect(ctx)),
};
