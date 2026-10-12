import { jsonUtf8Bytes } from "../../lib/json-byte-size";

export const PICKER_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_ROW_BYTES = 256 * 1024;
const MAX_ADDED_BYTES = 2 * 1024 * 1024;
const MAX_ADDED_ROWS = 4096;

/** Inspect references only: no deep copy or serialized string is allocated by preflight. */
export function pickerRowBytes(row: Record<string, unknown>): number {
  for (const key of Object.keys(row)) {
    jsonUtf8Bytes(key, MAX_FIELD_BYTES);
    if (row[key] !== undefined) jsonUtf8Bytes(row[key], MAX_FIELD_BYTES);
  }
  return jsonUtf8Bytes(row, MAX_ROW_BYTES);
}

/** One budget for the entire response, including duplicate surfaces and the CLI fallback. */
export class PickerRewriteBudget {
  private outputBytes: number;
  private addedBytes = 0;
  private addedRows = 0;

  constructor(body: unknown) {
    this.outputBytes = jsonUtf8Bytes(body, PICKER_MAX_OUTPUT_BYTES);
  }

  reserveBytes(bytes: number): void {
    if (bytes > MAX_ADDED_BYTES - this.addedBytes || bytes > PICKER_MAX_OUTPUT_BYTES - this.outputBytes) {
      throw new RangeError("Picker rewrite byte limit");
    }
    this.addedBytes += bytes;
    this.outputBytes += bytes;
  }

  reserveRow(row: Record<string, unknown>): void {
    if (++this.addedRows > MAX_ADDED_ROWS) throw new RangeError("Picker rewrite row limit");
    // Include a separator even for an empty list, conservatively reserving one extra byte.
    this.reserveBytes(pickerRowBytes(row) + 1);
  }
}
