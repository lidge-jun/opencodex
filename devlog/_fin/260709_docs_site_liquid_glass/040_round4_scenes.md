# 040 — round 4: scene scrolltelling (sticky stack + kinetic type + frame scrub)

## User steering (260710)

- motion.md 준수: 쌓임 / 좌우 / 창전환 감성으로 시작.
- 이후 좌우 레일은 폐기. 퀵 씬은 상하 배치로 정리하고, 데모는 프레임 스크럽으로 전환.
- 결과 방향: sticky stack scene, kinetic type, frame-sequence demo scrub.

## Shipped

- Scene architecture: `.lp-scenes` wrappers + named `view-timeline: --scene`;
  sticky `.lp-scene-inner` stages는 pill header 아래에 붙고, stage 전체 높이를 사용.
- Exit motion: `ocx-scene-sink` on exit range (scale .94 / opacity .12), hero
  exit에서 field push-in.
- Kinetic typography: `.lp-kline` text-wipe (`clip-path`) staggered by cover ranges.
- Quickstart split: quick scene 안에는 2-line terminal만 유지, full 4-line terminal은
  full-width bento cell (`.lp-cell-terminal`, `grid-column: 1 / -1`)로 이동.
- Horizontal rail은 구현 후 user steering에 따라 제거. 대신 frame-sequence scrub scene:
  `ffmpeg`로 `demo.gif` -> 158 webp frames @12fps 960w, 2.6MB,
  `public/demo-frames/`.
- Canvas scroll scrub: motion.md 방식으로 `IntersectionObserver` lazy start,
  checkpoint-first progressive loading, `requestIdleCallback` fill, rAF scroll
  handler. Reduced-motion + `<48rem`은 short-circuit, animated poster 유지.

## Debug ledger

1. Blank stage zones: inner가 max-height/content-height라 빈 구간이 생김 — full
   stage height + centered content로 수정.
2. Rail contain-range dead zone: tall subject라 contain 시작이 늦음 — cover 28-72
   mapping 사용.
3. Rail `translateX(-100%)`: flex container width 기준으로 계산됨 — `width:
   max-content`로 해결. Rail은 이후 제거됐지만 lesson 기록.
