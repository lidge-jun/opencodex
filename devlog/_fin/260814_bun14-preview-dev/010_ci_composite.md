# 010 — CI: Source Bun version from package.json

## Files

### NEW: .github/actions/setup-project-bun/action.yml
Composite action that reads `dependencies.bun` from package.json and sets up Bun.

```yaml
name: Setup project Bun
description: Install the Bun version declared in package.json
runs:
  using: composite
  steps:
    - name: Resolve project Bun version
      id: project-bun
      shell: bash
      run: |
        version="$(node -p "require('./package.json').dependencies.bun")"
        test -n "$version"
        echo "version=$version" >> "$GITHUB_OUTPUT"
    - name: Setup Bun
      uses: oven-sh/setup-bun@v2
      with:
        bun-version: ${{ steps.project-bun.outputs.version }}
```

### MODIFY: .github/workflows/ci.yml
- Replace all 7 occurrences of `bun-version: 1.3.14` with composite action ref
- Add `preview-dev` to push.branches

### MODIFY: .github/workflows/service-lifecycle.yml
- Replace all 3 occurrences of `bun-version: 1.3.14` with composite action ref

### MODIFY: .github/workflows/release.yml
- Replace `bun-version: 1.3.14` with composite action ref (release stays main/preview only)

## Verification
```bash
grep -r 'bun-version: 1.3.14' .github/ # must return empty
```

