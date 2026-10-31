import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Subagents page. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `subagentsV2.<key>`.
 */
const rows = {
} satisfies Record<string, Row>;

export const subagentsV2Copy = copyTable("subagentsV2", rows);
