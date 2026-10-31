import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Models page. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `modelsV2.<key>`.
 */
const rows = {
} satisfies Record<string, Row>;

export const modelsV2Copy = copyTable("modelsV2", rows);
