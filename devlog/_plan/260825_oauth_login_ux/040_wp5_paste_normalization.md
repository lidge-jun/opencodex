# 040 — WP5: read a redirect's fragment, not only its query

**Issue:** feature proposal (parser hardening — not a reported failure).
**PR base:** `dev`. **Screenshot:** not required.

## Honest classification, first

**No provider in this repository can currently produce the input this fixes.**
That was checked, not assumed: every `OAuthCallbackFlow` subclass — ChatGPT,
xAI, Antigravity, Anthropic — requests `response_type=code` and none sets
`response_mode=fragment`, so an authorization-code response lands in the
query. Cursor, Kiro, Copilot, Kimi and Nous are not this class at all (poll,
device, or token-paste flows). Anthropic's copyable `code#state` is the *raw*
branch, not a URL fragment, which is why `exchangeToken` still splits on
`#`.

So this is **defensive parser hardening**, not a fix for a failure users are
hitting today. The first draft of this doc told a story about an operator
pasting their address bar and being told it contained no code. That story is
not reachable with the current provider set, and shipping it as a bug report
would have been a small lie in a changelog. The change is still worth making —
the cost is four lines and the parser is the one place a future
fragment-returning provider would land — but it ships described as what it is.

## The gap

`parseCallbackInput` (`callback-server.ts:273-300`) tries three shapes in
order: a parseable URL, a string containing `code=`, then a raw code with an
optional `#state`.

The URL branch reads `url.searchParams` only:

```ts
const url = new URL(value);
return {
  kind: "url",
  code: url.searchParams.get("code") ?? undefined,
  state: url.searchParams.get("state") ?? undefined,
};
```

A redirect that returned its parameters in the **fragment** —
`http://127.0.0.1:<port>/callback#code=abc&state=xyz` — parses as a valid URL,
yields no `code`, and is rejected by `submitManualLoginCode:1345` with
"no authorization code found in input". The hint text asks the operator to
"copy the full URL from its address bar", so that rejection would be
particularly hard to act on if a provider ever did this.

Note the asymmetry that makes it worth closing: the **raw** branch already
understands `code#state`, and the **query** branch already strips a leading
`#` (`value.replace(/^[?#]/, "")`). Fragments are understood everywhere
except in a full URL.

## The change

One function, `callback-server.ts:277-283`:

```diff
 try {
   const url = new URL(value);
-  return {
-    kind: "url",
-    code: url.searchParams.get("code") ?? undefined,
-    state: url.searchParams.get("state") ?? undefined,
-  };
+  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
+  // A redirect may return its parameters in the fragment. Query wins when both
+  // are present: it is the authorization-code response location, and a fragment
+  // is the shape an implicit-grant response uses.
+  return {
+    kind: "url",
+    code: url.searchParams.get("code") ?? fragment.get("code") ?? undefined,
+    state: url.searchParams.get("state") ?? fragment.get("state") ?? undefined,
+  };
 } catch {
   // Not a URL - check for query string format
 }
```

### What must not change

- **`kind` stays `"url"`.** That is what makes state mandatory
  (`callback-server.ts:252`, `index.ts:1347-1350`). A fragment-carried
  response is still an authorization response and gets the same CSRF
  treatment as a query-carried one. Downgrading it to `raw` to skip the state
  check would be a security regression wearing a convenience costume.
- **Only `code` and `state` are read.** Never `access_token`, never
  `id_token`. This repo does not implement the implicit grant and a paste
  path must not become the place it appears.
- **Query beats fragment** when both exist, so no existing paste changes
  meaning.

## Test

Extend `tests/oauth-manual-code.test.ts`, which already has a
`parseCallbackInput kinds` block (`:32-52`):

| Input | Expected |
|---|---|
| `http://localhost:1455/callback#code=abc&state=xyz` | `kind: "url"`, code `abc`, state `xyz` |
| `http://localhost:1455/callback?code=q&state=s#code=f&state=f` | query wins: `q` / `s` |
| `http://localhost:1455/callback#code=abc` | `kind: "url"`, code `abc`, **state undefined** |
| `http://localhost:1455/callback#access_token=t` | no code — a token fragment is not an authorization response |

Plus one end-to-end assertion through `submitManualLoginCode`: a
fragment-carried paste with a **mismatched** state is still rejected with the
state-mismatch error, proving the fix did not open a CSRF hole.

And one gap the inventory surfaced that belongs here because it is the same
function: `code#state` in the **raw** branch has no test today despite being
supported. Add it.

## Acceptance

- `parseCallbackInput` reads `code` and `state` from a URL fragment when the
  query does not carry them, and keeps `kind: "url"` so state stays mandatory.
- A fragment-carried paste with a missing or mismatched state is refused
  end-to-end through `submitManualLoginCode`, with the same messages a
  query-carried one gets. This is the assertion that proves the convenience did
  not become a CSRF hole.
- A token fragment yields no code.
- No existing accepted paste changes meaning: query wins when both are present.
- `bun run typecheck`, `bun run test` green.

Note what is deliberately **not** claimed: that a real login was failing. See
the classification at the top of this doc.
