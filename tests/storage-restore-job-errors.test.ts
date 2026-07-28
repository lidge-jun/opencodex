import { describe, expect, test } from "bun:test";
import { restoreResultFromWorkerRejection } from "../src/storage/restore-job";

describe("restoreResultFromWorkerRejection", () => {
  test("maps worker timeout to restore_worker_timeout", () => {
    const result = restoreResultFromWorkerRejection(new Error("restore_worker_timeout"), ".trash/1");
    expect(result).toMatchObject({
      ok: false,
      error: "restore_worker_timeout",
      count: 0,
      bytes: 0,
      restoredPaths: [],
    });
    expect(result.message).toBeUndefined();
  });

  test("maps cancel to restore_worker_aborted", () => {
    const result = restoreResultFromWorkerRejection(new Error("aborted"), ".trash/1");
    expect(result.error).toBe("restore_worker_aborted");
  });

  test("maps generic worker failure", () => {
    const result = restoreResultFromWorkerRejection(new Error("worker_failed"), ".trash/1");
    expect(result.error).toBe("restore_worker_failed");
    expect(result.message).toBeUndefined();
  });

  test("preserves unexpected worker crash detail", () => {
    const result = restoreResultFromWorkerRejection(
      new Error("sqlite disk I/O error"),
      ".trash/1",
    );
    expect(result.error).toBe("restore_worker_failed");
    expect(result.message).toBe("sqlite disk I/O error");
  });
});
