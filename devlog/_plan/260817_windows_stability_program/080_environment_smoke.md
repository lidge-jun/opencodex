# 080 — Windows environment smoke coverage (F3)

**Depends on:** nothing structural. These are simplest to add alongside 060
stage 1, once a Windows leg is already executing, and they start **non-gating**
(`continue-on-error: true`). They do not wait for stage 3.

## Change

The unit suite tests logic. These test the environment, and no amount of unit
coverage substitutes for them. Each is a separate job in
`.github/workflows/ci.yml`, added one at a time, in this order — cheapest and
most certain first.

### 1. Non-ASCII username (do first)

A profile path like `C:\Users\김병준` exercises encoding through every path
join, config write, and PowerShell invocation. On `windows-latest`:

```powershell
$u = "ocxtest한글"
net user $u "P@ssw0rd-ocx-ci!" /add
```

then run `ocx doctor` and the config-write tests as that user via
`Start-Process -Credential`. Runner admin rights make local account creation
viable; this is the cheapest high-value item on the list.

### 2. Long paths

Check out into a directory deep enough to cross MAX_PATH (260). Two variants
via `HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled` set
to 1 and 0. Assert install and first request succeed in both, or fail with a
legible message in the 0 case.

### 3. Korean locale / code page 949

`chcp 949` before the CLI smoke, assert output is not mojibake. Cheap, and it
is the maintainer's own environment.

### 4. Non-admin user

Reuse the account from job 1 without elevation. Assert the product degrades
correctly where file symlinks throw EPERM — the suite already skips those cases
via a `canSymlink` probe, and skipping is not the same as degrading well.

### 5. Package replacement smoke (not `ocx update`)

`npm i -g @bitkyc08/opencodex@<previous>`, then `npm i -g` a locally packed
tarball of the candidate, then assert the CLI still runs and the service still
responds. This exercises **npm replacing a live global install on Windows** —
the step that produced #1849 — and it needs no pre-publication registry
artifact.

It is deliberately **not** an `ocx update` test, and must not be described as
one. `ocx update` resolves its target from the registry
(`src/update/index.ts:167`) and installs `@bitkyc08/opencodex@<resolved-version>`
(`src/update/index.ts:106`). There is no seam for injecting a local tarball, so
the real command cannot be driven against an unpublished candidate.

Covering `ocx update` itself needs one of: a published prerelease to update
*to*, or an injection seam in `updateCommand()` for a candidate target. The
second is a source change and belongs in the #1849 unit, not here. Until one
exists, this job covers the npm mechanics and says so.

### 6. OneDrive-redirected profile — investigate, do not schedule

Known Folder redirection with a sync filter driver holding handles is the most
common real-world source of the sharing violations 030 and 031 address, and it
is the item we most want. It is also the one with no clean hosted-runner story:
provisioning OneDrive and a signed-in account on an ephemeral runner is not a
CI step, it is a project. Redirecting Known Folders to a local path via registry
reproduces the *path shape* but not the filter driver, which is the part that
matters. Timebox an investigation; if there is no honest way to reproduce it,
record that here and rely on 031's counters instead.

### 7. Service across a reboot — likely not achievable, record the outcome

The highest-value item and the hardest. Hosted runners do not survive a reboot
with the job intact. A self-hosted runner could, but that reintroduces exactly
the persistent-state problem 060 is trying to avoid for gating. Investigate, and
if the answer is no, say so here rather than leaving it on a list forever.

## Verify

```powershell
bun run prepush
gh workflow run ci.yml --ref <branch>
```

Each job passes on a branch before joining the set. Add them individually — a
batch of seven new Windows jobs landing together makes the first failure
impossible to attribute.

## Risk

Medium, mostly time. Items 6 and 7 may not be achievable; the plan's obligation
is to reach a documented answer, not to keep them pending indefinitely.
