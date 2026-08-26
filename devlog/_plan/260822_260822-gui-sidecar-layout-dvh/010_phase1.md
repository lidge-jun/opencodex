# 010 — Phase 1: flex negotiation contract + grid floor

Slice: stop copy from ever reaching width 0. Everything else in this unit assumes copy
has a readable floor.

## MODIFY gui/src/styles-dashboard-workspace.css

### 1. Grid floor 21rem -> 24rem (line ~75-83)

The comment claims 21rem fits "title + model select". Measured ko control row is 325.6px
and the card needs 380px border-box. 21rem/336px is 44px short.

Before:
```css
.dash-sidecar-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 21rem), 1fr));
```
After:
```css
.dash-sidecar-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
```
Rewrite the comment above it to record the measured budget (168 select + 8 + ~108 label
+ 8 + 34 switch + 36 padding + 2 border = 364px min, 380px before copy dies) instead of
the stale "~21rem per card" claim.

### 2. Copy gets a real floor (line ~104-107)

Before:
```css
.dash-sidecar-row-card .dash-sidecar-copy {
  flex: 1 1 0;
  overflow-wrap: anywhere;
}
```
After:
```css
.dash-sidecar-row-card .dash-sidecar-copy {
  flex: 1 1 16rem;
  min-width: min(100%, 14rem);
  overflow-wrap: break-word;
}
```
Rationale to write into the comment: `anywhere` on a zero-width CJK box breaks after
every glyph. `break-word` still rescues an unbreakable token but refuses to shred normal
text, and the min-width means the zero-width state is unreachable in the first place.
These are the exact values the vision card already proved (lines 156-159).

### 3. Controls wrap instead of crushing copy (line ~115-119)

Before:
```css
.dash-sidecar-row-card .dash-delegation-controls {
  flex: 0 0 auto;
  flex-wrap: nowrap;
}
```
After:
```css
.dash-sidecar-row-card .dash-delegation-controls {
  flex: 0 1 auto;
  flex-wrap: wrap;
  min-width: 0;
}
```

### 4. Row may wrap (line ~142-144)

Before:
```css
.dash-sidecar-row-card {
  min-width: 0;
}
```
After:
```css
.dash-sidecar-row-card {
  min-width: 0;
  flex-wrap: wrap;
  row-gap: 12px;
}
```
Once the row can wrap, "copy shrinks to nothing" is structurally impossible: the controls
move to their own line first.

### 5. Vision overrides become redundant (line ~146-169)

`.dash-vision-sidecar-card { flex-wrap: wrap }` and its copy override now duplicate the
shared rule. Delete the duplicated declarations, keep only what is genuinely
vision-specific (the column control group). `align-items: flex-start` is NOT deleted here
— 030 owns it.

## Verification

- Browser sweep at card widths 280/336/380/430/475/560/700/900/1128px
- Assert `titleH <= 44` (two lines of 21px) at every width
- Assert `titleW >= 100` at every card width >= 280px

