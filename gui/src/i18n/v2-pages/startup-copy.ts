import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Startup protection, Remote Link and Remote Workspace pages. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `startupV2.<key>`.
 */
const rows = {
} satisfies Record<string, Row>;

export const startupV2Copy = copyTable("startupV2", rows);
