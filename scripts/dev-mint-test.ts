// Standalone mint harness: exercises the solver without touching the gateway.
// Run: bun scripts/dev-mint-test.ts   (dev-only, not shipped in the PR)
import { writeFileSync } from "node:fs";
import { solveTraceless } from "../src/adapters/zcode-start-plan/captcha-solver";

const param = await solveTraceless({ scene: "11xygtvd", region: "sgp", prefix: "no8xfe", timeoutMs: 30000 });
writeFileSync("/tmp/captcha-param.txt", param);
console.log("MINTED", param.length);
