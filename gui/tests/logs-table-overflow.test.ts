import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");

/** Last effective declaration of `prop` inside every `selector { ... }` block. */
function lastDeclaration(selector: string, prop: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`, "g");
  let value: string | undefined;
  for (const match of css.matchAll(block)) {
    for (const decl of match[1].split(";")) {
      const [name, ...rest] = decl.split(":");
      if (name?.trim().toLowerCase() === prop) value = rest.join(":").trim();
    }
  }
  return value;
}

/**
 * `table-layout: fixed` sizes the columns but never clips them: a value wider than its
 * `<col>` paints over the neighbour. Observed on the live dashboard as
 * `US$0.1401claude-fable-5-1` and a `reasoning_effort=high` caption under the provider name.
 */
describe("Logs table cells clip inside their own column", () => {
  test("body cells hide overflow", () => {
    expect(lastDeclaration(".logs-table tbody td", "overflow")).toBe("hidden");
  });

  test("the effort cell may break anywhere so an unbroken chain still wraps", () => {
    expect(lastDeclaration(".log-reasoning-cell", "overflow-wrap")).toBe("anywhere");
  });

  test("the table is still fixed-layout (the guard exists because of it)", () => {
    expect(lastDeclaration("table.logs-table", "table-layout")).toBe("fixed");
  });
});
