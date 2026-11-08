// A non-main entry keeps the release CLI dormant when its actual exports are
// bundled for the Node 18 interoperability harness.
export { parseMinisignPublicKey, verifyUpdaterSignature } from "../../desktop/scripts/verify-release-assets";
