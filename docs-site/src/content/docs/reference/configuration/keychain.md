---
title: Storing keys in the OS keychain
description: Storing provider API keys and Vertex credentials in macOS Keychain, Windows Credential Manager, or Linux Secret Service.
---

For Vertex, the dedicated API-key pool input (`POST /api/providers/keys`) accepts complete GCP
`service_account` or `authorized_user` credential JSON after the provider has been created.
The provider create/edit form and `ocx provider add --api-key` refuse credential JSON before
saving: create the provider without a key, then add the JSON through its key pool. Paste the
JSON contents, not a Windows, Unix, or relative file path. Multiple
JSON objects separated by commas or whitespace are stored together as separate pool entries;
the first becomes active. Configuration contains only `gcp-sa:<account>` references, never the
credential JSON. Mixed JSON/literal-key bulk pastes are rejected as a whole; add literal keys
separately. Storage failures leave the configuration unchanged and report a fixed error without
echoing credential material. Empty marker accounts are invalid and do not fall back to host credentials.
Paste one credential object or a sequence of objects, without an enclosing array or quoted string.
Malformed credential text is rejected. If a selected stored credential is removed or becomes unreadable,
Vertex refuses the request even when it previously cached an access token for that credential.
Removing a key or provider, or replacing a provider with `ocx provider add --force`, deletes its unreferenced GCP credentials after the configuration is
saved; a credential referenced by another provider is retained. If OS-store cleanup fails, a
warning requests manual inspection without undoing the committed configuration removal.
Ordinary keychain store/restore actions leave GCP markers and JSON in the OS store. Restoring
credential JSON through a `keychain:` alias is refused, and cleanup preserves accounts still
referenced through either marker spelling.
Using a `keychain:` alias containing GCP JSON as an API key also refuses the request; select its
`gcp-sa:` reference for Vertex authentication instead.
Literal API keys must be plain token text: JSON objects, arrays and quoted JSON strings are refused
in literal-key resolution and restore, including wrappers containing escaped credential text.
Credential writes and marker persistence share the cleanup transaction lock, so concurrent
removal cannot delete the stored JSON between read-back and the marker commit.

By default a provider's `apiKey` and `apiKeyPool` sit in `config.json` (mode 0600, atomic writes).
If you would rather keep the key material out of the file, move it into the OS credential store:

```bash
ocx provider keychain deepseek status    # store: file | env | keychain, and whether the keychain answers
ocx provider keychain deepseek store     # move active key + pool into the OS keychain
ocx provider keychain deepseek restore   # bring the plaintext back and delete the keychain items
```

The same operations are `GET`/`POST /api/providers/keychain`. After `store`, `config.json` holds
`"apiKey": "keychain:deepseek"` (pool entries `keychain:deepseek/<id>`) and the secret lives under the
`opencodex.provider-api-key.v1` service in macOS Keychain, Windows Credential Manager, or the Linux
Secret Service. Backups of `config.json` therefore carry references only. Key rotation and failover
keep working: pool entries compare by reference, so a rotation never writes plaintext back.

Before touching the config, `store` writes and reads back every entry; if the keychain is unavailable
or the read-back does not match, it refuses with 503 and leaves the file as it was. At request time
a reference that cannot be read yields no credential and one warning per key — there is no plaintext
fallback, by design.

When not to opt in: a proxy running as a headless service (systemd, launchd, Task Scheduler) or in a
container usually has no unlocked keychain session, so requests would fail closed. Use an
`${ENV_VAR}` reference in the service environment there instead. Env references are left untouched
by `store`.
