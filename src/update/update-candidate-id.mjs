import { createHash } from "node:crypto";

const DOMAIN = Buffer.from("ocx.update.candidate/1\0", "ascii");

/** Derive a lookup identifier; callers must separately verify release and target authority. */
export function deriveCandidateId(releaseDigest, targetId) {
  if (typeof releaseDigest !== "string" || !/^[0-9a-f]{64}$/.test(releaseDigest)) {
    throw new Error("Invalid release digest");
  }
  if (typeof targetId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(targetId)
      || targetId === "." || targetId === "..") {
    throw new Error("Invalid target ID");
  }
  const target = Buffer.from(targetId, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(target.length);
  return createHash("sha256")
    .update(DOMAIN)
    .update(Buffer.from(releaseDigest, "hex"))
    .update(length)
    .update(target)
    .digest("hex");
}
