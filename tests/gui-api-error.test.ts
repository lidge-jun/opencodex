import { describe, expect, test } from "bun:test";
import { apiErrorMessage } from "../gui/src/api-error";

describe("GUI management API errors", () => {
  test("surfaces an actionable server error", async () => {
    const response = Response.json(
      { error: "cannot delete the default provider; set another default first" },
      { status: 400 },
    );
    expect(await apiErrorMessage(response, "Delete failed")).toBe(
      "cannot delete the default provider; set another default first",
    );
  });

  test("falls back for empty, malformed, or blank errors", async () => {
    expect(await apiErrorMessage(new Response("", { status: 500 }), "Delete failed")).toBe("Delete failed");
    expect(await apiErrorMessage(new Response("not-json", { status: 500 }), "Delete failed")).toBe("Delete failed");
    expect(await apiErrorMessage(Response.json({ error: "   " }, { status: 400 }), "Delete failed")).toBe("Delete failed");
  });
});
