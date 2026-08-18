---
title: Architecture
description: Composants internes d’opencodex — carte des modules, pont AdapterEvent, analyseur de requêtes et mise en cache.
---

opencodex s’exécute dans un seul processus Bun. Une requête arrive au format OpenAI Responses, est normalisée dans un modèle interne, routée, envoyée au fournisseur par un adaptateur, puis reconvertie en flux SSE Responses. Consultez [Fonctionnement](/fr/getting-started/how-it-works/) pour suivre le flux de bout en bout.

## Carte des modules

```text
src/
├── cli/                # ocx command dispatch, init, status, provider commands
├── server/             # Bun.serve, /v1/* proxy, /api/* management API, WS bridge
├── codex/              # Codex config injection, catalog sync, auth/account integration
├── providers/          # provider metadata, API-key pool, quota and labels
├── adapters/           # seven wire adapters, shared guards/utilities, Cursor protobuf transport
├── oauth/              # OAuth providers, API-key catalog, token store/refresh
├── usage/              # request usage extraction, JSONL logs, summaries, totals
├── lib/                # runtime, process, retry, privacy, token estimate helpers
├── web-search/         # service auxiliaire de recherche web (outil synthétique, boucle, exécuteur, analyseur)
├── vision/             # service auxiliaire de vision (description et planification)
├── config.ts           # ~/.opencodex/config.json, defaults, PID, env resolution
├── router.ts           # model id → provider + adapter
├── bridge.ts           # AdapterEvent stream → Responses SSE / JSON
├── reasoning-effort.ts # reasoning-effort translation, clamping, and catalog levels
├── responses/
│   ├── parser.ts       # Responses request → OcxParsedRequest
│   ├── schema.ts       # Zod validation
│   └── compaction.ts   # remote compaction prompts, envelopes, compact history
├── service.ts          # launchd / systemd / Task Scheduler background service
├── types.ts            # core interfaces + helpers (modelInList, namespacedToolName)
└── index.ts            # public entry
```

Trois anciens points d’entrée volumineux préservent désormais la compatibilité sous forme de façades : `codex/catalog.ts` exporte les sept modules spécialisés `codex/catalog/*.ts`, `server/management-api.ts` répartit les requêtes entre les neuf modules `server/management/*.ts`, et `server/responses.ts` exporte les cinq modules `server/responses/*.ts`.

## Flux d’une requête

`server/index.ts` gère la frontière HTTP et délègue le plan de données Responses à la façade `server/responses.ts` et à ses modules `server/responses/*.ts` :

1. `server/index.ts` applique CORS et l’authentification d’API, refuse les nouvelles tâches pendant le drainage et enregistre les métadonnées du cycle de vie de la requête. Il sert `GET /v1/models`, `POST /v1/responses`, `POST /v1/responses/compact`, `POST /v1/images/generations` / `POST /v1/images/edits` (relayés vers une famille OpenAI en amont par `server/images.ts` pour l’outil `image_gen` intégré à Codex), `POST /v1/live` / `POST /v1/realtime/calls` (création des appels vocaux ChatGPT / Codex App et OpenAI Realtime, relayée par `server/live.ts`), les connexions WebSocket sideband sur `/v1/live/{callId}` (et `/v1/realtime?call_id=`), ainsi que la mise à niveau WebSocket facultative sur `/v1/responses`.
2. `server/responses/core.ts` décompresse et analyse le JSON, développe les entrées de mémoire locale `previous_response_id` lorsqu’elles sont disponibles, puis appelle `responses/parser.ts`.
3. `router.ts` résout un identifiant simple ou `provider/model`. Le serveur détermine ensuite l’affinité du compte Codex, actualise l’authentification OAuth du fournisseur si nécessaire et applique à la route les identifiants sélectionnés.
4. Avant l’appel principal, `vision/` décrit les images pour les modèles figurant dans `noVisionModels`. En l’absence de service auxiliaire sûr, les images sont supprimées plutôt qu’envoyées à un service en amont purement textuel.
5. `server/adapter-resolve.ts` applique toute substitution de protocole propre au modèle et construit l’un des sept adaptateurs. L’adaptateur Responses relaie le corps natif, Cursor exécute son transport bidirectionnel `runTurn`, et les adaptateurs traduits construisent, envoient et analysent une requête en amont.
6. Pour les modèles routés avec un outil hébergé `web_search`, `web-search/` expose une fonction synthétique, exécute la recherche réelle avec le backend configuré — le service auxiliaire OpenAI/ChatGPT ou le backend Anthropic —, renvoie les résultats au modèle routé et recommence dans la limite de boucle configurée. Cette boucle ne prend en charge que le chemin HTTP classique ; les adaptateurs qui implémentent `runTurn`, comme Cursor, la contournent et poursuivent leur propre transport.
7. `bridge.ts` produit un flux SSE Responses ou une réponse JSON. `server/request-log.ts` et `usage/` recueillent de manière bornée l’état, la latence, les libellés de fournisseur/modèle et l’utilisation estimée des jetons, sans modifier la réponse.

## Analyseur

`responses/parser.ts` valide la requête entrante avec `responses/schema.ts` (Zod), puis construit un `OcxParsedRequest` :

- **Messages** — les éléments `input` deviennent un tableau normalisé `OcxMessage[]` : utilisateur / développeur / assistant / résultat d’outil. Les éléments `reasoning` deviennent des blocs de réflexion ; les éléments `function_call`, `custom_tool_call` et `tool_search_call` deviennent des appels d’outils ; les éléments `*_output` correspondants deviennent des résultats d’outils.
- **Outils** — les outils de fonction sont transmis tels quels ; **les outils avec espace de noms (MCP) sont aplatis** sous la forme `namespace__name` (puis restaurés au retour) ; les outils **libres** (par exemple `apply_patch`) et les outils de découverte **tool_search** sont signalés ; les **outils hébergés** (`web_search`, génération d’images, etc.) sont retirés et réinjectés par un service auxiliaire uniquement si celui-ci peut les traiter.
- **Images** — elles sont conservées comme de véritables parties de contenu (URL de données ou URL https distante), jamais intégrées sous forme de texte.
- **Indicateurs de fonctionnalité** — `_webSearch` (recherche Web hébergée demandée), `_structuredOutput` (`text.format` est json_schema/json_object) et `_compactionRequest` (compactage distant v2).

## Pont

`bridge.ts` transforme le flux interne `AdapterEvent` de l’adaptateur en événements SSE Responses compris par Codex :

| AdapterEvent | Événements SSE Responses émis |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`, `response.content_part.done`, `response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`, fermeture de l’élément |
| `reasoning_raw_delta` | Élément `reasoning_text` brut (ou enveloppe aller-retour masquée) |
| `thinking_signature` / `redacted_thinking` | Conservé dans une enveloppe de raisonnement `encrypted_content` |
| `tool_call_start` | `response.output_item.added` (type : `function_call` / `custom_tool_call` / `tool_search_call`) |
| `tool_call_delta` | `response.function_call_arguments.delta` (ignoré pour les outils libres / tool_search) |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `web_search_call_begin` / `web_search_call_end` | Élément actif `web_search_call` accompagné de citations d’URL |
| `heartbeat` | Signale une activité en amont ; aucun élément de sortie visible par l’utilisateur |
| `done` | `response.completed` (avec l’utilisation) |
| `error` | `response.failed` (avec `last_error`) |

Le pont émet également un **signal de maintien en vie** (RC3) : lorsque le service en amont reste silencieux, il envoie toutes les 2 secondes une ligne de commentaire SSE (`: opencodex heartbeat`), ignorée par l’analyseur, afin de réarmer la minuterie d’inactivité de Codex. Une ligne de commentaire est ignorée par tous les analyseurs eventsource sans produire d’événement, donc les décodeurs Responses stricts ne voient jamais de variante inconnue. Le **délai maximal de blocage** est de 300 secondes par défaut (`stallTimeoutSec`). Une fois ce délai atteint, le service en amont est interrompu et `response.incomplete` est émis avec le motif `upstream_stall_timeout`, ce qui empêche une connexion bloquée d’immobiliser Codex indéfiniment.

Les appels d’outils sont répartis entre trois types d’éléments Responses à l’aide de la table des espaces de noms, de l’ensemble des outils libres et de l’ensemble des outils de recherche capturés par l’analyseur. Les espaces de noms MCP, les outils libres tels que `apply_patch` et les appels `tool_search` exécutés par le client peuvent ainsi effectuer un aller-retour complet. Une variante `buildResponseJSON()` produit à partir des mêmes événements un objet de réponse unique hors flux.

## API de gestion, OAuth et utilisation

`server/management-api.ts` alimente le tableau de bord et répartit les requêtes entre des groupes de routes spécialisés dans `server/management/*.ts`. Ses routes `/api/*` couvrent la configuration et les paramètres sûrs, les opérations CRUD sur les fournisseurs et les groupes de clés, la sélection des modèles, les limites de contexte et les contrôles v2, la synchronisation du catalogue, les diagnostics et journaux de débogage, l’utilisation et les quotas, les paramètres des services auxiliaires, les mises à jour, les clés d’API clientes générées, la connexion/l’état/la déconnexion OAuth et la sélection du compte, la gestion des comptes Codex et l’arrêt progressif. Pour une liaison hors bouclage, `server/auth-cors.ts` protège le plan de données `/v1/*` avec `OPENCODEX_API_AUTH_TOKEN` ou une entrée `apiKeys` configurée. Les routes de gestion `/api/*` emploient un identifiant administrateur distinct, décrit dans la [référence de l’API de gestion](/fr/reference/management-api/), qui doit différer des identifiants du plan de données. Les entrées `corsAllowOrigins` configurées étendent la liste locale des origines autorisées.

Les implémentations OAuth se trouvent dans `oauth/`. Les jetons d’accès sont chargés ou actualisés immédiatement avant un appel routé, tandis que `oauth/token-guardian.ts` ne peut les actualiser de manière proactive que pour les fournisseurs dont la politique l’autorise. L’actualisation est coordonnée par une opération unique en cours de processus, un verrou de fichier par compte et un CAS de génération, afin que des écritures concurrentes ne puissent pas écraser un identifiant plus récent. Une projection partagée de l’état de santé (`oauth/health.ts`) alimente `ocx status`, `ocx doctor`, l’API de gestion et le tableau de bord. Les identifiants des pools Codex/ChatGPT et l’affinité des fils propre au processus se trouvent dans `codex/` et ne figurent pas dans les réponses de gestion. L’affinité est supprimée en cas de `401` / `403` / `429` (elle n’est pas conservée au-delà des limites de débit) et ne persiste pas après un redémarrage. L’utilisation des requêtes est normalisée en `OcxUsage`, exposée dans les événements terminaux Responses et agrégée par `usage/` pour le tableau de bord et les diagnostics JSONL facultatifs.

## Transport et compactage

Par défaut, `server/index.ts` sert HTTP/SSE sur `/v1/responses`. Si Codex tente une mise à niveau WebSocket de Responses alors que `websockets` vaut `false`, opencodex renvoie `426 upgrade_required` ; Codex revient alors à HTTP pour cette session. Lorsque `"websockets": true` est défini, le même point de terminaison accepte la mise à niveau et utilise le pont WebSocket.

Indépendamment de ce réglage côté client, les requêtes canoniques transmises à ChatGPT avec `stream: true` à la racine peuvent utiliser le transport WebSocket en amont de Codex avec une version stable de Bun 1.4.0 ou ultérieure. La version intégrée Bun 1.3.14, les préversions et les identités de runtime impossibles à vérifier utilisent HTTP/SSE. Les réponses WS en amont qui réussissent conservent le contrat SSE en aval et contournent `tee()` au moyen d’un relais borné à lecteur unique et avide (4 MiB par trame brute/enveloppée et une file de production de 8 MiB). Le dépassement de la file ferme la connexion en amont et émet en aval un événement terminal `response.failed`, suivi de `[DONE]`.

Le compactage du contexte Codex fonctionne avec les modèles routés. `server/responses/compact.ts` traite `POST /v1/responses/compact` en exécutant un tour interne de synthèse routé et en renvoyant un historique compacté, tandis que `responses/parser.ts` et `bridge.ts` traitent les tours de compactage distant v2 `compaction_trigger` en émettant exactement un élément de sortie synthétique `compaction`.

## Mise en cache et catalogue

- `codex/model-cache.ts` conserve en mémoire, par fournisseur, un cache TTL des résultats actifs de `/models` (5 min par défaut, comme le propre cache de Codex), avec repli sur une version périmée en cas d’échec de récupération.
- `codex/catalog/sync.ts`, exporté par la façade `codex/catalog.ts`, fusionne les modèles routés dans le catalogue de Codex sous forme d’entrées avec espace de noms, place en premier les [modèles de sous-agents](/fr/guides/codex-integration/#le-sélecteur-de-sous-agents) mis en avant, filtre `disabledModels` et peut restaurer intégralement le catalogue d’origine à partir d’une sauvegarde créée une seule fois.

## Effort de raisonnement

`reasoning-effort.ts` traduit les libellés de raisonnement de Codex dans les valeurs de protocole propres à chaque fournisseur. Le catalogue Codex annonce les libellés acceptés par Codex (`low` / `medium` / `high` / `xhigh` / `max` / `ultra`), mais les fournisseurs en amont peuvent ne prendre en charge qu’un sous-ensemble plus restreint ou exiger un véritable alias. Le module :

- définit les `CODEX_REASONING_LEVELS` canoniques et leur ordre de tri ;
- ramène un effort demandé au niveau pris en charge le plus proche lorsque le niveau exact n’est pas disponible ;
- résout les substitutions `reasoningEffortMap` par modèle et par fournisseur pour les correspondances de protocole personnalisées ;
- omet entièrement l’effort pour les modèles répertoriés dans `noReasoningModels`.

Qwen3.8-Max constitue une exception explicite d’effort direct par rapport à l’ancien contrat de budget Qwen3.x. Alibaba Token Plan enregistre les niveaux pris en charge en amont `low`, `medium` et `xhigh` (valeur par défaut), puis envoie la valeur effective dans `reasoning_effort`. Les niveaux de compatibilité propres à Codex qui les dépassent sont limités à `xhigh` sur le protocole. L’enrichissement du registre à l’exécution corrige les anciennes métadonnées de préréglage persistantes qui classent encore ce modèle comme un modèle `thinking_budget`.

## Types fondamentaux

Le modèle interne se trouve dans `types.ts` : `OcxParsedRequest`, `OcxContext`, l’union `OcxMessage`, `OcxContentPart` (texte / image), `OcxToolCall`, `OcxTool`, `AdapterEvent` et les types de configuration (`OcxConfig`, `OcxProviderConfig`). Deux fonctions utilitaires sont largement utilisées : `namespacedToolName()` et `modelInList()` (correspondance tolérante des suffixes `:size` pour `noVisionModels` / `noReasoningModels`).
