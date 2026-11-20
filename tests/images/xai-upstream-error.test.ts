import { expect, test } from "bun:test";
import { safeXaiErrorDetail, safeVideoFailureCode, readSafeXaiErrorDetail } from "../../src/images/xai-upstream-error";
test("only closed xAI error vocabulary is returned", async () => {
  for (const value of ["This model only supports the following quality value(s): low, medium, auto.", "`last_frame` is not supported for this model.", "1080p video resolution is not available for this model.", "Too many keyframes: 5. Maximum allowed is 4.", "`keyframes` timestamp 5s must be strictly inside the clip (0 < t < 2s)."]) expect(safeXaiErrorDetail(value)).toBe(value);
  for (const value of ["This model only supports the following quality value(s): secret, words.", "`my_prompt` is not supported for this model.", "999p video resolution is not available for this model.", "xai-secret", "/home/user/prompt", "https://example.com", "<html>secret</html>", "`keyframes` timestamp 5s must be strictly inside the clip (0 < t < 2s). secret"]) expect(safeXaiErrorDetail(value)).toBeUndefined();
  expect(safeVideoFailureCode("invalid_argument")).toBe("invalid_argument");
  expect(safeVideoFailureCode("xai-secret")).toBeUndefined();
  expect(await readSafeXaiErrorDetail(Response.json({error:{message:"`image` is not supported for this model."}}))).toBe("`image` is not supported for this model.");
});
