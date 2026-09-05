# Orphan image carriers

Depends on030 observation/fallback contract; wp4. C3, same bounds as000.

## MODIFY src/adapters/anthropic.ts

Search found orphanToolResultText and toAnthropicContentPart as owners. Add one local
orphanToolResultContent helper returning string|unknown[]: image-free content returns
existing orphanToolResultText exactly; an
image-bearing array becomes an annotation text block followed by existing
toAnthropicContentPart mappings with empty text filtered as in toAnthropicToolResult.
Never JSON-stringify image bytes. Use helper at both sites:

```diff
- orphanBlocks.push({ type: "text", text: orphanToolResultText(tr) });
+ const orphan = orphanToolResultContent(tr);
+ orphanBlocks.push(...(typeof orphan === "string" ? [{ type: "text", text: orphan }] : orphan));
- messages.push({ role: "user", content: orphanToolResultText(msg) });
+ messages.push({ role: "user", content: orphanToolResultContent(msg) });
```

Declare orphanBlocks unknown[] to match the existing content mapper's unknown return;
do not add a cast/export. Keep valid tool_result blocks before orphan siblings.

## MODIFY src/adapters/command-code.ts

Hoist existing image extraction and wireImagePart mapping before paired/orphan split.
Append mapped images to orphan user carrier after its provenance text; leave
closePendingCalls before the carrier. Reuse mapped images in paired result buffer.
No new shared utility or change to parallel-result ordering.

## MODIFY tests/adapters/adapter-usage.test.ts and tests/providers/command-code-provider.test.ts

Extend existing orphan/paired-image tests: standalone, duplicate, unmatched adjacent,
user barrier, outstanding other call; data+HTTPS; mixed/empty text; native image blocks
and no base64 in text; no fabricated tool pairing; existing exact text-only behavior.

Main standalone adapter body probe must fail before and pass after. Workers have
disjoint adapter+test paths, no suites/services/git writes. Main owns verification,
docs note, fourth stacked PR and CI. No merge before050/060 acceptance.
