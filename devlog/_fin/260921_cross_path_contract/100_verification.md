# Verification on the landed tip

The eight lanes were re-read on `dev` after they landed, from source rather
than from commit messages, to check that each acceptance is actually present.
Six hold as written. Three carry a boundary that the plan did not state, and
they are written down here because each of them is the kind of thing a later
reader would otherwise discover as a surprise.

**The replay refusal is identical on all three surfaces.** The translated Chat
wrapper, the native Chat route and the Responses error path each preserve
`upstream_reset_replay_refused`, drop `Retry-After`, and send
`x-should-retry: false`. That last header is what makes the intent legible to a
client whose default is to retry a 429.

**The Chat inbound keeps a mid-conversation instruction in place, with one
ordering rule.** Leading system text still becomes `instructions`. A developer
message that arrives inside an open tool-call batch is held until the batch
closes rather than being spliced between a call and its result, because a
transcript that interleaves them is not one any destination accepts. Outside a
batch the message stays exactly where it arrived.

**The native Chat route honours an explicit setting only.** `true` rewrites the
developer role to system; `false` and unset return the caller's messages
untouched, which keeps the passthrough contract that route exists for.

**The repair enforces the request's tool selection on what it reconstructs.**
The rebuilt terminal output excludes a forbidden call and keeps the ordinary
text that arrived beside it. Raw `output_item.done` blocks are not rewritten by
the repair — policing the raw stream belongs to the undeclared-tool guard, and
splitting it that way keeps one owner per question.

**The client store is shared by enable, refresh and disable.** An unknown schema
is reported rather than merged into. When this project's own block is still in
the legacy file, refresh refuses and disable cleans that file first: the
alternative is a block left in one file while another is written, which is the
state that made the original report hard to diagnose.

**The resend grant is one shared ledger entry.** Derived and combo budgets
inherit it rather than opening their own, so composing recovery legs cannot
multiply the allowance. The ceiling itself stays operator-configurable; what is
fixed is that there is one of it per logical request.

## Issue dispositions

`#5348` is closed: its acceptance is on `dev`. `#4191` and `#5180` stay open
with their remaining scope recorded on the issues — a dead mid-turn transport
still has no fallback, and a provider 429 on a single key still has no cooldown
policy. Neither is what a per-request resend budget decides.
