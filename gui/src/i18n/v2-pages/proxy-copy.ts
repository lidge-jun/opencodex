import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Proxy details, Advisor and the All settings hub pages. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `proxyV2.<key>`.
 */
const rows = {
} satisfies Record<string, Row>;

export const proxyV2Copy = copyTable("proxyV2", rows);
