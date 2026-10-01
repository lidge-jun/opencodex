---
title: Spend Ledger Refused in a Synced Folder
description: Why requests can fail with "Spend-ledger storage could not be opened safely" when the opencodex state directory is inside iCloud Drive or another synced folder, and how to fix it.
---

Some macOS users saw requests fail intermittently with HTTP 502 and this message, while
other requests in the same session succeeded:

```text
Provider unreachable: Spend-ledger storage could not be opened safely.
```

Current builds say which file and which check refused it, for example:

```text
Spend-ledger storage could not be opened safely (journal: extra-hard-link).
```

## What the check is

opencodex keeps a spend ledger in its state directory (`~/.opencodex` by default, or
`OPENCODEX_HOME`): a journal file, `spend-ledger.jsonl`, and a salt file, `spend-ledger.salt`.
Before every write it checks that each file is a regular file owned by you, is not a symbolic
link, and has exactly one directory entry. A second hard link would mean another name elsewhere
on the volume can see or change the same bytes, so opencodex refuses instead of writing through
it. This check stays strict on purpose.

| Condition in the message | Meaning |
| --- | --- |
| `extra-hard-link` | Another directory entry points at the same file. |
| `symbolic-link` | The ledger file is a symbolic link. |
| `not-regular-file` | Something other than a regular file sits at the ledger path. |
| `foreign-owner` | The file belongs to a different user. |
| `invalid-salt` | The salt file exists but its content is not a valid salt. |

The role in the message is `journal`, `journal-compaction` (the temporary file written while
the journal is compacted) or `salt`.

## Why a synced folder triggers it

macOS sync services, including iCloud Drive with "Desktop & Documents Folders" turned on and
File Provider clients such as OneDrive, Dropbox and Google Drive, can briefly keep a second link
to a file while they stage or upload a change. If the state directory is inside such a folder,
the journal can have two links for a moment after an ordinary write. A request that lands in
that moment is refused, and the next one may succeed. Once the sync settles, the file is back to
one link, so inspecting it afterwards shows nothing wrong.

At startup opencodex now warns when the state directory resolves inside iCloud Drive
(`~/Library/Mobile Documents`), a File Provider folder (`~/Library/CloudStorage`), or Desktop
or Documents while iCloud Desktop & Documents sync appears to be on. The warning is advisory.
The detection reads the folder layout and can be wrong in either direction.

## Fix

Keep the state directory outside synced folders. The default `~/.opencodex` is not synced.

1. Stop opencodex.
2. Move or copy the state directory to an unsynced location, for example `~/.opencodex-trial`.
3. Set `OPENCODEX_HOME` to that location, or unset it to use the default, and start opencodex
   again.

Do not delete the journal, relax its permissions, or remove the check to make the error go away.
The journal holds your recorded spend, and the check is what keeps it from being written through
an unexpected link.

If the message names a condition other than `extra-hard-link`, or the state directory is not in
a synced folder, please open an issue with the full refusal message. It contains no path,
account or request content.
