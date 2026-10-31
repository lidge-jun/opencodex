import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Accounts & limits (Codex Set, Providers) page. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `accountsV2.<key>`.
 */
const rows = {
} satisfies Record<string, Row>;

export const accountsV2Copy = copyTable("accountsV2", rows);
