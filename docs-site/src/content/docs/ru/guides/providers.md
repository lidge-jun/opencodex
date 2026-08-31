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
Маршрут API публикует метаданные: контекст 922,000 / максимум входных токенов 922,000. Его
виртуальные id `sol-pro`, `terra-pro` и `luna-pro` сохраняют выбранную публичную идентичность, тогда
как в фактическом запросе используется базовая модель плюс `reasoning.mode: "pro"`.

Если встроенный провайдер `openai` отсутствует или отключён, его можно восстановить из выбора Accounts
на панели и со страницы Codex Auth: отсутствующие записи создаются из канонического пресета, отключённые
канонические записи включаются без замены сохранённого режима и настроек моделей, а неканонические
записи `openai` этот путь восстановления не получают.

### Ёмкость пула в обзоре провайдеров

Для входа Codex в режиме Pool обзор Providers показывает оценку использованной ёмкости всего пула,
а не показатель произвольного аккаунта. В той же строке отображается исходный процент квоты текущего
активного аккаунта, поэтому оценку пула можно отличить от состояния аккаунта, который будет использован
для следующего запроса.

Когда доступны сведения о сбросе, обзор показывает время следующего сброса и ёмкость пула, которая
восстановится в этот момент. **Неполное покрытие** означает, что некоторые аккаунты нельзя безопасно
включить в оценку, например из-за неизвестного плана или квоты, устаревшего показания, приостановки
аккаунта либо необходимости повторной аутентификации.

Предупреждение **о частичном покрытии окон** означает, что некоторые включённые аккаунты сообщили данные
только для части показанных окон квоты. Обзор сохраняет окна раздельными, отмечает каждое затронутое
окно как неполное и не считает отсутствующее значение использованием в этом окне.

Эта оценка предназначена только для отображения. Она не меняет выбор аккаунта, привязку сессии,
автоматическое переключение, cooldown или другие решения маршрутизации. Состояние отдельных аккаунтов
и настройки маршрутизации описаны в разделе
[пула аккаунтов Codex Auth](/ru/guides/web-dashboard/#codex-auth-and-account-pools).

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
| `oauth` | Берёт сохранённый OAuth-токен доступа (автоматически обновляется до истечения срока) и использует его как bearer-ключ. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, Command Code, GitHub Copilot, Nous Portal. |

Повтор при 429 на том же ключе ([`retryOn429`](/ru/reference/configuration/)) применим только к
провайдерам с API-ключом (`authMode: "key"`). Пресеты OAuth, forward и local исключены — их
учётные данные нельзя повторно отправлять по тому же токену, а у локальных сред выполнения нет
удалённого ключа. Это opt-in: при отсутствии опции функция выключена; наличие объекта включает
её, если только `enabled: false`.

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
account id, OpenAI beta/originator/session — см. [Адаптеры](/ru/reference/adapters/)).
Этот же путь обеспечивает работу [сайдкаров веб-поиска и vision](/ru/guides/sidecars/).

Каталог сквозного режима ChatGPT дополнительно включает «голые» слаги GPT-5.6 Sol/Terra/Luna
(`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) для аккаунтов, которым они доступны.

## 2. Вход по аккаунту (OAuth)

Восемь пресетов провайдеров используют вход через OAuth — плюс GitHub Copilot через
экспериментальный неофициальный мост device flow. opencodex хранит их учётные данные в
`~/.opencodex/auth.json` и обновляет их автоматически. CLI входа также принимает `chatgpt`: эта
команда получает учётные данные ChatGPT и одновременно создаёт запись провайдера в режиме `forward`.

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login nous         # Nous Portal (device grant; модели free + paid)
ocx login kiro         # импорт учётных данных kiro-cli (с фолбэком на токен)
ocx login google-antigravity
ocx login cursor       # отдельный PKCE-вход Cursor
ocx login command-code # браузерный OAuth Command Code (или импорт ~/.commandcode/auth.json)
ocx login github-copilot  # device flow GitHub → токен Copilot (Copilot Pro/Business)
ocx login chatgpt      # отдельный OAuth-вход ChatGPT
ocx logout <provider>
```

| Провайдер | Адаптер | Базовый URL | Примечания |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://cli-chat-proxy.grok.com/v1` | OAuth использует отдельный шлюз подписки Grok CLI. Переопределение с API-ключом использует `https://api.x.ai/v1` и может добавлять Priority Processing. Каталог Grok загружается в реальном времени; фолбэк по умолчанию — `grok-4.5`. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Модели Claude; актуальный список моделей загружается из `/v1/models`. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Модели Kimi K2.7/K2.6/K2.5 для кодинга. |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Шлюз подписки Nous Research (тот же бэкенд, что использует Hermes Agent). Вход по device grant против `portal.nousresearch.com`; access-токен — это JWT для каждого запроса к inference. Смешанный каталог платных + `:free` моделей (`tencent/hy3:free`, `stepfun/step-3.7-flash:free`, …) обнаруживается вживую по авторизованному аккаунту. Refresh-токены одноразовые и ротируются при каждом обновлении. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | Первый вход импортирует существующую сессию после установки Kiro CLI (в Unix: `curl -fsSL https://cli.kiro.dev/install` &#124; `bash`; в Windows PowerShell: `irm 'https://cli.kiro.dev/install.ps1'` &#124; `iex`; затем выполните `kiro-cli login`). **Добавить аккаунт** выполняет выход из `kiro-cli`, запускает новый вход через браузер, переключает аккаунт самого `kiro-cli` и сохраняет метаданные профиля отдельно для каждого аккаунта. Существующие аккаунты OpenCodex сохраняются; при отмене или сбое восстанавливается предыдущая сессия `kiro-cli`. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth поверх протокола Cloud Code Assist. Живое обнаружение использует аутентифицированный CCA-эндпоинт `v1internal:fetchAvailableModels` и публикует только agent-модели, доступные текущему аккаунту; поддерживаемый каталог остаётся резервным вариантом. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Экспериментальный PKCE-вход, живой транспорт HTTP/2 и обнаружение моделей с фильтрацией по аккаунту. |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | Экспериментально. Device flow GitHub + обмен `copilot_internal` (OAuth-клиент VS Code). Требуется активная подписка Copilot; это не официальный сторонний API. |

После терминального сбоя обновления Nous выполните `ocx login nous`, чтобы пройти повторную аутентификацию.

Для канонических пресетов Kimi Coding Plan (вход через аккаунт `kimi` и API-ключ `kimi-code`)
opencodex передаёт в запрос Chat Completions только стабильный `prompt_cache_key`, предоставленный
вызывающей стороной, и никогда не создаёт его сам. Документация Kimi требует стабильный ключ
сессии/задачи для повышения доли попаданий в кэш Code Plan; запрос без ключа остаётся без ключа.
Если включённый провайдер отклоняет поле, opencodex не удаляет его для повторной попытки и не
изменяет сохранённую конфигурацию. Для остальных провайдеров действует deny-by-default.

OAuth можно запустить и из [веб-дашборда](/ru/guides/web-dashboard/).

### Несколько OAuth-аккаунтов

OAuth-провайдеры, чьи учётные данные содержат стабильный id аккаунта или email, могут хранить
несколько входов. Страница Providers показывает эти аккаунты в выпадающем списке, позволяет
добавить ещё один и переключает активный аккаунт, не выполняя выход из остальных. При обычном входе
учётные данные Kimi без идентификатора заменяют активный слот; явное действие **Добавить аккаунт**
сохраняет прежний слот и активирует отдельный новый. Аккаунты Kiro сохраняются по ARN профиля.
`chatgpt` всегда занимает один слот, поскольку у пула аккаунтов Codex отдельный реестр. Токены остаются в `~/.opencodex/auth.json`;
`/api/oauth/accounts` возвращает только маскированные метаданные.

### Импорт Cockpit Tools Antigravity

В v1 OpenCodex импортирует только JSON-экспорт **Cockpit Tools Antigravity** для провайдера `google-antigravity`. На вкладке «Аккаунты» этого провайдера в панели Providers выберите локальный JSON-файл. Панель не показывает содержимое файла или значения учётных данных: она выводит только числа импортированных, обновлённых, ошибочных и неподдерживаемых записей. Другие провайдеры Cockpit в v1 не поддерживаются.

CLI принимает экспорт только из файла или stdin — не вставляйте его в аргумент команды:

```bash
ocx account import google-antigravity --format cockpit-tools --file <path> [--json]
cat accounts.json | ocx account import google-antigravity --format cockpit-tools --stdin [--json]
```

Inline JSON и лишние позиционные аргументы отклоняются. Храните экспортированные файлы приватно и удаляйте их или защищайте после импорта.

### Импорт учётных данных Kiro

Для входа Kiro требуется Kiro CLI: в Unix установите его командой `curl -fsSL https://cli.kiro.dev/install | bash`, в Windows PowerShell — `irm 'https://cli.kiro.dev/install.ps1' | iex`, затем сначала выполните `kiro-cli login`. Если сессии `kiro-cli` нет, `ocx login kiro` использует вставленный токен доступа или переменную окружения `KIRO_ACCESS_TOKEN`.

Обычный импорт `ocx login kiro` открывает базу SQLite CLI только для чтения и не изменяет базу, WAL или SHM.

- `KIROCLI_DB_PATH` выбирает нестандартную базу SQLite Kiro CLI; указанная база должна уже существовать.
- `KIROCLI_TOKEN_KEY` выбирает точный ключ строки `auth_kv`, если найдено несколько неоднозначных строк с токенами. Без выбора вход завершается ошибкой, а не пытается угадать строку.

Импортированные учётные данные сохраняются в `~/.opencodex/auth.json`. Откат **Добавить аккаунт** — отдельная операция: при восстановлении предыдущего снимка она заменяет базу и удаляет текущие sidecar-файлы WAL, SHM и journal.

Поскольку откат возможен только при наличии снимка, **Добавить аккаунт** откажется выходить из `kiro-cli`, если хранилище сессии существует, но его нельзя захватить (файл не читается, несовпадение схемы, неоднозначный выбор токена), если `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` направляют импорт не на активное хранилище CLI, или если в основной базе CLI нет распознаваемой строки токена. Исправьте или удалите повреждённую базу по обычному пути данных `kiro-cli`, снимите селекторы только для импорта и повторите попытку. На машины без существующей сессии `kiro-cli` это не влияет.

## 3. Каталог API-ключей

opencodex поставляется с 79 встроенными пресетами: 67 на основе ключей, восемь OAuth, три локальных и
один пресет ChatGPT-форварда по умолчанию. Селектор **Add provider** в дашборде открывает страницу
выдачи ключей провайдера, проверяет ключ и сохраняет его; проверка зависит от провайдера.
Наиболее заметные записи:

**ClinePass** подключается с помощью Cline API key к [официальному каталогу подписки](https://docs.cline.bot/getting-started/clinepass)
и [Chat Completions endpoint](https://docs.cline.bot/api/chat-completions). Оператор — Cline Bot Inc., указанный в
[условиях Cline](https://cline.bot/tos). Маршрут вида `cline-pass/cline-pass/kimi-k3`
намеренный: первая часть выбирает провайдера opencodex, а полный slug `cline-pass/kimi-k3`
отправляется upstream. Использование учитывается в общих для аккаунта скользящем 5-часовом,
недельном и месячном лимитах. Проверка живого API 2026-08-13 подтвердила, что все статические модели ClinePass
принимают на входе шлюза `low`, `medium`, `high`, `xhigh` и `max`. opencodex сохраняет запрошенный tier без изменения;
нормализация для конкретного backend остаётся ответственностью ClinePass.

**Cline** использует тот же ключ и эндпоинт с оплатой по мере использования и доступом к 100+ моделям
(ID в формате OpenRouter, например `anthropic/claude-sonnet-4-6`). Промо-бесплатные модели Cline
доступны только в IDE/CLI Cline, а не через API; `minimax/minimax-m2.5` документирован как
бесплатная модель для экспериментов через API.

| Провайдер | Базовый URL |
| --- | --- |
| **OpenAI (API key)** | `https://api.openai.com/v1` |
| **Anthropic (API key)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Cline** | `https://api.cline.bot/api/v1` |
| **ClinePass** | `https://api.cline.bot/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Chutes | `https://llm.chutes.ai/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` |
| Nscale Serverless Inference | `https://inference.api.nscale.com/v1` |
| Vultr Serverless Inference | `https://api.vultrinference.com/v1` |
| Baseten Model APIs | `https://inference.baseten.co/v1` |
| Command Code | `https://api.commandcode.ai/provider/v1` |
| SambaNova Cloud | `https://api.sambanova.ai/v1` |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` |
| DigitalOcean Serverless Inference | `https://inference.do-ai.run/v1` |
| Scaleway Generative APIs | `https://api.scaleway.ai/v1` |
| Featherless AI | `https://api.featherless.ai/v1` |
| Novita AI | `https://api.novita.ai/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Zhipu AI (BigModel) | `https://open.bigmodel.cn/api/paas/v4` |
| Qwen Cloud | Token plan (по умолчанию): `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · Pay as you go: `https://dashscope.aliyuncs.com/compatible-mode/v1` · или Custom |
| Tencent Cloud Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Volcengine Ark · Coding Plan · Agent Plan | `https://ark.cn-beijing.volces.com/api/v3` · `https://ark.cn-beijing.volces.com/api/coding/v3` · `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Xiaomi MiMo (OpenAI Chat) | `https://api.xiaomimimo.com/v1` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …и другие | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

**OpenCode Zen** (`opencode-zen`) и бесключевой пресет **OpenCode Free** используют один
`https://opencode.ai/zen/v1`. Бесплатные модели на этом шлюзе часто упираются в короткое окно
примерно 15–20 запросов в минуту (оценка сообщества; OpenCode не публикует RPM).
Zen может отвечать общими 429 без заголовков `Retry-After` / `X-RateLimit-*`. Это отдельно от
бесключевой десктопной квоты (~200 запросов Big Pickle/бесплатных моделей за 5 часов на
`opencode-free`). Когда Zen опускает `Retry-After` на таком 429, opencodex добавляет пояснение
в ошибку клиента и синтетический `Retry-After`; при наличии upstream `Retry-After` он имеет
приоритет. Повтор с тем же ключом по-прежнему включается через [`retryOn429`](/ru/reference/configuration/).

Большинство использует адаптер `openai-chat` с bearer-ключом; немногие провайдеры, предоставляющие
только Anthropic-совместимую конечную точку (например, **Xiaomi MiMo**), используют адаптер
`anthropic` (`x-api-key`).
Volcengine Agent Plan использует нативную конечную точку Responses через адаптер `openai-responses`.

> **Три маршрута тарификации Volcengine:** `volcengine` — Ark API с оплатой по факту,
> `volcengine-coding-plan` расходует квоту Coding Plan, а `volcengine-agent-plan` — квоту Agent
> Plan. Используйте ключ и конечную точку одного продукта; обычный `/api/v3` может тарифицироваться
> отдельно даже при активной подписке Plan.
> Все три preset используют отобранные статические каталоги моделей. Ark `/models` возвращает
> текстовые, embedding-, графические, видео- и 3D-ресурсы, а шлюз Coding выдаёт тот же широкий
> каталог. У шлюза Agent Plan ресурса `/models` нет. Для pay-as-you-go модель по умолчанию —
> `doubao-seed-2-1-pro-260628`; его статический каталог также включает актуальные текстовые модели
> DeepSeek и GLM. Для Coding Plan модель по умолчанию — `ark-code-latest`, для Agent Plan —
> `deepseek-v4-pro`.

**Discovery для Chutes.** Пресет `chutes` использует фиксированный общий OpenAI-совместимый LLM
gateway Chutes. Из публичного каталога `/v1/models` он оставляет только строки, где
`supported_features` содержит `tools`, сохраняет нативные id со знаком `/` и безопасные live metadata,
а также ограничивает discovery размером 256 KiB и 128 исходными строками. Публичный каталог не может
подтвердить корректность введённого ключа, но chat-запросы всё равно аутентифицируются настроенным
Bearer-ключом. Пользовательские Chute host и API не для LLM требуют custom provider. Ключ создаётся в
[дашборде Chutes](https://chutes.ai/auth/start).

**Discovery для DeepInfra.** `deepinfra` — провайдер OpenAI Chat Completions с аутентификацией по
ключу; он использует адаптер `openai-chat` и Bearer API-ключ. Принадлежащий registry URL списка
моделей DeepInfra оставляет только строки с тегом `chat`, сохраняет нативные id моделей со знаком
`/` и ограничивает live discovery 512 KiB и 512 исходными строками. Ключи создаются в
[дашборде DeepInfra](https://deepinfra.com/dash/api_keys).

**Discovery для Hyperbolic.** Пресет читает `/v1/models` с настроенным bearer-ключом, сохраняет
нативные id моделей со знаком `/` и ограничивает live discovery размером 256 KiB и 256 исходными
строками. Он охватывает только serverless text и vision-language chat; отдельные image, audio и GPU
endpoint в него не входят. Ключи создаются в [Hyperbolic](https://app.hyperbolic.ai).

**Discovery для Nscale и Vultr.** Оба пресета читают аутентифицированный каталог `/v1/models`,
сохраняют нативные id и ограничивают discovery размером 256 KiB и 256 исходными строками. Каталог
Nscale смешивает chat-, image- и embedding-модели без поля modality, поэтому пресет допускает только
`meta-llama/Llama-3.1-8B-Instruct` — модель из официального примера API с вызовом инструментов.
Vultr сейчас документирует tool calling только для `kimi-k2-instruct`, поэтому его пресет показывает
только эту модель. Остальные строки скрыты до появления равноценного подтверждения agent-tool.
Service token Nscale создаётся в [Nscale Console](https://console.nscale.com), а inference key Vultr
копируется со страницы подписки в [Vultr Console](https://my.vultr.com).

**Discovery для Command Code.** Пресет читает список `/provider/v1/models` с фиксированного
хоста Provider API, сохраняет нативные id моделей со знаком `/` и ограничивает live discovery размером
256 KiB и 256 исходными строками. `ocx login command-code` поддерживает вход через OAuth в браузере
(с возможностью импорта локальных учётных данных CLI из `~/.commandcode/auth.json` для существующих
пользователей CLI Command Code); каталог моделей привязан к учётной записи и берётся из
аутентифицированного discovery endpoint после входа. Запросы чата используют настроенный bearer-ключ.
Ключи создаются в [Command Code Studio](https://commandcode.ai/studio/).

**Квота Command Code.** Дашборд и `ocx account refresh` опрашивают окна `/alpha/billing/credits` (5 часов и неделя) на каноническом хосте `https://api.commandcode.ai`. OAuth-пресет (`command-code`) использует сохранённый bearer аккаунта; пресет Provider-API ключа (`commandcode`) — активный настроенный ключ. Пользовательски изменённый похожий base URL не опрашивается. Если Command Code также сообщает расход за период, оставшиеся monthly / purchased / free credits показываются как USD-окно.

**Discovery для SambaNova Cloud.** Пресет читает общедоступный список SambaNova Cloud `/v1/models` на
фиксированном API-хосте, сохраняет нативные id провайдера и ограничивает discovery размером 128 KiB
и 128 исходными строками. Каталог не требует аутентификации, поэтому процедура входа CLI сообщает, что
ключ невозможно проверить, вместо того чтобы считать публичный ответ подтверждением его действительности.
Chat-запросы по-прежнему используют настроенный Bearer-ключ; параллельные вызовы функций отключены,
поскольку SambaNova пока их не поддерживает. Частные endpoint развёртываний
SambaStudio не входят в область пресета. Ключи создаются в [SambaNova Cloud](https://cloud.sambanova.ai/apis).

**Discovery для Nebius Token Factory.** Пресет запрашивает аутентифицированный verbose-каталог и
оставляет только модели, architecture которых выдаёт текст, исключая embedding и image-generation.
Он сохраняет нативные id со знаком `/`, а также заявленные context и input-modality metadata, и
ограничивает discovery размером 512 KiB и 512 исходными строками. Хосты dedicated deployment не
входят в область пресета. Ключи создаются в [Nebius Token Factory](https://tokenfactory.nebius.com).
**Discovery для DigitalOcean.** Пресет использует model access key на фиксированном общем хосте
Serverless Inference и публикует только пересечение аутентифицированного ответа `/v1/models` с
подтверждённым документацией allowlist для Chat Completions. Неизвестные, Responses-only,
embedding- и media-generation id исключаются по принципу fail closed. Discovery ограничен 256 KiB
и 256 исходными строками; agent-specific и dedicated хосты не входят в область пресета. Ключи
создаются в [DigitalOcean Control Panel](https://cloud.digitalocean.com/model-studio/manage-keys).

**Discovery для Scaleway.** Пресет публикует пересечение аутентифицированного списка моделей с
подтверждённым документацией allowlist Serverless Chat Completions. Неизвестные, Responses-only,
embedding-, transcription- и прочие media-model id исключаются по принципу fail closed; discovery
ограничен 128 KiB и 128 исходными строками. Используется общий endpoint Project по умолчанию; URL с
Project ID и dedicated deployment настраиваются как custom provider. API-ключ создаётся в
[консоли Scaleway](https://console.scaleway.com/generative-api).

**Discovery для Featherless.** Пресет проходит аутентификацию на фиксированном OpenAI-совместимом
хосте и запрашивает только первые 100 популярных моделей, отфильтрованных по chat и текущему plan.
Затем registry по принципу fail closed требует, чтобы каждая строка отдельно подтверждала доступность
по plan, отсутствие Hugging Face gate и `features.tool_use: true`. Discovery ограничен 128 KiB и 100
исходными строками, поэтому каталог из десятков тысяч моделей не загружается и не кэшируется целиком.
`/v1/models` описан как вызываемый как с аутентификацией, так и без неё, поэтому не может подтвердить корректность введённого ключа, но chat-запросы всё равно аутентифицируются настроенным Bearer-ключом.
Индивидуальные plan предназначены для interactive/prototype; произвольные приложения требуют Scale
plan. Ключ создаётся в [дашборде Featherless](https://featherless.ai/account/api-keys).

**Discovery для Novita.** Пресет с ключом использует adapter `openai-chat` и отправляет Bearer key
только на фиксированный OpenAI-совместимый host Novita. Из публичного списка моделей остаются лишь
строки, одновременно указывающие `model_type: chat` и endpoint `chat/completions`; discovery ограничен
512 KiB и 256 исходными строками. Поскольку catalog публичный, login сообщает, что ключ невозможно
проверить, а не считает успешный список доказательством. Возможности зависят от модели, поэтому пресет
не заявляет provider-wide parallel tool calls или OpenAI `reasoning_effort`. Ключ создаётся в
[Novita key manager](https://novita.ai/settings/key-management).

> **Область Baseten:** пресет поддерживает только общие [Model APIs](https://docs.baseten.co/inference/model-apis/overview)
> Baseten. Для локальной работы используйте личный [API-ключ](https://docs.baseten.co/organization/api-keys),
> а для общего/промышленного использования — командный ключ с правом **Call Model APIs**. Выделенные конечные точки Truss `predict` используют другие хосты и
> схемы и этим пресетом не маршрутизируются.
> Для этого пресета live discovery ограничен ответом размером 1 MiB и 256 исходными строками моделей.

### Квота кредитов A6API

Пользовательский провайдер с `openai-chat`, `authMode: "key"` и каноническим адресом
`https://api.a6api.com` или `https://api.a6api.com/v1` показывает расход кредитов A6API в
дашборде и в `ocx account refresh <provider>`. Имя провайдера может быть любым. Единицы токенов
пересчитываются в USD по hard credit limit учётной записи; отображаются процент расхода и остаток. Срок действия токена не считается
сбросом квоты, поскольку он не означает пополнение. Только активный ключ отправляется на
канонический хост, перенаправления отклоняются, а отрицательные или несогласованные итоги биллинга
не создают отчёт.

> **Ограничение Tencent Cloud Coding Plan:** Tencent разрешает использовать эту подписку только
> в интерактивных инструментах программирования. Автоматизация общего API, серверы пользовательских
> приложений и неинтерактивные пакетные вызовы запрещены и могут привести к блокировке ключа плана.

> **Два маршрута GLM:** `zai` — это международная подписка Z.AI на coding-план, а `zhipu-bigmodel` —
> внутренняя китайская конечная точка BigModel с оплатой по факту использования. Разные хосты,
> разные ключи, разная тарификация: ключ от одного сервиса не подойдёт к другому.

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
[Справочник CLI](/ru/reference/cli/#ocx-account-subcommand).

### Превью-маршруты GPT-5.6

GPT-5.6 Sol/Terra/Luna заранее внесены в резервные списки провайдеров, чтобы `ocx sync` сохранял
модели видимыми, даже когда живые каталоги отстают:

| Маршрут Codex | Предзаданные id моделей | Контекст, видимый Codex |
| --- | --- | --- |
| Вход Codex (Pool или Direct) | `gpt-5.6-*` | 922,000 |
| OpenAI (API key) | `openai-apikey/gpt-5.6-*` плюс `*-pro` | 922,000 (макс. вход 922,000) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` | 922,000 |
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

Copilot предоставляет каталог со смешанными проводами: его семейство GPT-5 (`gpt-5.3-codex`,
`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`)
отклоняет `/chat/completions` для агентного трафика, поэтому opencodex по умолчанию
маршрутизирует эти модели через Responses API, а все остальные модели Copilot остаются на
chat completions. Приоритет: жёсткий wire-пин → явная запись
[`modelAdapters`](/ru/reference/configuration/providers/) → дефолт реестра → adapter всего
провайдера. Чтобы перевести модель без встроенного дефолта (например, `gpt-5.4-nano`) на
Responses, задайте `"modelAdapters": { "gpt-5.4-nano": "openai-responses" }`.

Cursor отслеживается отдельно как экспериментальный адаптер. `adapter: "cursor"` появляется в
`ocx init` и в селекторе Add Provider дашборда как экспериментальная запись локальной конфигурации
с метаданными статического резервного каталога моделей Cursor. Когда настроен токен доступа Cursor,
opencodex использует живой транспорт HTTP/2 Cursor. Его встроенный резервный список включает
`gpt-5.6-sol` / `terra` / `luna` (контекст 1M), обычные/Fast-строки Grok 4.5 и 4.6 (500K) и
`kimi-k3` (262K); живое обнаружение решает, какие из них останутся видимыми для аккаунта. Для
Grok 4.6 в обеих формах доступны `low` / `medium` / `high` / `xhigh`, а для 4.5 — только до `high`.
Fast-запросы передают соответствующую базовую модель Grok с отдельными параметрами `effort` и
`fast=true` в `requested_model`; плоские id `cursor-grok-{version}-{effort}-fast` служат только
идентификаторами discovery и picker. Cursor отдаёт
Kimi K3 только через wire id с суффиксом усилия, поэтому `cursor/kimi-k3` предоставляет лестницу
`low` / `high` / `max` и по умолчанию использует `max` — как и задокументированное значение по
умолчанию в API модели. Управляемое сервером Cursor
нативное выполнение read/write/delete/ls/grep/shell/fetch по умолчанию отключено, поскольку оно
обходит путь одобрений и песочницу Codex; устанавливайте `unsafeAllowNativeLocalExec: true` в
объекте `providers.cursor` файла `~/.opencodex/config.json` только для доверенных локальных
экспериментов (или через **Providers → Cursor → Edit JSON** в дашборде). Полный пример см. в
[справочнике по конфигурации](/ru/reference/configuration/#cursor-provider-adapter-cursor).
MCP, запись экрана и computer-use доступны как хуки исполнителя; без настроенного локального
исполнителя opencodex возвращает типизированные результаты «нет исполнителя», а не блокирует запрос
политикой. Для этого экспериментального адаптера включены Cursor OAuth и живое обнаружение моделей;
при этом Cursor по-прежнему не показывается в списках входа по ключу.
:::

### Ollama Cloud

Ollama Cloud — это размещённая в облаке (не локальная) Ollama. Укажите адрес
`https://ollama.com/v1` и ключ со страницы
[ollama.com/settings/keys](https://ollama.com/settings/keys). opencodex обращается к ней через
собственный REST API Ollama (`POST /api/chat`), а не через OpenAI-совместимую поверхность, и
получает список моделей от провайдера, поэтому новые модели Ollama Cloud появляются без
изменения конфигурации. opencodex классифицирует её облачную
линейку по поддержке изображений, чтобы [vision-сайдкар](/ru/guides/sidecars/) включался
только для текстовых моделей. Текстовые модели (например, `glm-5.2`, `deepseek-v4-pro`, `gpt-oss`,
`qwen3-coder`, `minimax-m2.x`, `nemotron-3-*`) перечислены в `noVisionModels`; модели с нативной
поддержкой изображений (например, `kimi-k2.6`, `minimax-m3`, `gemma4`, `qwen3.5`,
`gemini-3-flash-preview`) — нет. Сопоставление терпимо к тегам Ollama вида `:size`, поэтому
`gpt-oss` покрывает и `gpt-oss:120b`, и `gpt-oss:20b`.

Ollama в документации указывает, что структурированный вывод сейчас не поддерживается на Ollama
Cloud. Поэтому для канонического `ollama-cloud` opencodex отклоняет такие запросы
(`text.format`) явной ошибкой, а не молча возвращает свободную прозу; локальные и пользовательские
`ollama-native` конечные точки сохраняют нативное поведение `format` Ollama.

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
[справочнике по конфигурации](/ru/reference/configuration/).
