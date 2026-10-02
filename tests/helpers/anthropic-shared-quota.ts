/** Synthetic upstream shared-quota refusal for existing cooldown/selection tests. */
import { rotateAnthropicAccountOn429 as rotate } from "../../src/oauth/anthropic-routing";
export const rotateAnthropicAccountOn429: typeof rotate = (...args) => {
  const supplied = args[5];
  args[5] = { get: name => name === "anthropic-ratelimit-unified-5h-status" && !supplied?.get(name)
    ? "rejected" : supplied?.get(name) ?? null };
  return rotate(...args);
};
