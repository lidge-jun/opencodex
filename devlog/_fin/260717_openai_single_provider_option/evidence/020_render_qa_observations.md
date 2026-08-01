# Cycle 2 render-grounded QA observations

## Isolated runtime

- Child: `scripts/openai-provider-option-runtime-child.ts`
- PID: `4188`
- Port: `61203` (kernel-assigned from `port: 0`)
- Temporary root: `/tmp/ocx-provider-option-qa.KZAM2H`
- Live proxy `127.0.0.1:10100`: not contacted

## Desktop 1280 x 720, English, Pool

- DOM receipt: provider titles were exactly `openai` and `openai-apikey`; the page contained `Codex account mode`, `Pool`, `Direct`, `Manage Codex accounts`, and no `openai-multi` text.
- Models receipt: one `openai` group had 7 bare ids and one `openai-apikey` group had 8 namespaced ids. No legacy Multi group or row was present.
- Codex Auth receipt: banner text was `OpenAI account mode`, `Pool mode`, and `The main login and eligible added accounts rotate here.`
- API receipt: `020_desktop_en_pool_config.json` resolved `providers.openai.codexAccountMode` to `pool`.
- Screenshots: `020_desktop_en_pool_providers.png`, `020_desktop_en_pool_provider_cards.png`, `020_desktop_en_pool_codex_auth.png`, `020_desktop_en_pool_models.png`.

## Desktop 1280 x 720, German, Direct

- Interaction receipt: clicked the `Direkt` radio; PATCH returned success without navigation, child restart, or PID/port change.
- DOM receipt: the OpenAI card showed `Direkt`, direct-only description, and the Codex account-management link. Codex Auth showed `Direktmodus` and `FÜR POOL VORBEREITET` in rendered uppercase styling. Models retained the same 7 bare and 8 namespaced ids.
- API receipt: `020_desktop_de_direct_config.json` resolved `providers.openai.codexAccountMode` to `direct`.
- Screenshots: `020_desktop_de_direct_providers.png`, `020_desktop_de_direct_codex_auth.png`, `020_desktop_de_direct_models.png`.

## Mobile 390 x 844, Korean, Pool and Direct

- Geometry receipt: `innerWidth=390`, `innerHeight=844`, `scrollWidth=390` in both modes.
- Radio receipt: both controls were 130 x 44 CSS pixels and stayed inside x=80..342. Pool/Direct `aria-checked` values changed mutually exclusively after each successful PATCH.
- DOM receipt: provider titles were exactly `openai` and `openai-apikey`; both descriptions wrapped without horizontal overflow. Codex Auth changed between `풀 모드`/`다음 세션` and `직접 모드`/`풀 모드 준비됨`.
- API receipt: `020_mobile_ko_pool_config.json` resolved Pool after the final re-shoot.
- Screenshots: `020_mobile_ko_pool_providers.png`, `020_mobile_ko_direct_providers.png`, `020_mobile_ko_pool_codex_auth.png`, `020_mobile_ko_direct_codex_auth.png`.

## Mobile 390 x 844, Chinese, disabled

- Fixture receipt: isolated management API temporarily made a fixture provider default, disabled `openai`, captured the state, then restored and removed the fixture.
- DOM receipt: banner text was `内置 OpenAI 提供方已禁用。` with one `打开提供商` link. It contained no request to add Multi and no untranslated i18n key.
- Geometry receipt: `innerWidth=390`, `innerHeight=844`, `scrollWidth=390`.
- API receipt: `020_mobile_zh_disabled_config.json` recorded `providers.openai.disabled=true` and resolved mode `pool`.
- Screenshot: `020_mobile_zh_disabled_codex_auth.png`.

## Read-back and correction

- Initial Korean mode-save screenshots exposed literal particle notation (`풀(으)로`). The copy was changed to `OpenAI 계정 모드를 {mode} 모드로 변경했습니다.` and both Pool and Direct screenshots were re-shot.
- Final screenshots showed no clipped mode controls, duplicate OpenAI Codex card, horizontal overflow, literal translation keys, console errors, or failed management requests.
- A fresh Chinese reload captured zero console errors; the network receipt contained 10 successful same-origin document/asset/management requests and no failed request.
