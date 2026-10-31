import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Logs & Debug, Storage page. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `logsV2.<key>`.
 */
const rows = {
} satisfies Record<string, Row>;

export const logsV2Copy = copyTable("logsV2", rows);
