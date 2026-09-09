# All-image-format audit, 2026-09-05

The user expanded the review from the reported OpenAI paths to every image format.
Two independent gpt-6-astra high reviewers inspected ingress and outgoing format
families. These are source-verified gaps, not claims that the first patch introduced
regressions. No unsupported provider-specific file resolver is being invented.

| Surface | Supported transport / current boundary | Disposition |
| --- | --- | --- |
| Chat user image_url object/data/HTTPS/detail | Existing URLs preserved; detail fixed in 010 | Covered by lower and wire PRs |
| Chat tool image arrays/string URLs | OpenCodex extension, not standard upstream tool-role support | Fixed in 010; native Chat keeps its contract |
| Responses message input_image | URL/data; file_id native or text marker translated | Existing supported behavior |
| Responses function/custom output file_id | Raw native retains reference; translated parser drops it | 030: use existing file marker convention |
| Responses computer_screenshot output | Raw native retains item; translated parser ignores screenshot | 030: explicit translated400, native unchanged |
| Claude user/tool base64 and URL | Dedicated mapper and nested tool outputs | Covered by wire matrix |
| Claude source:file | Native reference valid; translated mapper drops it | 030: explicit translated error, no cross-provider resolution |
| Responses/Azure | Native raw inputs and repairable orphan images retained | No additional loss found |
| Chat/Mimo | User-image carrier after pending tool batch | No additional loss found |
| Anthropic | Paired image result works; orphan baseline JSON-inlines image data | 040: native image sibling with provenance; baseline standalone exit1 confirmed |
| Command Code | Paired image carrier works; orphan baseline skips it | 040: reuse wireImagePart on orphan carrier; baseline standalone exit1 confirmed |
| Google/Vertex/Antigravity | Data -> inline_data, tool image siblings | Remote-URL marker remains existing limitation |
| Kiro | Data images on user carrier; orphan pairing rejected | Remote URL remains existing limitation |
| Ollama native | Data/raw base64 images; unsupported URL/pairing rejected | Existing explicit contract |
| Cursor native MCP | Image bytes carried with tool result | Preserve unchanged |
| Cursor external wire | Active user images work; trailing tool images not prepared | 050: active trailing run only, existing count/byte limits |

Key owners: src/responses/parser.ts:304, :732; src/claude/inbound.ts:134;
src/adapters/anthropic.ts:637, :753, :775; src/adapters/command-code.ts:110;
src/adapters/cursor/images.ts:647; cursor/live-transport.ts:621;
cursor/protobuf-request.ts:1383. Ordinary user images on OpenAI were already retained.

The live 10100 process is version2.43.0 from the maintainer's main checkout, not this
worktree. A safe configuration inspection found no text-only declaration for native
OpenAI. No model request or personal request inspection was done, so the reported
specific OCR failure remains unattributed. Do not infer loaded commit from version.

## Hypotheses and negative controls

- H1 adapter cannot carry images: falsified by paired/native image branches.
- H2 image-bearing representation is dropped on a branch: source evidence above;
  confirm each modified owner with a standalone body/encoder probe before editing.
- H3 capability policy intentionally omits images: true for documented URL/history
  limits and text-only sidecars, excluded from universal vision-support claims.

No new remote fetching, uploads, auth, provider metadata, tool execution, historical
image recall, or file-handle resolution. Full audit means every row has a disposition,
not that every upstream supports every representation. All new tests execute in CI only.
