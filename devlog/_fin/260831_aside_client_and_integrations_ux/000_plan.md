# Aside client + Integrations UX repair

Unit opened 2026-08-31. Two outcomes travel together because they land on the
same page: Aside becomes an export/integration client, and the Integrations
("연결") surface stops flooding itself with rollback rows.

They are one unit rather than two because the Aside work ADDS a twelfth card to
a page that is already too crowded to absorb one. Shipping the client first
would make the page measurably worse before it got better.

## The two problems

**Aside is unsupported.** Aside is a Chromium fork with a built-in browser
agent. Its custom-provider catalog lives at `~/.aside/u/<accountId>/models.json`
and its schema is the one Pi reads. The user on this machine already wired
opencodex into it BY HAND: the live file carries a `providers.opencodex` block
with 24 routed models, `api: "openai-completions"`, and
`apiKey: "opencodex-loopback"` — byte-identical to what `buildPiClientConfig`
emits. A hand-maintained integration is the strongest possible argument that
the client belongs in the registry.

**The Integrations page floods.** The rollback journal renders up to 50 rows,
each with its own border, at the bottom of the overview AND again on every file
client tab. The user's words were "로그 밑에 막 다닥다닥 뜨는 히스토리" — the
per-row borders are literally what produces that texture.

## Work phases

| Phase | Doc | Deliverable |
|---|---|---|
| wp1 | this unit | Research and roadmap (docs only) |
| wp2 | 010 | Aside export client + integration registry |
| wp3 | 020 | Aside GUI surface, marks entry, nine locales |
| wp4 | 030 | Rollback surface redesign |
| wp5 | 040 | Brand marks for the nine clients showing a monogram |
| wp6 | 050 | Stacked PR chain |
| wp7 | 060 | Marks for the last three monogram clients |
| wp8 | 070 | Marks on every Integrations surface, not just the API rows |
| wp9 | 080 | Conflict overwrite: writer, route, GUI dialog |

wp7 through wp9 were appended after the original six. Outcome and corrections:
`090_outcome.md`.

Research docs: 001 (Aside contract), 002 (registration checklist),
003 (Integrations UX diagnosis), 004 (brand mark provenance).

## Ordering constraint

wp4 and wp5 do not depend on wp2/wp3, and wp3 depends on wp2. The stack is
therefore not a single line: the Aside pair (wp2 then wp3) and the page repair
pair (wp4, wp5) are independent chains that both branch off `dev`. wp6 puts
them in review order.
