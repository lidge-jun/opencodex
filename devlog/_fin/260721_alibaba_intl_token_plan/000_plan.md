# Alibaba Token Plan International (ap-southeast-1) Provider

## Objective
Add `alibaba-token-plan-intl` provider to OpenCodex for international Alibaba Cloud
accounts that get redirected from the China console.

## Evidence
- International Token Plan confirmed at ap-southeast-1 (Singapore)
- Base URL: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`
- Pay-as-you-go intl: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
- Source: alibabacloud.com/help/en/model-studio/token-plan-overview

## International Token Plan Models
- qwen3.7-max, qwen3.7-plus, qwen3.6-plus, qwen3.6-flash
- deepseek-v4-pro, deepseek-v4-flash, deepseek-v3.2
- kimi-k2.7-code
- glm-5.2
- MiniMax-M2.5

## Changes

### 010 — base-url-choices.ts (MODIFY)
Add constants:
- `ALIBABA_INTL_TOKEN_PLAN_BASE_URL` = token-plan.ap-southeast-1 URL
- `ALIBABA_INTL_PAYG_BASE_URL` = dashscope-intl.aliyuncs.com URL
- `ALIBABA_INTL_BASE_URL_CHOICES` = [token-plan, payg, custom]

### 020 — registry.ts (MODIFY)
Add constants for international model list + metadata:
- `ALIBABA_INTL_TOKEN_PLAN_MODELS` — 10 models
- `ALIBABA_INTL_TOKEN_PLAN_INPUT_MODALITIES` — per-model
- Add `alibaba-token-plan-intl` registry entry with:
  - baseUrl → ALIBABA_INTL_TOKEN_PLAN_BASE_URL
  - baseUrlChoices → ALIBABA_INTL_BASE_URL_CHOICES
  - allowBaseUrlOverride: true
  - models, reasoning efforts, thinking budget
  - dashboardUrl → alibabacloud.com console

### 030 — provider-icons.ts (MODIFY)
- PROVIDER_ICON_ALIASES: `alibaba-token-plan-intl` → `alibaba-color.svg`
- PROVIDER_DISPLAY_NAMES: `alibaba-token-plan-intl` → `Alibaba Token Plan (Intl)`
  Also add `alibaba` and `alibaba-token-plan` display names

### 040 — tests (NEW/MODIFY)
- Add test for alibaba-token-plan-intl registry entry
- Verify baseUrlChoices, model list, matchBaseUrlChoice

## Scope Boundary
IN: New provider entry, GUI display, baseUrlChoices, tests
OUT: Existing alibaba/alibaba-token-plan/qwen-cloud entries unchanged
