import { readFileSync, statSync } from 'node:fs';
import type { UsageIdentity } from './usage-controller';

type Credential = { identity: UsageIdentity; accessToken: string };
const equal = (a: UsageIdentity, b: UsageIdentity) => a.id === b.id && a.userId === b.userId && a.plan === b.plan;

/** Local native credentials remain in memory and are never returned by the public reader. */
export function createNativeIdentityReader(authPath: string, upstreamFetch: typeof fetch = fetch) {
  const readCredential = (): Credential => {
    if (statSync(authPath).size > 1048576) throw new Error('Unexpected native auth size');
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    if (auth.auth_mode !== 'chatgpt' || typeof auth.tokens?.id_token !== 'string'
      || typeof auth.tokens?.access_token !== 'string' || !auth.tokens.access_token
      || typeof auth.tokens?.account_id !== 'string') throw new Error('Native login required');
    // These local claims are only a binding hint. Activation additionally verifies upstream.
    const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString('utf8'))['https://api.openai.com/auth'];
    if (!claims || claims.chatgpt_account_id !== auth.tokens.account_id
      || typeof claims.chatgpt_user_id !== 'string' || !claims.chatgpt_user_id
      || !['plus', 'pro'].includes(claims.chatgpt_plan_type)) throw new Error('Unsupported identity');
    return { identity: { id: auth.tokens.account_id, userId: claims.chatgpt_user_id,
      plan: claims.chatgpt_plan_type, structure: 'personal' }, accessToken: auth.tokens.access_token };
  };
  const readCurrentIdentity = async (): Promise<UsageIdentity | null> => {
    try { return readCredential().identity; } catch { return null; }
  };
  const verifyFreshIdentity = async (): Promise<UsageIdentity | null> => {
    try {
      const before = readCredential();
      const response = await upstreamFetch('https://chatgpt.com/backend-api/wham/usage', {
        headers: { authorization: 'Bearer ' + before.accessToken, 'ChatGPT-Account-ID': before.identity.id },
        redirect: 'manual', signal: AbortSignal.timeout(10000),
      });
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); return null; }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length;
          if (size > 65536) { await reader.cancel(); return null; }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const usage = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const after = readCredential();
      if (!equal(before.identity, after.identity) || before.accessToken !== after.accessToken
        || usage.account_id !== before.identity.id || usage.user_id !== before.identity.userId
        || usage.plan_type !== before.identity.plan) return null;
      return before.identity;
    } catch { return null; }
  };
  return { readCurrentIdentity, verifyFreshIdentity };
}
