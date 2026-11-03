/**
 * Byte-level and SQLite scalar source readers for keyless CC-Switch provider import.
 *
 * Projects values ONLY from an explicit allowlist of non-secret metadata fields; source bytes
 * are read transiently while secret-named fields, free-text names, and TOML comments are skipped
 * at the byte level without string decoding and transient buffers are zeroed in finally. Opens
 * with O_NOFOLLOW | O_NONBLOCK descriptor verification, refuses active -wal sidecars, and
 * deserializes SQLite read-only in memory.
 */
import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import { assertPlainLocalPath } from "../codex/orca-auth-source";

import {
  CcSwitchImportError,
  MAX_CODEX_TOML_BYTES,
  METADATA_REFUSED_SENTINEL,
  URL_SYNTAX_REFUSED_SENTINEL,
  encodeCodePointUtf8,
  equalsAsciiBytes,
  isAllowedMetadataBytes,
  isDisallowedMetadataValue,
  matchKnownJsonKeyBytes,
  parseCodexTomlBytes,
  parseHex4Bytes,
  resolveCodexProjection,
  unescapeJsonStringBytesBounded,
  unescapeTomlStringBytes,
  validateJsonPrimitiveBytes,
  validateUtf8AndJsonStringBounds,
  type CcSwitchInvalidReason,
  type CodexTomlProjection,
  type MetadataFieldKind,
} from "./cc-switch-import-bytes";

export {
  CcSwitchImportError,
  METADATA_REFUSED_SENTINEL,
  URL_SYNTAX_REFUSED_SENTINEL,
  equalsAsciiBytes,
  isAllowedMetadataBytes,
  isDisallowedMetadataValue,
  parseCodexTomlBytes,
  resolveCodexProjection,
  unescapeJsonStringBytesBounded,
  validateJsonPrimitiveBytes,
  validateUtf8AndJsonStringBounds,
  type CcSwitchInvalidReason,
  type CodexTomlProjection,
  type MetadataFieldKind,
};

const MAX_SQLITE_BYTES = 32 * 1024 * 1024;
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
const SQLITE_MAGIC_BYTES = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

function hasSqliteMagicBytes(header: Uint8Array, bytesRead: number): boolean {
  if (bytesRead < 16 || header.length < 16) return false;
  for (let i = 0; i < 16; i++) {
    if (header[i] !== SQLITE_MAGIC_BYTES[i]) return false;
  }
  return true;
}

function assertNoUncheckpointedSqliteWal(resolvedSqlitePath: string): void {
  const walPath = `${resolvedSqlitePath}-wal`;
  try {
    const walStat = lstatSync(walPath);
    if (!walStat.isFile() || walStat.size > 0) {
      throw new CcSwitchImportError(
        "CC-Switch SQLite source has uncheckpointed WAL changes (-wal is non-empty); close CC-Switch (or checkpoint the database) and retry.",
      );
    }
  } catch (error) {
    if (error instanceof CcSwitchImportError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CcSwitchImportError(
        "CC-Switch SQLite source has an unreadable WAL file (-wal); close CC-Switch (or checkpoint the database) and retry.",
      );
    }
  }
  const journalPath = `${resolvedSqlitePath}-journal`;
  try {
    const jStat = lstatSync(journalPath);
    if (!jStat.isFile() || jStat.size > 0) {
      throw new CcSwitchImportError(
        "CC-Switch SQLite source has an active rollback journal (-journal); close CC-Switch and retry.",
      );
    }
  } catch (error) {
    if (error instanceof CcSwitchImportError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CcSwitchImportError(
        "CC-Switch SQLite source has an unreadable rollback journal (-journal); close CC-Switch and retry.",
      );
    }
  }
}

let sourceOpenHookForTests: ((resolvedPath: string) => void) | null = null;
export function setCcSwitchSourceOpenHookForTests(hook: ((resolvedPath: string) => void) | null): void {
  sourceOpenHookForTests = hook;
}

export interface RawExtractedRow {
  id: string;
  appType: string;
  settingsType: string | null;
  claudeBaseUrl: string | null;
  claudeModel: string | null;
  genericBaseUrl: string | null;
  genericModel: string | null;
  genericWireApi: string | null;
  codexTomlLines: string | null;
  codexProjection?: { ok: true; value: CodexTomlProjection } | { ok: false; reason: CcSwitchInvalidReason };
}

function sqlLineExpr(col: string): string {
  return `trim(replace(substr(${col}, 1, instr(${col}, char(10)) - 1), char(13), ''))`;
}

function sqlSafeScalar(expr: string, kind: MetadataFieldKind): string {
  const refused = kind === "url" ? URL_SYNTAX_REFUSED_SENTINEL : METADATA_REFUSED_SENTINEL;
  if (kind === "app") {
    return `CASE
      WHEN ${expr} IS NULL OR ${expr} = '' THEN ''
      WHEN ocx_is_safe_meta(CAST(${expr} AS BLOB), 'app') = 1 THEN ${expr}
      ELSE '${METADATA_REFUSED_SENTINEL}'
    END`;
  }
  return `CASE
    WHEN ${expr} IS NULL THEN NULL
    WHEN ocx_is_safe_meta(CAST(${expr} AS BLOB), '${kind}') = 1
    THEN ${expr}
    ELSE '${refused}'
  END`;
}

function sqlModelProvidersHeaderPredicate(line: string): string {
  const inner = `trim(substr(${line}, 2, instr(${line}, ']') - 2))`;
  const afterKey = `ltrim(substr(${inner}, 16))`;
  const seg = `trim(substr(${afterKey}, 2))`;
  return `(
    substr(${line}, 1, 1) = '['
    AND substr(${line}, 1, 2) != '[['
    AND instr(${line}, ']') > 1
    AND substr(${inner}, 1, 15) = 'model_providers'
    AND substr(${afterKey}, 1, 1) = '.'
    AND ${seg} != ''
    AND (
      (
        substr(${seg}, 1, 1) = '"'
        AND length(${seg}) >= 3
        AND substr(${seg}, -1, 1) = '"'
        AND substr(replace(${seg}, char(92) || char(92), ''), -2, 2) != (char(92) || '"')
        AND instr(replace(replace(substr(${seg}, 2, length(${seg}) - 2), char(92) || char(92), ''), char(92) || char(34), ''), '"') = 0
      )
      OR (
        substr(${seg}, 1, 1) = ''''
        AND length(${seg}) >= 3
        AND substr(${seg}, -1, 1) = ''''
        AND instr(substr(${seg}, 2, length(${seg}) - 2), '''') = 0
      )
      OR (
        substr(${seg}, 1, 1) NOT IN ('"', '''')
        AND instr(${seg}, '.') = 0
        AND instr(${seg}, ' ') = 0
        AND instr(${seg}, char(9)) = 0
      )
    )
  )`;
}

const SQLITE_SAFE_QUERY = `
WITH RECURSIVE
  raw_base AS (
    SELECT
      rowid AS rid,
      CAST(id AS TEXT) AS raw_id,
      CAST(app_type AS TEXT) AS app_type,
      COALESCE(sort_index, 0) AS sort_ord,
      CASE WHEN json_valid(settings_config) THEN json_type(settings_config) ELSE NULL END AS settings_type,
      CASE WHEN json_valid(settings_config) AND json_type(settings_config, ?1) = 'text' THEN json_extract(settings_config, ?1) ELSE NULL END AS raw_claude_url,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?2) = 'text' THEN json_extract(settings_config, ?2)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?3) = 'text' THEN json_extract(settings_config, ?3)
        ELSE NULL
      END AS raw_claude_model,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?4) = 'text' THEN json_extract(settings_config, ?4)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?5) = 'text' THEN json_extract(settings_config, ?5)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?6) = 'text' THEN json_extract(settings_config, ?6)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?14) = 'text' THEN json_extract(settings_config, ?14)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?7) = 'text' THEN json_extract(settings_config, ?7)
        ELSE NULL
      END AS raw_generic_url,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?8) = 'text' THEN json_extract(settings_config, ?8)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?9) = 'text' THEN json_extract(settings_config, ?9)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?10) = 'text' THEN json_extract(settings_config, ?10)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?11) = 'text' THEN json_extract(settings_config, ?11)
        ELSE NULL
      END AS raw_generic_model,
      CASE WHEN json_valid(settings_config) AND json_type(settings_config, ?12) = 'text' THEN json_extract(settings_config, ?12) ELSE NULL END AS raw_wire_api,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?13) = 'text' THEN
          CASE
            WHEN length(CAST(json_extract(settings_config, ?13) AS BLOB)) > ${MAX_CODEX_TOML_BYTES}
              THEN '[__MALFORMED_LINE__]' || char(10)
            WHEN instr(json_extract(settings_config, ?13), '"""') > 0 OR instr(json_extract(settings_config, ?13), '''''''') > 0
              THEN '[__MULTILINE_REFUSED__]' || char(10)
            ELSE json_extract(settings_config, ?13) || char(10)
          END
        ELSE NULL
      END AS raw_cfg
    FROM providers
  ),
  base AS (
    SELECT
      rid,
      ${sqlSafeScalar("raw_id", "id")} AS id,
      ${sqlSafeScalar("app_type", "app")} AS app_type,
      sort_ord,
      settings_type,
      ${sqlSafeScalar("raw_claude_url", "url")} AS claude_base_url,
      ${sqlSafeScalar("raw_claude_model", "model")} AS claude_model,
      ${sqlSafeScalar("raw_generic_url", "url")} AS generic_base_url,
      ${sqlSafeScalar("raw_generic_model", "model")} AS generic_model,
      ${sqlSafeScalar("raw_wire_api", "wire")} AS generic_wire_api,
      raw_cfg
    FROM raw_base
  ),
  lines(rid, line, rest, idx, sec) AS (
    SELECT
      rid,
      ${sqlLineExpr("raw_cfg")},
      substr(raw_cfg, instr(raw_cfg, char(10)) + 1),
      1,
      CASE
        WHEN substr(${sqlLineExpr("raw_cfg")}, 1, 1) = '[' THEN
          CASE
            WHEN ${sqlModelProvidersHeaderPredicate(sqlLineExpr("raw_cfg"))} THEN 'mp'
            ELSE 'other'
          END
        ELSE 'root'
      END
    FROM base WHERE raw_cfg IS NOT NULL AND instr(raw_cfg, char(10)) > 0
    UNION ALL
    SELECT
      rid,
      ${sqlLineExpr("rest")},
      substr(rest, instr(rest, char(10)) + 1),
      idx + 1,
      CASE
        WHEN substr(${sqlLineExpr("rest")}, 1, 1) = '[' THEN
          CASE
            WHEN ${sqlModelProvidersHeaderPredicate(sqlLineExpr("rest"))} THEN 'mp'
            ELSE 'other'
          END
        ELSE sec
      END
    FROM lines WHERE instr(rest, char(10)) > 0 AND idx <= 500
  ),
  split_lines AS (
    SELECT
      rid,
      idx,
      sec,
      line,
      instr(line, ']') AS close_b,
      trim(substr(ltrim(substr(trim(substr(line, 2, instr(line, ']') - 2)), 16)), 2)) AS hdr_seg,
      trim(trim(substr(line, 1, instr(line, '=') - 1)), ' ''' || char(34)) AS norm_key,
      ltrim(substr(line, instr(line, '=') + 1)) AS rhs
    FROM lines
  ),
  quoted_lines AS (
    SELECT
      rid,
      idx,
      sec,
      line,
      close_b,
      hdr_seg,
      norm_key,
      rhs,
      CASE
        WHEN substr(rhs, 1, 1) = char(34) AND substr(rhs, 1, 3) != '"""'
          THEN instr(replace(replace(substr(rhs, 2), char(92) || char(92), '__'), char(92) || char(34), '__'), char(34))
        WHEN substr(rhs, 1, 1) = '''' AND substr(rhs, 1, 3) != ''''''''
          THEN instr(substr(rhs, 2), '''')
        ELSE 0
      END AS end_q
    FROM split_lines
  ),
  val_lines AS (
    SELECT
      rid,
      idx,
      sec,
      line,
      close_b,
      hdr_seg,
      norm_key,
      rhs,
      end_q,
      substr(rhs, 1, end_q + 1) AS rhs_tok,
      ltrim(substr(rhs, end_q + 2)) AS tail
    FROM quoted_lines
  ),
  projected_lines AS (
    SELECT rid, idx,
      CASE
        WHEN idx > 500 THEN '[__MALFORMED_LINE__]'
        WHEN line = '' OR substr(line, 1, 1) = '#' THEN NULL
        WHEN line IN ('[__MULTILINE_REFUSED__]', '[__MALFORMED_LINE__]') THEN line
        WHEN substr(line, 1, 1) = '[' THEN
          CASE
            WHEN sec = 'mp' AND close_b > 0 AND (ltrim(substr(line, close_b + 1)) = '' OR substr(ltrim(substr(line, close_b + 1)), 1, 1) = '#') THEN
              CASE
                WHEN ocx_is_safe_toml_token(CAST(hdr_seg AS BLOB), 'id', 1) = 1
                  THEN substr(line, 1, close_b)
                ELSE '[${METADATA_REFUSED_SENTINEL}]'
              END
            WHEN close_b > 0 AND (ltrim(substr(line, close_b + 1)) = '' OR substr(ltrim(substr(line, close_b + 1)), 1, 1) = '#') THEN '[other]'
            ELSE '[__MALFORMED_LINE__]'
          END
        WHEN instr(line, '=') = 0 THEN '[__MALFORMED_LINE__]'
        WHEN (sec = 'root' AND norm_key IN ('model', 'model_provider', 'base_url', 'openai_base_url', 'wire_api'))
          OR (sec = 'mp' AND norm_key IN ('base_url', 'wire_api')) THEN
          CASE
            WHEN end_q = 0 OR (tail != '' AND substr(tail, 1, 1) != '#') THEN '[__MALFORMED_LINE__]'
            WHEN norm_key = 'model' THEN
              CASE
                WHEN ocx_is_safe_toml_token(CAST(rhs_tok AS BLOB), 'model', 0) = 1 THEN 'model = ' || rhs_tok
                ELSE 'model = "${METADATA_REFUSED_SENTINEL}"'
              END
            WHEN norm_key IN ('base_url', 'openai_base_url') THEN
              CASE
                WHEN ocx_is_safe_toml_token(CAST(rhs_tok AS BLOB), 'url', 0) = 1 THEN norm_key || ' = ' || rhs_tok
                ELSE norm_key || ' = "${URL_SYNTAX_REFUSED_SENTINEL}"'
              END
            WHEN norm_key = 'model_provider' THEN
              CASE
                WHEN ocx_is_safe_toml_token(CAST(rhs_tok AS BLOB), 'id', 0) = 1 THEN 'model_provider = ' || rhs_tok
                ELSE 'model_provider = "${METADATA_REFUSED_SENTINEL}"'
              END
            WHEN norm_key = 'wire_api' THEN
              CASE
                WHEN ocx_is_safe_toml_token(CAST(rhs_tok AS BLOB), 'wire', 0) = 1 THEN 'wire_api = ' || rhs_tok
                ELSE 'wire_api = "${METADATA_REFUSED_SENTINEL}"'
              END
            ELSE 'ignored_key = "omitted"'
          END
        ELSE 'ignored_key = "omitted"'
      END AS safe_line
    FROM val_lines
  )
SELECT
  b.rid AS rid,
  CAST(b.id AS BLOB) AS idBlob,
  CAST(b.app_type AS BLOB) AS appTypeBlob,
  b.settings_type AS settingsType,
  CAST(b.claude_base_url AS BLOB) AS claudeBaseUrlBlob,
  CAST(b.claude_model AS BLOB) AS claudeModelBlob,
  CAST(b.generic_base_url AS BLOB) AS genericBaseUrlBlob,
  CAST(b.generic_model AS BLOB) AS genericModelBlob,
  CAST(b.generic_wire_api AS BLOB) AS genericWireApiBlob,
  p.idx AS lineIdx,
  CAST(p.safe_line AS BLOB) AS safeLineBlob
FROM base b
LEFT JOIN projected_lines p ON b.rid = p.rid AND p.safe_line IS NOT NULL
ORDER BY b.sort_ord ASC, b.id ASC, b.app_type ASC, b.rid ASC, p.idx ASC
`;

function decodeSafeBlob(blob: Uint8Array | null, kind: MetadataFieldKind, decoder: TextDecoder): string | null {
  if (blob === null) return null;
  const refused = kind === "url" ? URL_SYNTAX_REFUSED_SENTINEL : METADATA_REFUSED_SENTINEL;
  try {
    if (kind === "app" && blob.length === 0) return "";
    if (equalsAsciiBytes(blob, METADATA_REFUSED_SENTINEL)) return METADATA_REFUSED_SENTINEL;
    if (equalsAsciiBytes(blob, URL_SYNTAX_REFUSED_SENTINEL)) return URL_SYNTAX_REFUSED_SENTINEL;
    if (!isAllowedMetadataBytes(blob, kind)) return refused;
    return decoder.decode(blob);
  } finally {
    blob.fill(0);
  }
}

function readSqliteRowsFromBytes(sqliteBytes: Uint8Array): RawExtractedRow[] {
  let db: Database | undefined;
  const blobsToZero: Uint8Array[] = [];
  try {
    // Normalize SQLite WAL read/write format version bytes (offsets 18..19) on the private
    // in-memory buffer so sqlite3_deserialize opens checkpointed WAL databases without touching disk.
    if (sqliteBytes.length >= 20) {
      if (sqliteBytes[18] === 2) sqliteBytes[18] = 1;
      if (sqliteBytes[19] === 2) sqliteBytes[19] = 1;
    }
    db = Database.deserialize(sqliteBytes, { readonly: true });
    db.function("ocx_is_safe_meta", (val: unknown, kind: unknown) => {
      if (!(val instanceof Uint8Array) || typeof kind !== "string") return 0;
      try {
        return isAllowedMetadataBytes(val, kind as MetadataFieldKind) ? 1 : 0;
      } finally {
        val.fill(0);
      }
    });
    db.function("ocx_is_safe_toml_token", (val: unknown, kind: unknown, allowBare: unknown) => {
      if (!(val instanceof Uint8Array) || typeof kind !== "string" || val.length === 0) return 0;
      let unescaped: Uint8Array | null = null;
      try {
        const q = val[0]!;
        if (q === 0x22 || q === 0x27) {
          if (val.length < 2 || val[val.length - 1] !== q) return 0;
          unescaped = unescapeTomlStringBytes(val.subarray(1, val.length - 1), q);
          if (!unescaped || unescaped.length === 0) return 0;
          return isAllowedMetadataBytes(unescaped, kind as MetadataFieldKind) ? 1 : 0;
        }
        if (!allowBare) return 0;
        return isAllowedMetadataBytes(val, kind as MetadataFieldKind) ? 1 : 0;
      } finally {
        unescaped?.fill(0);
        val.fill(0);
      }
    });
    const rawRows = db.query(SQLITE_SAFE_QUERY).all(
      "$.env.ANTHROPIC_BASE_URL",
      "$.env.ANTHROPIC_MODEL",
      "$.env.ANTHROPIC_DEFAULT_SONNET_MODEL",
      "$.baseUrl",
      "$.base_url",
      "$.env.OPENAI_BASE_URL",
      "$.env.GEMINI_BASE_URL",
      "$.model",
      "$.defaultModel",
      "$.env.OPENAI_MODEL",
      "$.env.GEMINI_MODEL",
      "$.wire_api",
      "$.config",
      "$.env.GOOGLE_GEMINI_BASE_URL",
    ) as Array<{
      rid: number;
      idBlob: Uint8Array | null;
      appTypeBlob: Uint8Array | null;
      settingsType: string | null;
      claudeBaseUrlBlob: Uint8Array | null;
      claudeModelBlob: Uint8Array | null;
      genericBaseUrlBlob: Uint8Array | null;
      genericModelBlob: Uint8Array | null;
      genericWireApiBlob: Uint8Array | null;
      lineIdx: number | null;
      safeLineBlob: Uint8Array | null;
    }>;
    for (const item of rawRows) {
      if (item.idBlob) blobsToZero.push(item.idBlob);
      if (item.appTypeBlob) blobsToZero.push(item.appTypeBlob);
      if (item.claudeBaseUrlBlob) blobsToZero.push(item.claudeBaseUrlBlob);
      if (item.claudeModelBlob) blobsToZero.push(item.claudeModelBlob);
      if (item.genericBaseUrlBlob) blobsToZero.push(item.genericBaseUrlBlob);
      if (item.genericModelBlob) blobsToZero.push(item.genericModelBlob);
      if (item.genericWireApiBlob) blobsToZero.push(item.genericWireApiBlob);
      if (item.safeLineBlob) blobsToZero.push(item.safeLineBlob);
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const byRid = new Map<number, { row: RawExtractedRow; lines: Array<{ idx: number; bytes: Uint8Array }> }>();
    for (const item of rawRows) {
      let group = byRid.get(item.rid);
      if (!group) {
        group = {
          row: {
            id: decodeSafeBlob(item.idBlob, "id", decoder) ?? "",
            appType: decodeSafeBlob(item.appTypeBlob, "app", decoder) ?? "",
            settingsType: item.settingsType,
            claudeBaseUrl: decodeSafeBlob(item.claudeBaseUrlBlob, "url", decoder),
            claudeModel: decodeSafeBlob(item.claudeModelBlob, "model", decoder),
            genericBaseUrl: decodeSafeBlob(item.genericBaseUrlBlob, "url", decoder),
            genericModel: decodeSafeBlob(item.genericModelBlob, "model", decoder),
            genericWireApi: decodeSafeBlob(item.genericWireApiBlob, "wire", decoder),
            codexTomlLines: null,
          },
          lines: [],
        };
        byRid.set(item.rid, group);
      }
      if (item.lineIdx !== null && item.safeLineBlob !== null) {
        const copy = new Uint8Array(item.safeLineBlob.length);
        copy.set(item.safeLineBlob);
        blobsToZero.push(copy);
        group.lines.push({ idx: item.lineIdx, bytes: copy });
      }
    }
    const result: RawExtractedRow[] = [];
    for (const group of byRid.values()) {
      if (group.lines.length > 0) {
        group.lines.sort((a, b) => a.idx - b.idx);
        let totalLen = 0;
        for (let i = 0; i < group.lines.length; i++) {
          totalLen += group.lines[i]!.bytes.length + (i > 0 ? 1 : 0);
        }
        const joined = new Uint8Array(totalLen);
        let offset = 0;
        for (let i = 0; i < group.lines.length; i++) {
          if (i > 0) joined[offset++] = 0x0a;
          const lineBytes = group.lines[i]!.bytes;
          joined.set(lineBytes, offset);
          offset += lineBytes.length;
        }
        try {
          group.row.codexProjection = parseCodexTomlBytes(joined);
        } finally {
          joined.fill(0);
        }
      }
      result.push(group.row);
    }
    return result;
  } catch {
    throw new CcSwitchImportError("CC-Switch SQLite source could not be read or has an unsupported schema.");
  } finally {
    for (const b of blobsToZero) b.fill(0);
    try { db?.close(); } catch { /* ignore */ }
  }
}

export function readSqliteRows(sourcePath: string): RawExtractedRow[] {
  return readSourceRows(sourcePath, true);
}

/**
 * Byte-level UTF-8 JSON scanner for legacy CC-Switch JSON files.
 * Walks the JSON structure on a transient Uint8Array (zeroed in finally) and decodes ONLY
 * allowlisted non-secret scalar fields, skipping over secret values without decoding them into JS strings.
 */
export function scanCcSwitchJsonBytes(bytes: Uint8Array): RawExtractedRow[] {
  try {
    return scanCcSwitchJsonBytesInternal(bytes);
  } finally {
    bytes.fill(0);
  }
}

function scanCcSwitchJsonBytesInternal(bytes: Uint8Array): RawExtractedRow[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pos = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    pos = 3;
  }

  function skipWs(): void {
    while (pos < bytes.length) {
      const b = bytes[pos]!;
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) pos++;
      else break;
    }
  }

  function scanStringBounds(): { start: number; end: number; hasEscapes: boolean } {
    const res = validateUtf8AndJsonStringBounds(bytes, pos);
    if (!res) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    pos = res.nextPos;
    return { start: res.start, end: res.end, hasEscapes: res.hasEscapes };
  }

  function decodeMetadataStringFromBounds(bounds: { start: number; end: number }, kind: MetadataFieldKind): string {
    const refused = kind === "url" ? URL_SYNTAX_REFUSED_SENTINEL : METADATA_REFUSED_SENTINEL;
    if (bounds.end - bounds.start > 512) return refused;
    const out = new Uint8Array(bounds.end - bounds.start);
    let readIdx = bounds.start;
    let writeIdx = 0;
    try {
      while (readIdx < bounds.end) {
        const b = bytes[readIdx]!;
        if (b !== 0x5c) {
          out[writeIdx++] = b;
          readIdx++;
          continue;
        }
        readIdx++;
        if (readIdx >= bounds.end) return refused;
        const esc = bytes[readIdx]!;
        readIdx++;
        if (esc === 0x22 || esc === 0x5c || esc === 0x2f) out[writeIdx++] = esc;
        else if (esc === 0x6e || esc === 0x72 || esc === 0x74 || esc === 0x62 || esc === 0x66) {
          return refused;
        } else if (esc === 0x75) {
          const cp = parseHex4Bytes(bytes.subarray(0, bounds.end), readIdx);
          if (cp <= 0x20 || cp >= 0x7f) return refused;
          readIdx += 4;
          writeIdx += encodeCodePointUtf8(cp, out, writeIdx);
        } else {
          return refused;
        }
      }
      const view = out.subarray(0, writeIdx);
      if (!isAllowedMetadataBytes(view, kind)) return refused;
      return decoder.decode(view);
    } finally {
      out.fill(0);
    }
  }

  function parseJsonEscapedTomlInPlace(bounds: { start: number; end: number }): { ok: true; value: CodexTomlProjection } | { ok: false; reason: CcSwitchInvalidReason } {
    if (bounds.end - bounds.start > MAX_CODEX_TOML_BYTES) return { ok: false, reason: "malformed_entry" };
    const out = new Uint8Array(bounds.end - bounds.start);
    let readIdx = bounds.start;
    let writeIdx = 0;
    try {
      while (readIdx < bounds.end) {
        const b = bytes[readIdx]!;
        if (b !== 0x5c) {
          out[writeIdx++] = b;
          readIdx++;
          continue;
        }
        readIdx++;
        if (readIdx >= bounds.end) return { ok: false, reason: "malformed_entry" };
        const esc = bytes[readIdx]!;
        readIdx++;
        if (esc === 0x22 || esc === 0x5c || esc === 0x2f) out[writeIdx++] = esc;
        else if (esc === 0x6e) out[writeIdx++] = 0x0a;
        else if (esc === 0x72) out[writeIdx++] = 0x0d;
        else if (esc === 0x74) out[writeIdx++] = 0x09;
        else if (esc === 0x62) out[writeIdx++] = 0x08;
        else if (esc === 0x66) out[writeIdx++] = 0x0c;
        else if (esc === 0x75) {
          let codePoint = parseHex4Bytes(bytes.subarray(0, bounds.end), readIdx);
          if (codePoint < 0) return { ok: false, reason: "malformed_entry" };
          readIdx += 4;
          if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            if (readIdx + 6 > bounds.end || bytes[readIdx] !== 0x5c || bytes[readIdx + 1] !== 0x75) {
              return { ok: false, reason: "malformed_entry" };
            }
            const low = parseHex4Bytes(bytes.subarray(0, bounds.end), readIdx + 2);
            if (low < 0xdc00 || low > 0xdfff) return { ok: false, reason: "malformed_entry" };
            readIdx += 6;
            codePoint = ((codePoint - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
          } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
            return { ok: false, reason: "malformed_entry" };
          }
          writeIdx += encodeCodePointUtf8(codePoint, out, writeIdx);
        } else {
          return { ok: false, reason: "malformed_entry" };
        }
      }
      return parseCodexTomlBytes(out.subarray(0, writeIdx));
    } finally {
      out.fill(0);
    }
  }

  function skipPrimitive(): void {
    const start = pos;
    while (pos < bytes.length) {
      const b = bytes[pos]!;
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x2c || b === 0x7d || b === 0x5d) break;
      pos++;
    }
    if (!validateJsonPrimitiveBytes(bytes, start, pos)) {
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }

  function skipValue(depth = 0): void {
    if (depth > 64) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    skipWs();
    if (pos >= bytes.length) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    const b = bytes[pos]!;
    if (b === 0x22) {
      scanStringBounds();
    } else if (b === 0x7b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x7d) { pos++; return; }
      for (;;) {
        skipWs();
        scanStringBounds();
        skipWs();
        if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
        pos++;
        skipValue(depth + 1);
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x7d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else if (b === 0x5b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x5d) { pos++; return; }
      for (;;) {
        skipValue(depth + 1);
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x5d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else {
      skipPrimitive();
    }
  }

  function readOptionalScalarString(kind: MetadataFieldKind): string | null {
    skipWs();
    if (bytes[pos] === 0x22) return decodeMetadataStringFromBounds(scanStringBounds(), kind);
    skipValue();
    return null;
  }

  function parseSettingsObject(row: RawExtractedRow): void {
    skipWs();
    if (bytes[pos] !== 0x7b) {
      row.settingsType = null;
      skipValue();
      return;
    }
    row.settingsType = "object";
    pos++;
    skipWs();
    if (bytes[pos] === 0x7d) { pos++; return; }
    for (;;) {
      skipWs();
      const key = matchKnownJsonKeyBytes(bytes, scanStringBounds(), [
        "env", "baseUrl", "base_url", "model", "defaultModel", "wire_api", "config",
      ]);
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      skipWs();
      if (key === "env" && bytes[pos] === 0x7b) {
        pos++;
        skipWs();
        if (bytes[pos] === 0x7d) { pos++; }
        else {
          for (;;) {
            skipWs();
            const envKey = matchKnownJsonKeyBytes(bytes, scanStringBounds(), [
              "ANTHROPIC_BASE_URL",
              "ANTHROPIC_MODEL",
              "ANTHROPIC_DEFAULT_SONNET_MODEL",
              "OPENAI_BASE_URL",
              "GOOGLE_GEMINI_BASE_URL",
              "GEMINI_BASE_URL",
              "OPENAI_MODEL",
              "GEMINI_MODEL",
            ]);
            skipWs();
            if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
            pos++;
            if (envKey === "ANTHROPIC_BASE_URL") row.claudeBaseUrl = readOptionalScalarString("url");
            else if (envKey === "ANTHROPIC_MODEL") {
              const v = readOptionalScalarString("model");
              if (v) row.claudeModel = v;
            } else if (envKey === "ANTHROPIC_DEFAULT_SONNET_MODEL") {
              const v = readOptionalScalarString("model");
              if (v && !row.claudeModel) row.claudeModel = v;
            } else if (envKey === "OPENAI_BASE_URL" || envKey === "GOOGLE_GEMINI_BASE_URL" || envKey === "GEMINI_BASE_URL") {
              const v = readOptionalScalarString("url");
              if (v && !row.genericBaseUrl) row.genericBaseUrl = v;
            } else if (envKey === "OPENAI_MODEL" || envKey === "GEMINI_MODEL") {
              const v = readOptionalScalarString("model");
              if (v && !row.genericModel) row.genericModel = v;
            } else {
              skipValue();
            }
            skipWs();
            if (bytes[pos] === 0x2c) { pos++; continue; }
            if (bytes[pos] === 0x7d) { pos++; break; }
            throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
          }
        }
      } else if (key === "baseUrl" || key === "base_url") {
        const v = readOptionalScalarString("url");
        if (v && !row.genericBaseUrl) row.genericBaseUrl = v;
      } else if (key === "model" || key === "defaultModel") {
        const v = readOptionalScalarString("model");
        if (v && !row.genericModel) row.genericModel = v;
      } else if (key === "wire_api") {
        const v = readOptionalScalarString("wire");
        if (v) row.genericWireApi = v;
      } else if (key === "config") {
        skipWs();
        if (bytes[pos] === 0x22) {
          row.codexProjection = parseJsonEscapedTomlInPlace(scanStringBounds());
        } else {
          skipValue();
        }
      } else {
        skipValue();
      }
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }

  function parseProviderEntryObject(fallbackId = "", fallbackApp = ""): RawExtractedRow {
    skipWs();
    if (bytes[pos] !== 0x7b) throw new CcSwitchImportError("Malformed CC-Switch JSON provider entry.");
    pos++;
    const row: RawExtractedRow = {
      id: fallbackId,
      appType: fallbackApp,
      settingsType: null,
      claudeBaseUrl: null,
      claudeModel: null,
      genericBaseUrl: null,
      genericModel: null,
      genericWireApi: null,
      codexTomlLines: null,
    };
    skipWs();
    if (bytes[pos] === 0x7d) { pos++; return row; }
    for (;;) {
      skipWs();
      const key = matchKnownJsonKeyBytes(bytes, scanStringBounds(), [
        "id", "app_type", "appType", "settings_config", "settingsConfig",
      ]);
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      if (key === "id") {
        const v = readOptionalScalarString("id");
        if (v !== null) row.id = v;
      } else if (key === "app_type" || key === "appType") {
        const v = readOptionalScalarString("app");
        if (v !== null) row.appType = v;
      } else if (key === "settings_config" || key === "settingsConfig") {
        parseSettingsObject(row);
      } else {
        // Never decode free-text "name", "notes", "websiteUrl", "meta", or unknown fields!
        skipValue();
      }
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
    return row;
  }

  function parseProvidersCollection(appHint = ""): RawExtractedRow[] {
    const out: RawExtractedRow[] = [];
    skipWs();
    if (bytes[pos] === 0x5b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x5d) { pos++; return out; }
      for (;;) {
        out.push(parseProviderEntryObject("", appHint));
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x5d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else if (bytes[pos] === 0x7b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x7d) { pos++; return out; }
      for (;;) {
        skipWs();
        const id = decodeMetadataStringFromBounds(scanStringBounds(), "id");
        skipWs();
        if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
        pos++;
        out.push(parseProviderEntryObject(id, appHint));
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x7d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else {
      throw new CcSwitchImportError("Malformed CC-Switch JSON providers section.");
    }
    return out;
  }

  function parseAppSection(appName: string): RawExtractedRow[] {
    const out: RawExtractedRow[] = [];
    skipWs();
    if (bytes[pos] !== 0x7b) { skipValue(); return out; }
    pos++;
    skipWs();
    if (bytes[pos] === 0x7d) { pos++; return out; }
    for (;;) {
      skipWs();
      const k = matchKnownJsonKeyBytes(bytes, scanStringBounds(), ["providers"]);
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      if (k === "providers") out.push(...parseProvidersCollection(appName));
      else skipValue();
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
    return out;
  }

  const rows: RawExtractedRow[] = [];
  let sawStructure = false;
  skipWs();
  if (bytes[pos] !== 0x7b) throw new CcSwitchImportError("CC-Switch JSON source must be a JSON object.");
  pos++;
  skipWs();
  if (bytes[pos] === 0x7d) {
    pos++;
  } else {
    for (;;) {
      skipWs();
      const topKey = matchKnownJsonKeyBytes(bytes, scanStringBounds(), [
        "providers", "apps", "claude", "codex", "openai", "gemini", "opencode",
      ]);
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      if (topKey === "providers") {
        sawStructure = true;
        rows.push(...parseProvidersCollection(""));
      } else if (topKey === "apps") {
        sawStructure = true;
        skipWs();
        if (bytes[pos] !== 0x7b) throw new CcSwitchImportError("Malformed CC-Switch JSON apps section.");
        pos++;
        skipWs();
        if (bytes[pos] === 0x7d) { pos++; }
        else {
          for (;;) {
            skipWs();
            const appName = decodeMetadataStringFromBounds(scanStringBounds(), "app");
            skipWs();
            if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
            pos++;
            rows.push(...parseAppSection(appName));
            skipWs();
            if (bytes[pos] === 0x2c) { pos++; continue; }
            if (bytes[pos] === 0x7d) { pos++; break; }
            throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
          }
        }
      } else if (topKey === "claude" || topKey === "codex" || topKey === "openai" || topKey === "gemini" || topKey === "opencode") {
        sawStructure = true;
        rows.push(...parseAppSection(topKey));
      } else {
        skipValue();
      }
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }
  skipWs();
  if (pos !== bytes.length || !sawStructure) {
    throw new CcSwitchImportError("CC-Switch JSON source does not contain a recognized providers structure.");
  }
  return rows;
}

export function readSourceRows(sourcePath: string, requireSqlite = false): RawExtractedRow[] {
  const resolved = resolve(sourcePath);
  let beforeStat: import("node:fs").BigIntStats;
  try {
    assertPlainLocalPath(resolved);
    beforeStat = lstatSync(resolved, { bigint: true });
  } catch {
    throw new CcSwitchImportError("CC-Switch source path must be a plain regular local file without symlink traversal.");
  }
  if (!beforeStat.isFile()) {
    throw new CcSwitchImportError("CC-Switch source path must be a regular file.");
  }
  sourceOpenHookForTests?.(resolved);
  let fd: number | undefined;
  let isSqlite = false;
  let size = 0;
  const header = Buffer.alloc(16);
  let rawBuf: Buffer | undefined;
  try {
    try {
      fd = openSync(
        resolved,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile()) {
        throw new CcSwitchImportError("CC-Switch source path must be a regular file.");
      }
      if (
        opened.dev !== beforeStat.dev
        || opened.ino !== beforeStat.ino
        || opened.uid !== beforeStat.uid
        || opened.gid !== beforeStat.gid
        || opened.mode !== beforeStat.mode
      ) {
        throw new CcSwitchImportError("CC-Switch source file changed while opening.");
      }
      size = Number(opened.size);
      const n = readSync(fd, header, 0, 16, 0);
      if (hasSqliteMagicBytes(header, n)) {
        isSqlite = true;
        if (opened.nlink > 1) {
          throw new CcSwitchImportError("CC-Switch SQLite source has multiple hard links; import the original CC-Switch database path directly.");
        }
        if (size === 0 || size > MAX_SQLITE_BYTES) {
          throw new CcSwitchImportError("CC-Switch SQLite source exceeds the maximum supported size.");
        }
        assertNoUncheckpointedSqliteWal(resolved);
      } else if (requireSqlite || /\.(?:db|sqlite|sqlite3)$/i.test(resolved)) {
        throw new CcSwitchImportError("CC-Switch SQLite source is not a valid SQLite 3 file.");
      } else {
        if (size === 0 || size > MAX_JSON_BYTES) {
          throw new CcSwitchImportError("CC-Switch JSON source is empty or exceeds the maximum supported size.");
        }
      }
      rawBuf = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < rawBuf.length) {
        const got = readSync(fd, rawBuf, offset, rawBuf.length - offset, offset);
        if (got <= 0) break;
        offset += got;
      }
      if (offset !== size) {
        throw new CcSwitchImportError("CC-Switch source file changed while reading.");
      }
      if (isSqlite) {
        assertNoUncheckpointedSqliteWal(resolved);
      }
      assertPlainLocalPath(resolved);
      const afterStat = lstatSync(resolved, { bigint: true });
      const afterFd = fstatSync(fd, { bigint: true });
      if (isSqlite && afterFd.nlink > 1) {
        throw new CcSwitchImportError("CC-Switch SQLite source has multiple hard links; import the original CC-Switch database path directly.");
      }
      if (
        afterStat.dev !== opened.dev
        || afterStat.ino !== opened.ino
        || afterStat.nlink !== opened.nlink
        || afterStat.uid !== opened.uid
        || afterStat.gid !== opened.gid
        || afterStat.mode !== opened.mode
        || afterStat.size !== opened.size
        || afterStat.mtimeNs !== opened.mtimeNs
        || afterFd.dev !== opened.dev
        || afterFd.ino !== opened.ino
        || afterFd.nlink !== opened.nlink
        || afterFd.uid !== opened.uid
        || afterFd.gid !== opened.gid
        || afterFd.mode !== opened.mode
        || afterFd.size !== opened.size
        || afterFd.mtimeNs !== opened.mtimeNs
      ) {
        throw new CcSwitchImportError("CC-Switch source file changed while reading.");
      }
    } catch (error) {
      if (error instanceof CcSwitchImportError) throw error;
      throw new CcSwitchImportError("CC-Switch source file could not be opened.");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }

    if (isSqlite) {
      return readSqliteRowsFromBytes(rawBuf!.subarray(0, size));
    }
    return scanCcSwitchJsonBytes(rawBuf!.subarray(0, size));
  } finally {
    header.fill(0);
    rawBuf?.fill(0);
  }
}
