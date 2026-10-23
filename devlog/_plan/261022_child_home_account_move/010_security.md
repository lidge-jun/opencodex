# OCX-4 security note: Child-to-Home account move

This is a threat model for a design that is not built. It describes no existing weakness.

## Assets and trust today

The assets are provider credentials: OAuth refresh and access tokens, Codex pool tokens and API keys. Today each
stays on the machine that signed in, and ADR-6032 keeps them off the link. After this change one credential
can exist on two machines, and the link carries it once, sealed.

The Home already sees everything a Child sends upstream, because it relays every request. A compromised Home
can already read a linked Child's prompts. Giving it the Child's credentials adds the ability to use those
accounts directly. That is the purpose of the feature and the reason consent sits on the Home, per account.

## Threats

### A compromised Child

A Child under an attacker's control holds the link key and can pass relay auth. What it can try:

- **Plant an attacker-owned account in the Home pool.** If the Home routes the person's traffic through it,
  the attacker's upstream account receives the person's prompts. Defenses: nothing moves without a per-account
  approval on a paired Home session; the row shows the masked identity so the person can recognize their own
  account; imports never become active automatically (D6); the audit names the source link. Residual risk: a
  person who approves an identity they do not recognize. The UI should say plainly that approving lets the
  Home send requests through this account.
- **Redirect a credential.** A key paired with a malicious base URL would leak every request. Defense: only
  credentials move; the item binds to an existing Home provider and that provider's endpoint, and the payload
  parser rejects endpoint, header and model fields.
- **Overwrite a Home account.** Defense: dedupe refuses an existing identity and never overwrites (D5).
- **Exhaust the Home.** Bounded open offers per link, bounded items per offer, bounded payload size, strict
  parsing, and a rate limit on offer creation. Offers carry no secrets, so storing them costs little.
- **Approve its own offer.** The approval route is a Home dashboard route; the hub-link listener never admits
  it, and a loopback-bootstrapped session on the Home cannot approve.
- **Lie in quota hints.** Hints only order selection and expire; they never mark an account exhausted or
  paused on the Home. A durable pause arriving from the Child makes the account paused, which is a
  denial-of-service on that one account only and is visible on the row before approval.

### Replay

- A captured relay request cannot be replayed on another socket: relay auth binds the request to one proven
  socket with a one-use nonce.
- A repeated upload for a committed item answers `already_committed` and changes nothing; item state moves
  forward only.
- An upload must match the `payloadDigest` the person approved and arrive inside the upload window, on the
  same link id and key. Rotation or revocation expires open offers.
- The sealing key is per offer and dropped when the offer closes, so an old sealed payload cannot be opened
  later even if replayed into a new offer.

### Partial transfer

Each item commits on its own, through an atomic store writer, under the config mutation lock. A crash leaves
the item either uncommitted (retryable) or committed with provenance that restart reconciliation recognizes.
The Child's copy is untouched until it learns of the commit, so the failure direction is "the account exists in
both places", never "the account exists nowhere".

### Interception on a machine

SSH encrypts between machines. Relay auth proves the port's owner but, as the Remote Link doc states, is not
encryption against an active local intermediary on the loopback port. Sealing payloads to a per-offer Home key
(D2) closes that gap for credentials: an intermediary sees only ciphertext bound to the offer and item.

### Refresh-token reuse

Two live copies of a rotating refresh token sign each other out. Making the Child's copy dormant at commit
avoids this in normal use; explicit resume on a standalone Child warns about it (D1).

### Leakage through records

Audit and offer files carry masked identities and digests only, with private permissions. Digests of OAuth
identities are over account ids or subjects. For a bare API key the identity digest is over the key, which is
high entropy, so the digest does not make the key cheaper to recover. No log line carries a payload, a token
or a full email. `privacy:scan` covers the new formats.

## What stays out of reach

- SSH exec, `scp`, export files and clipboard paths are never used.
- GOAT drives offers and reads progress but never receives a credential and cannot approve.
- A Home never pulls from a Child; there is no route by which a Home asks a Child for credentials.

