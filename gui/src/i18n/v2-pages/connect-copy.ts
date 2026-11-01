import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Connect (integrations, Claude, API keys) and the Set up hub pages. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `connectV2.<key>`.
 */
const rows = {
} satisfies Record<string, Row>;

export const connectV2Copy = copyTable("connectV2", rows);
