import { expect, test } from "bun:test";
import { resetNormalizeStateForTests } from "../../src/adapters/anthropic-image-normalize";
import { completion, fixture, image413 } from "../helpers/anthropic-image-413-fixture";

// Captured on dev 53257cad991a21df2d0c038665824cb48ba8fa8a with the same fixture.
const devBodyHashes = [
  "c6219a0c13033e32a8e2286d5a93cecda9e7ea0b9c9ce36d81e01c5889881d1d",
  "da2658bbb957f6d312b292a4411a5de0a62bc3a7be29e3e2cedb711dcb2370c9",
];

for (const enabled of [undefined, false]) {
  test(`anthropic-image default wire bytes match dev (flag=${enabled})`, async () => {
    resetNormalizeStateForTests();
    try {
      const { sent, text } = await fixture({ enabled, image: "large",
        handle: (_wire, index) => index === 1 ? image413() : completion("Legacy tightened image retry") });
      expect(text).toContain("Legacy tightened image retry");
      expect(sent).toHaveLength(2);
      expect(sent[0]!.body).not.toBe(sent[1]!.body);
      expect(sent.map(send => new Bun.CryptoHasher("sha256").update(send.body).digest("hex"))).toEqual(devBodyHashes);
    } finally {
      resetNormalizeStateForTests();
    }
  });
}
