# 030 — Runtime provenance recording

## Files

### NEW: scripts/runtime/qualified-bun.json
```json
{
  "candidateSpec": "1.4.0-canary.1",
  "qualifiedRevisions": [],
  "control": {
    "version": "1.3.14",
    "revision": "0d9b296af33f2b851fcbf4df3e9ec89751734ba4"
  }
}
```

### NEW: tests/bundled-bun-runtime.test.ts
- Assert Bun.version matches package.json dependencies.bun
- Record Bun.revision for qualification tracking
- Verify runtime source (bundled vs override vs process)

