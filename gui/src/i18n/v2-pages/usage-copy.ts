import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Usage page. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `usageV2.<key>`.
 */
const rows = {
} satisfies Record<string, Row>;

export const usageV2Copy = copyTable("usageV2", rows);
