import { expect, test } from "bun:test";
import { createRouteProofRegistry, isRouteProofId } from "../../src/link/route-proof";

const ID = "0123456789abcdef0123456789abcdef";

function registry(generation: { value: string | undefined }, clock = { now: 1_000 }) {
  return createRouteProofRegistry({ now: () => clock.now, generationOf: () => generation.value });
}

test("an authenticated request carrying the id for the registered key and generation admits it", () => {
  const generation = { value: "rt:7" };
  const proofs = registry(generation);
  const handle = proofs.register({ linkId: "lnk_a", apiKeyId: "key-a", generation: "rt:7", proofId: ID, expiresAt: 2_000 });
  expect(handle.admitted()).toBe(false);
  proofs.admit("key-a", ID);
  expect(handle.admitted()).toBe(true);
});

test.each([
  ["another link key", "key-b", ID, "rt:7", 1_000],
  ["another proof id", "key-a", "f".repeat(32), "rt:7", 1_000],
  ["a newer tunnel generation", "key-a", ID, "rt:8", 1_000],
  ["no tunnel at all", "key-a", ID, undefined, 1_000],
  ["an expired proof", "key-a", ID, "rt:7", 2_000],
] as const)("%s does not admit", (_label, key, id, current, at) => {
  const clock = { now: at };
  const proofs = registry({ value: current }, clock);
  const handle = proofs.register({ linkId: "lnk_a", apiKeyId: "key-a", generation: "rt:7", proofId: ID, expiresAt: 2_000 });
  proofs.admit(key, id);
  expect(handle.admitted()).toBe(false);
});

test("a new registration replaces the link's previous proof, and dispose removes only its own", () => {
  const proofs = registry({ value: "rt:7" });
  const first = proofs.register({ linkId: "lnk_a", apiKeyId: "key-a", generation: "rt:7", proofId: ID, expiresAt: 2_000 });
  const second = proofs.register({ linkId: "lnk_a", apiKeyId: "key-a", generation: "rt:7", proofId: "e".repeat(32), expiresAt: 2_000 });
  proofs.admit("key-a", ID);
  expect(first.admitted()).toBe(false);
  first.dispose();
  expect(proofs.size()).toBe(1);
  proofs.admit("key-a", "e".repeat(32));
  expect(second.admitted()).toBe(true);
  second.dispose();
  expect(proofs.size()).toBe(0);
});

test("only 32 lowercase hex characters are a proof id", () => {
  expect(isRouteProofId(ID)).toBe(true);
  for (const value of [ID.toUpperCase(), ID.slice(1), ID + "0", "../" + ID.slice(3), 7, undefined]) expect(isRouteProofId(value)).toBe(false);
  const proofs = registry({ value: "rt:7" });
  expect(() => proofs.register({ linkId: "lnk_a", apiKeyId: "key-a", generation: "rt:7", proofId: "nope", expiresAt: 2_000 })).toThrow();
});
