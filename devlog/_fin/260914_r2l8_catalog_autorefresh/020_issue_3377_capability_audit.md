# Issue 3377 capability-declaration audit

Lane R2-L8 of the round-23 delivery unit. This note is the honest reading of the
current tree against issue 3377, not a plan to close it. The declaration half
is already on `dev`; what remains is activation, and every remaining activation
site sits outside this lane's write scope.

## What the type actually carries

`ModelCapabilities` in `src/types/provider.ts` is the stored declaration. An
exact model-ID entry may set `inputModalities` (`text` / `image` / `audio` /
`video`), `contextTier` (`default` / `long_context`), and `video.processing`
(`static` / `agentic`). The comment on `contextTier` is load-bearing: it is a
requested tier only, and storing it does not imply an upstream window or
activate an unverified wire. `src/config/provider-validation.ts` is the write
gate for all three axes. It rejects unknown axes, validates each vocabulary,
merges PATCH objects without sharing live rows, and treats null
map/model/axis/processing values as tombstones. File load retains valid axes
and restricts a malformed explicit modality list to text. Gather fingerprints
in `src/codex/catalog/provider-fetch.ts` include the whole map, so a periodic
catalog refresh will preserve whatever was declared; preservation is not
activation.

## Which axes run today

Only `inputModalities` is consumed at runtime. `configuredInputModalities` in
`src/codex/catalog/provider-fetch.ts` reads an exact `modelCapabilities[id].inputModalities`
entry before the legacy `modelInputModalities` record and writes it onto the
catalog row, including over a live `/models` vote that would otherwise win.
`src/vision/eligibility.ts` (`isModelVisionSidecarConsumer`, exported as
`isModelTextOnly`) treats a declared text-without-image list as the sidecar
consumer, and `src/vision/plan.ts` (`requiresVisionPreprocessing`) consults the
same declaration before legacy hints and vendor metadata. That is the text-only
axis issue 3377 asked for, and it is live.

`contextTier` is stored and inert. Nothing in `src/providers/github-copilot-transport.ts`
reads it. That file still only stamps Copilot editor-fingerprint headers and
fail-closes the OAuth bearer onto an allowlisted `*.githubcopilot.com` host. A
follow-up that wants `long_context` to mean a larger Copilot window has to own
that transport and the Copilot-specific request header or body field it would
emit; the pricing `contextTier` in `src/usage/cost.ts` is a different vocabulary
and must not be mistaken for this declaration. The catalog already has
`modelContextWindows` / `contextWindow` as a separate numeric contract, and
storing `contextTier: "long_context"` does not advertise those windows.

`video.processing` is stored and inert in the same way. The inbound and adapter
path already knows how to *carry* a video part: `src/chat/inbound.ts` translates
`video_url` into `input_video`, `src/responses/schema.ts` accepts that block,
and `src/adapters/google.ts` inlines Gemini video bytes (or a short marker for
a remote URL) whenever a `video` part is present. None of those sites reads
`modelCapabilities[id].video.processing`. Static versus agentic is therefore a
label in config, not a processing-mode switch. Activation would have to land in
those three files, and it would have to decide what "agentic" means on the
existing media-bridge loop rather than assuming the Google inline path is
enough.

## What the surfaces already accept

The management API already takes the full map. `src/server/management/provider-routes.ts`
validates PATCH `modelCapabilities` with tombstones allowed, merges axes onto
the live row, and on POST/PUT replacement runs the same merge so a complete
body cannot smuggle a tombstone through. Operators can therefore persist
`contextTier` and `video.processing` from the dashboard or a raw editor today;
the proxy will store them, fingerprint them, and do nothing else with them.

The CLI is narrower. `ocx provider add` in `src/cli/provider.ts` and
`ocx provider edit` in `src/cli/provider-runtime.ts` accept `--model <id> --text-only`
and write `inputModalities: ["text"]` for that one id, preserving sibling
declarations through `mergeModelCapabilities`. There is no `--context-tier` or
`video.processing` flag. An operator who wants those axes from the CLI has to
hand-edit `config.json` or PATCH the management API.

## What this lane does not close

Lane R2-L8 does not close issue 3377. Its write scope is the catalog
auto-refresh scheduler, the config section that gates it, the last-outcome
record, and the tests and structure paragraph that pin those. Every remaining
activation site — `src/providers/github-copilot-transport.ts` for the context
tier, `src/adapters/google.ts` plus `src/responses/schema.ts` plus
`src/chat/inbound.ts` for video processing, and a CLI flag surface if the
follow-up wants operator-facing declarations beyond management JSON — is
outside that scope. A later lane that actually closes 3377 has to own those
files, prove the Copilot long-context wire and the static/agentic video split
on a real request, and keep the storage contract in `src/config/provider-validation.ts`
as the write gate rather than re-implementing it.
