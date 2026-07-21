---
title: Провайдеры
description: Все способы, которыми opencodex аутентифицируется и общается с LLM-провайдером — OAuth, API-ключ, форвард ChatGPT и локальные серверы.
---

**Провайдер** — это одна вышестоящая конечная точка LLM плюс способ подключения к ней: адаптер,
базовый URL, режим аутентификации и необязательный список моделей. Провайдеры находятся в
`~/.opencodex/config.json` в секции `providers`.

## Режимы аккаунтов OpenAI

| Id провайдера | Назначение | Правило учётных данных/аккаунтов |
| --- | --- | --- |
| `openai` | Вход Codex | Pool (по умолчанию) выбирает основной и добавленные аккаунты; Direct использует только текущий вход вызывающей стороны/основной вход. |
| `openai-apikey` | OpenAI API | Только настроенный API-ключ/пул ключей; аккаунты Codex никогда не читаются. |

Используйте «голый» `gpt-5.6-sol` с опцией Pool/Direct на странице Providers или
`openai-apikey/gpt-5.6-sol` для API. Между маршрутами учётных данных нет сквозного фолбэка.
Маршрут API публикует метаданные: контекст 1,050,000 / максимум входных токенов 922,000. Его
виртуальные id `sol-pro`, `terra-pro` и `luna-pro` сохраняют выбранную публичную идентичность, тогда
как в фактическом запросе используется базовая модель плюс `reasoning.mode: "pro"`.

Поставляемые v1-конфигурации автоматически мигрируют на маркер 2 и одну строку с поддержкой опций.
Исходная конфигурация один раз сохраняется в `~/.opencodex/config.json.pre-openai-tiers-v2.bak`;
восстановить её можно командой
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`.

## Режимы аутентификации

Конфигурация провайдера принимает три значения `authMode` (по умолчанию — `key`). Встроенный реестр
также отдельно помечает локальные пресеты; в них обычно нет ни `authMode`, ни `apiKey`.

| `authMode` | Как выполняется аутентификация | Кем используется |
| --- | --- | --- |
| `key` | Отправляет ваш API-ключ (`Authorization: Bearer …` либо `x-api-key` / `api-key` в зависимости от адаптера). Ключ может быть литералом или ссылкой вида `${ENV_VAR}`. | Большинство провайдеров. |
| `forward` | Передаёт провайдеру **входящие заголовки аутентификации Codex** без изменений — ключ не хранится. Это сквозной режим (passthrough) входа через ChatGPT. | OpenAI (адаптер `openai-responses`). |
| `oauth` | Берёт сохранённый OAuth-токен доступа (автоматически обновляется до истечения срока) и использует его как bearer-ключ. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, GitHub Copilot. |

## 1. Вход через ChatGPT (forward / passthrough)

Провайдеру `openai` **не нужен API-ключ**. Direct пересылает учётные данные вашего существующего
`codex login`; Pool сначала выбирает основной или добавленный аккаунт Codex, а затем использует тот
же бэкенд:

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

Пересылается только ограниченный набор заголовков (`FORWARD_HEADERS`: authorization, ChatGPT
account id, OpenAI beta/originator/session — см. [Адаптеры](/opencodex/ru/reference/adapters/)).
Этот же путь обеспечивает работу [сайдкаров веб-поиска и vision](/opencodex/ru/guides/sidecars/).

Каталог сквозного режима ChatGPT дополнительно включает «голые» слаги GPT-5.6 Sol/Terra/Luna
(`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) для аккаунтов, которым они доступны.

## 2. Вход по аккаунту (OAuth)

Шесть пресетов провайдеров используют вход через OAuth — плюс GitHub Copilot через
экспериментальный неофициальный мост device flow. opencodex хранит их учётные данные в
`~/.opencodex/auth.json` и обновляет их автоматически. CLI входа также принимает `chatgpt`: эта
команда получает учётные данные ChatGPT и одновременно создаёт запись провайдера в режиме `forward`.

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login kiro         # импорт учётных данных kiro-cli (с фолбэком на токен)
ocx login google-antigravity
ocx login cursor       # отдельный PKCE-вход Cursor
ocx login github-copilot  # device flow GitHub → токен Copilot (Copilot Pro/Business)
ocx login chatgpt      # отдельный OAuth-вход ChatGPT
ocx logout <provider>
```

| Провайдер | Адаптер | Базовый URL | Примечания |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | Каталог Grok загружается в реальном времени; фолбэк по умолчанию — `grok-4.5`. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Модели Claude; актуальный список моделей загружается из `/v1/models`. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Модели Kimi K2.7/K2.6/K2.5 для кодинга. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | Вход сначала импортирует и переиспользует сессию установленного `kiro-cli`. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth поверх протокола Cloud Code Assist. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Экспериментальный PKCE-вход, живой транспорт HTTP/2 и обнаружение моделей с фильтрацией по аккаунту. |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | Экспериментально. Device flow GitHub + обмен `copilot_internal` (OAuth-клиент VS Code). Требуется активная подписка Copilot; это не официальный сторонний API. |

OAuth можно запустить и из [веб-дашборда](/opencodex/ru/guides/web-dashboard/).

### Несколько OAuth-аккаунтов

OAuth-провайдеры, чьи учётные данные содержат стабильный id аккаунта или email, могут хранить
несколько входов. Страница Providers показывает эти аккаунты в выпадающем списке, позволяет
добавить ещё один и переключает активный аккаунт, не выполняя выход из остальных. Учётные данные
Kimi и Kiro без идентификатора заменяют свой активный слот, а `chatgpt` всегда занимает один слот,
поскольку у пула аккаунтов Codex отдельный реестр. Токены остаются в `~/.opencodex/auth.json`;
`/api/oauth/accounts` возвращает только маскированные метаданные.

## 3. Каталог API-ключей

opencodex поставляется с 53 встроенными пресетами: 42 на основе ключей, семь OAuth, три локальных и
пресет ChatGPT-форварда по умолчанию. Селектор **Add provider** в дашборде открывает страницу
выдачи ключей провайдера, проверяет ключ и сохраняет его. Наиболее заметные записи:

| Провайдер | Базовый URL |
| --- | --- |
| **OpenAI (API key)** | `https://api.openai.com/v1` |
| **Anthropic (API key)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Qwen Cloud | Token plan (по умолчанию): `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · Pay as you go: `https://dashscope.aliyuncs.com/compatible-mode/v1` · или Custom |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …и другие | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

Большинство использует адаптер `openai-chat` с bearer-ключом; немногие провайдеры, предоставляющие
только Anthropic-совместимую конечную точку (например, **Xiaomi MiMo**), используют адаптер
`anthropic` (`x-api-key`).

### Несколько API-ключей

Провайдеры на основе ключей тоже могут хранить несколько ключей. Ключ, добавленный через страницу
Providers, сохраняется в `provider.apiKeyPool`, становится активным и дублируется в
`provider.apiKey`, чтобы маршрутизация и адаптеры по-прежнему читали то же поле, что и раньше. В том
же выпадающем списке можно переключать и удалять ключи; API управления — `/api/providers/keys`, он
возвращает только маскированные ключи.

### Переключение аккаунтов из терминала

Используйте `ocx account list`, `ocx account current` и `ocx account use`, чтобы просматривать и
переключать те же пулы Codex, OAuth и API-ключей, не открывая дашборд. Команды, JSON-вывод и
поведение в новых сессиях описаны в разделе
[Справочник CLI](/opencodex/ru/reference/cli/#ocx-account-subcommand).

### Превью-маршруты GPT-5.6

GPT-5.6 Sol/Terra/Luna заранее внесены в резервные списки провайдеров, чтобы `ocx sync` сохранял
модели видимыми, даже когда живые каталоги отстают:

| Маршрут Codex | Предзаданные id моделей | Контекст, видимый Codex |
| --- | --- | --- |
| Вход Codex (Pool или Direct) | `gpt-5.6-*` | 372,000 |
| OpenAI (API key) | `openai-apikey/gpt-5.6-*` плюс `*-pro` | 1,050,000 (макс. вход 922,000) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` | 1,050,000 |
| Cursor | `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, `cursor/gpt-5.6-luna` | 1,000,000 |

Нативные записи GPT-5.6 сохраняют закреплённые вышестоящие шкалы уровней рассуждений (например, у
Luna есть `max`, но нет `ultra`). Маршрутизируемые записи используют метаданные и сопоставления
уровней рассуждений своего провайдера. Доступность всех четырёх маршрутов по-прежнему определяется
вышестоящей стороной; живое обнаружение Cursor дополнительно отфильтровывает статический
предзаданный список до моделей, доступных вошедшему аккаунту.

:::note[Шлюзы и прокси по подписке]
Провайдер попадает в список, когда у opencodex есть подходящий wire-адаптер, а **не** в зависимости
от того, является ли он «агентским» продуктом. Текущие id адаптеров: `openai-chat`,
`openai-responses`, `anthropic`, `google` (режимы AI Studio, Vertex и Antigravity/Cloud Code
Assist), `azure` / `azure-openai`, `kiro` и `cursor`. Проприетарный API без одной из этих
реализаций — например, нативный Amazon Bedrock — напрямую не поддерживается.
**GitHub Copilot** — это OAuth-провайдер (`ocx login github-copilot`), который обменивает вход
через device flow GitHub на короткоживущий API-токен Copilot, а не принимает вставленный API-ключ.
**GitLab Duo** остаётся шлюзом с ключом/токеном подписки на своей OpenAI-совместимой конечной
точке. **Cloudflare AI Gateway** требует подставить в URL id аккаунта и шлюза.

Cursor отслеживается отдельно как экспериментальный адаптер. `adapter: "cursor"` появляется в
`ocx init` и в селекторе Add Provider дашборда как экспериментальная запись локальной конфигурации
с метаданными статического резервного каталога моделей Cursor. Когда настроен токен доступа Cursor,
opencodex использует живой транспорт HTTP/2 Cursor. Его резервный список версии v2.7.1 включает
`gpt-5.6-sol` / `terra` / `luna` (контекст 1M) плюс `grok-4.5` / `grok-4.5-fast` (500K); живое
обнаружение решает, какие из них останутся видимыми для аккаунта. Управляемое сервером Cursor
нативное выполнение read/write/delete/ls/grep/shell/fetch по умолчанию отключено, поскольку оно
обходит путь одобрений и песочницу Codex; устанавливайте `unsafeAllowNativeLocalExec: true` в
объекте `providers.cursor` файла `~/.opencodex/config.json` только для доверенных локальных
экспериментов (или через **Providers → Cursor → Edit JSON** в дашборде). Полный пример см. в
[справочнике по конфигурации](/opencodex/ru/reference/configuration/#cursor-provider-adapter-cursor).
MCP, запись экрана и computer-use доступны как хуки исполнителя; без настроенного локального
исполнителя opencodex возвращает типизированные результаты «нет исполнителя», а не блокирует запрос
политикой. Для этого экспериментального адаптера включены Cursor OAuth и живое обнаружение моделей;
при этом Cursor по-прежнему не показывается в списках входа по ключу.
:::

### Ollama Cloud

Ollama Cloud — это размещённая в облаке (не локальная) Ollama, OpenAI-совместимая по адресу
`https://ollama.com/v1`, с ключом со страницы
[ollama.com/settings/keys](https://ollama.com/settings/keys). opencodex классифицирует её облачную
линейку по поддержке изображений, чтобы [vision-сайдкар](/opencodex/ru/guides/sidecars/) включался
только для текстовых моделей. Текстовые модели (например, `glm-5.2`, `deepseek-v4-pro`, `gpt-oss`,
`qwen3-coder`, `minimax-m2.x`, `nemotron-3-*`) перечислены в `noVisionModels`; модели с нативной
поддержкой изображений (например, `kimi-k2.6`, `minimax-m3`, `gemma4`, `qwen3.5`,
`gemini-3-flash-preview`) — нет. Сопоставление терпимо к тегам Ollama вида `:size`, поэтому
`gpt-oss` покрывает и `gpt-oss:120b`, и `gpt-oss:20b`.

## 4. Локальные провайдеры

Направьте opencodex на локальный OpenAI-совместимый сервер — обычно с пустым ключом:

| Провайдер | Базовый URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## Любая OpenAI-совместимая конечная точка

Если провайдер поддерживает Chat Completions, с ним справится адаптер `openai-chat` — выберите
**Custom** в дашборде или `custom` в `ocx init` и введите базовый URL. Все поля провайдера
(`headers`, `noReasoningModels`, `noVisionModels`, `models`, …) описаны в
[справочнике по конфигурации](/opencodex/ru/reference/configuration/).
