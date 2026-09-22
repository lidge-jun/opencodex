/**
 * The scanner's address pattern reads a Retina asset name as an email.
 *
 * `128x128@2x.png` is local part `128x128`, domain `2x`, and the deliberately loose TLD rule
 * accepts `png`, so listing the desktop icon set failed the gate. The exemption that fixes it is
 * one character away from a hole: a person's name in front of the same `@2x.png` suffix has the
 * identical shape and is a mailbox, so the rule is written against the asset-name grammar — a
 * pixel dimension, optionally prefixed the way an iconset member is — rather than against the
 * shape.
 *
 * This exercises the real `scanText`. A test that restated the regex would keep passing after the
 * exemption was widened, which is the only way this can go wrong.
 */
import { describe, expect, test } from "bun:test";
import { scanText } from "../../scripts/privacy-scan";

/** Assembled at runtime so this file carries no bare address of its own. */
const mailbox = (local: string, domain: string): string => [local, domain].join("@");

describe("privacy scan: Retina asset names", () => {
  test("the icon set the generator declares does not read as addresses", () => {
    for (const name of ["128x128@2x.png", "icon_16x16@2x.png", "icon_512x512@2x.png"]) {
      expect(scanText("desktop/scripts/generate-icons.ts", `"${name}": 256,`)
        .filter(finding => finding.kind === "email")).toEqual([]);
    }
  });

  test("a mailbox wearing the same suffix is still a finding", () => {
    for (const local of ["alice", "j.doe", "support"]) {
      const line = `contact ${mailbox(local, "2x.png")}`;
      expect(scanText("src/example.ts", line).some(finding => finding.kind === "email")).toBe(true);
    }
  });

  test("the exemption does not extend past the scale suffix and a raster extension", () => {
    const cases = [
      mailbox("128x128", "2x.com"),
      mailbox("128x128", "4x.png"),
      mailbox("128x128", "2x.example.com"),
    ];
    for (const line of cases) {
      expect(scanText("src/example.ts", line).some(finding => finding.kind === "email")).toBe(true);
    }
  });
});
