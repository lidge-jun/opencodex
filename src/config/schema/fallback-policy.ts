import * as z from "zod/v4";

/**
 * Read schema of `fallback` (OCX-11). A malformed leaf degrades to absent, which is today's
 * behavior, and config diagnostics name it; the management write boundary rejects it instead.
 * Map keys are checked by the resolver's normalization, so one bad key never drops its siblings.
 */
const switchValue = z.boolean().optional().catch(undefined);
const switchesSchema = z.object({ model: switchValue, provider: switchValue });
const deviceSchema = switchesSchema.extend({ localFallback: switchValue });

export const fallbackPolicySchema = z.object({
  model: switchValue,
  provider: switchValue,
  providers: z.record(z.string(), switchesSchema.catch({})).optional().catch(undefined),
  routes: z.record(z.string(), switchesSchema.catch({})).optional().catch(undefined),
  devices: z.record(z.string(), deviceSchema.catch({})).optional().catch(undefined),
});

export const FALLBACK_DEVICE_ID = /^(?:lnk_[0-9a-f]{16}|[A-Za-z0-9][A-Za-z0-9_.:-]{0,255})$/;
export const FALLBACK_SELECTOR = /^[^\s]{1,256}$/;

const strictSwitches = z.object({ model: z.boolean().optional(), provider: z.boolean().optional() }).strict();
const strictPolicy = z.object({
  model: z.boolean().optional(),
  provider: z.boolean().optional(),
  providers: z.record(z.string().regex(FALLBACK_SELECTOR), strictSwitches).optional(),
  routes: z.record(z.string().regex(FALLBACK_SELECTOR), strictSwitches).optional(),
  devices: z.record(z.string().regex(FALLBACK_DEVICE_ID), strictSwitches.extend({ localFallback: z.boolean().optional() }).strict()).optional(),
}).strict();

/** Diagnostics text for a section the read schema would partly ignore, or undefined. */
export function fallbackPolicyError(rawConfig: unknown): string | undefined {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) return undefined;
  const raw = (rawConfig as Record<string, unknown>).fallback;
  if (raw === undefined) return undefined;
  return strictPolicy.safeParse(raw).success
    ? undefined
    : "schema_invalid: fallback accepts boolean model/provider switches, providers/routes/devices maps of them, and devices.<id>.localFallback";
}
