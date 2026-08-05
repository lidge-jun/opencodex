# 003 — UX direction

What the tab should be, in this repository's existing grammar. Design decisions
only; phases `040` and `050` own the markup.

## 1. What the tab is for

One sentence: *this is where you take the proxy out of this machine.*

Everything on it serves an external client — the base URL you paste, the key you
deploy, the model id you send, the header you set. That framing settles several
arguments below. It is also why W1 and W3 (`001`) are the worst defects here and
not merely inaccuracies: they are wrong about the two things the tab exists to
tell you.

## 2. Keep the rail — but only if phase 3 lands

`5aa51b9d7` deleted the Subagents rail because its detail pane "carried no
information the row did not already show". The API rail is in that exact state
today (`001` W7). Two honest options:

**A. Delete the rail.** Keys become a table in the overview, like the pre-#444
layout that `9b37ef5a9` restored. Cheap, consistent with Subagents, and the tab
loses the only place a per-key story could ever live.

**B. Give the rail something to show.** Storage kept its rail because its rows are
comparative (name, bytes, files) and its detail goes deeper — oldest/newest,
largest entries (`StorageWorkspace.tsx:92-167`). Attribution (phase 3) makes an
API key comparative in exactly the same way: requests, tokens, last used.

**Chosen: B, conditional.** The rail survives on the strength of phase 3. If
phase 3 cannot deliver attribution, phase 4 falls back to A rather than shipping a
rail that repeats itself for a third time. This is stated here so the fallback is
a planned branch, not an improvisation at build time.

Rail row after phase 3: name · requests in the last 7 days · last used. Prefix
moves to detail, where it is a fact about the key rather than a column that reads
identically on every row.

## 3. The auth matrix replaces the auth paragraph

Four prose lines currently describe a rule that is per-endpoint
(`api-keys-panels.tsx:194-199`), and one of them is wrong (`001` W1). Prose cannot
state a matrix; a matrix can.

```
Endpoint            Authorization: Bearer   x-opencodex-api-key   x-api-key
/v1/responses               —                      required           —
/v1/chat/completions        —                      required           —
/v1/messages             accepted                 accepted        accepted
/v1/models               accepted                 accepted        accepted
```

Three rules for it:

- **The server emits it, the GUI renders it.** Hardcoding this table in the
  frontend recreates the defect it fixes — the next auth change would leave the
  GUI lying again. `GET /api/keys` gains an `authMatrix` array; the wrapper each
  route uses is the source of truth (`002` §1).
- **It is not collapsed.** The current `<details>` (`api-keys-panels.tsx:191-202`)
  hides the one thing a user needs before their first request succeeds. It sits
  open, next to the endpoint rows it describes.
- **Loopback is stated once, plainly.** On a loopback bind none of this applies —
  auth is bypassed (`auth-cors.ts:184-193`). That is a footnote to the matrix,
  not a fifth prose line competing with it.

## 4. The model test tells the truth or does not run

Today: one chat request, no auth header, an `OK` badge next to three protocol
chips (`001` W2, W3). The fix has two halves.

- **Test what the chip says.** The row's chips come from
  `gatewayInboundProtocols`; the test targets the protocol the user picks, and a
  result badge attaches to that chip, not to the row.
- **Test the way a client would.** Loopback bypasses auth, so a header-less test
  is unfalsifiable — it passes whether or not the key works. The request carries
  `x-opencodex-api-key`, which is the header every endpoint accepts (`002` §1),
  making a pass mean something on a remote bind too.

### The constraint this creates, stated plainly

Sending a real key means the GUI must hold one, and it only ever holds the
one-time `newKey` from a POST (`ApiKeys.tsx:71`). GET returns a prefix by design
(`001` §2) and no endpoint hands back stored key material. So an authenticated
model test is only available in the window after generating a key, and at every
other time the test controls are disabled with an explanation.

That is worse than "test any model any time", and it is still the right trade.
The alternatives are: send the prefix (proves nothing), add an endpoint that
returns stored secrets (a new exfiltration surface for a convenience feature), or
keep the header-less test (which is the defect). A test that is unavailable is
honest; a test that always passes is not.

## 5. Density, scroll, and what phase 5 removes

The house rules are settled and this tab is the last one not following them:

- No fixed-height page shell. `styles-apikeys-workspace.css:536-552` sets
  `100dvh` + `overflow: hidden`; Storage removed exactly this
  (`styles-storage-workspace.css:11-23`).
- Cap only genuinely unbounded regions — here, the model table alone.
- Capped regions use `overscroll-behavior: auto` so the wheel hands back at either
  end (`87681e540`). The model scroller uses `contain` today (`:245-255`).
- Nothing load-bearing hides behind a closed `<details>` (§3).
- Every row stays in the document. No collapsible list swallows content.

## 6. Copy discipline

- "Delete" for a key is permanent and says so; the confirm text names the
  consequence rather than asking twice.
- A copy action that fails says it failed (`001` W4). The one-time key is the one
  string in the product with no second chance.
- Empty-because-filtered and empty-because-nothing-exists get different sentences
  (`001` W9).
- Attribution states its own limits: rows recorded before the feature existed
  carry no key id, and the pane says so rather than rendering a zero that reads
  as "never used".

## 7. Namespace and coordination

New keys live under `api.auth.*` (matrix), `api.key.*` (lifecycle, detail) and
`api.attribution.*` (usage). `api.clientConfig.*` belongs to
`260731_client_config_export`; neither unit writes the other's namespace
(`000` §Coordination). The left overview column's panel list is frozen for this
unit so that unit's panel lands without a conflict.
