---
title: Adaptateurs
description: Les sept adaptateurs de fournisseurs — leurs cibles, la construction des requêtes et leurs particularités.
---

Un **adaptateur** traduit les échanges entre le modèle interne de requête/réponse d’opencodex et le protocole d’un fournisseur. Chaque adaptateur implémente l’interface `ProviderAdapter` (`src/adapters/base.ts`) :

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): AdapterRequest | Promise<AdapterRequest>;
  fetchResponse?(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response>;
  parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]>;
  runTurn?(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void): Promise<void>;
}
```

`buildRequest` transforme un `OcxParsedRequest` en requête HTTP en amont ; `parseStream` / `parseResponse` reconvertissent la réponse du fournisseur en événements `AdapterEvent` internes. `fetchResponse` permet à l’adaptateur de gérer lui-même les nouvelles tentatives et les délais d’expiration, tandis que `runTurn` prend en charge les transports qui ne peuvent pas être représentés par une seule requête HTTP suivie d’un flux de réponse. [`bridge.ts`](/fr/reference/architecture/#pont) transforme ensuite ces événements en flux SSE Responses.

`incoming` est un `IncomingMeta` obligatoire qui transporte notamment les en-têtes, le signal d’abandon et le budget de traduction. Le contexte facultatif de `fetchResponse` est un `AdapterFetchContext`. Les méthodes d’analyse reçoivent elles aussi un `TranslatorBudget` obligatoire afin de borner les données traduites.

## `openai-chat`

**Cibles :** l’API **Chat Completions** d’OpenAI (`POST {baseUrl}/chat/completions` ; un suffixe `/chat/completions` ou `/` est d’abord retiré de `baseUrl`) et tous les fournisseurs compatibles — xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama (local et cloud), entre autres.
**Authentification :** `key` (Bearer).

- Convertit les messages internes en rôles OpenAI ; mappe les outils vers `{type:"function", function:{…}}` et `tool_choice` (`auto`/`none`/`required` ou une fonction nommée).
- **Images renvoyées par un outil :** elles sont placées dans un message utilisateur de vision ultérieur (parties `image_url`), émis à la fin du tour d’outil, car le contenu du rôle `role:"tool"` ne peut être que textuel. Le marqueur `[image]` reste dans le message d’outil comme point d’ancrage.
- **Réécrit le prompt d’identité GPT-5 de Codex** sous une forme indépendante du modèle afin que les modèles routés ne prétendent pas être OpenAI.
- **Limite `reasoning_effort`** au sous-ensemble annoncé par le modèle lorsque le niveau exact n’est pas disponible ; `xhigh` et `max` restent des libellés distincts, sauf si un fournisseur configure explicitement un alias. L’adaptateur **omet entièrement ce champ** pour les identifiants figurant dans `provider.noReasoningModels`.
- Diffuse `delta.content` (texte), `delta.reasoning_content` (raisonnement) et `delta.tool_calls[]`, et recueille `usage`.
- ClinePass utilise le format de passerelle vérifié en conditions réelles `reasoning: { enabled: true, effort: "low" }` (ou `{ enabled: false }` lorsque le raisonnement est désactivé). Sa documentation publique d’API ne précise pas encore cette forme de requête. L’adaptateur limite les autres niveaux demandés au niveau `low` vérifié, accepte les deltas de raisonnement provenant de `delta.reasoning_content` ou de `delta.reasoning`, demande les données d’utilisation en flux avec `stream_options.include_usage` et lit ces données dans les enveloppes de réponse hors flux.

## `openai-responses`

**Cibles :** l’API **Responses** d’OpenAI. **`passthrough: true`** — transmet tel quel le corps brut de la requête et renvoie le flux de réponse **sans traduction**.
**Authentification :** `forward` (transmission des en-têtes de l’appelant) ou `key`.

Avec l’authentification `key`, [`retryOn429`](/fr/reference/configuration/) s’applique également : en cas de réponse 429 avant le début du flux, l’adaptateur attend puis rejoue à l’identique la requête avec la même clé avant tout autre traitement, exactement comme sur les chemins traduits `openai-chat` / Anthropic. Les transports `runTurn` personnalisés ne font pas partie de cette boucle de nouvelles tentatives HTTP.

- L’analyseur Responses sans état de DeepSeek reçoit une normalisation de l’historique propre au fournisseur : le contexte injecté par un hook est déplacé après un lot non ambigu d’appels d’outils et de résultats. Les appels parallèles restent regroupés avant les sorties correspondantes, de sorte que chaque appel demeure dans le tour assistant qui porte le raisonnement. Pour les fournisseurs tolérants, ainsi que lorsque des identifiants d’appel sont dupliqués, manquants, ambigus ou désordonnés, l’ordre d’entrée d’origine est conservé.
- URL en mode `forward` → `{baseUrl}/responses`. Un fournisseur `key` utilise par défaut l’ancienne construction `{baseUrl}/v1/responses`.
- Un fournisseur `key` peut définir un chemin relatif validé dans `responsesPath` ; l’adaptateur retire une barre oblique finale de `baseUrl` et envoie la requête vers `{trimmedBaseUrl}{responsesPath}`. Pour Ark Agent Plan, utilisez `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` avec `responsesPath: "/responses"`.
- En mode `forward`, seule une liste sûre d’en-têtes autorisés (`FORWARD_HEADERS`) est transmise : l’autorisation, l’identifiant de compte ChatGPT et les en-têtes OpenAI beta/originator/session. C’est le chemin de connexion ChatGPT également utilisé par les [services auxiliaires](/fr/guides/sidecars/).

## `anthropic`

**Cibles :** l’API **Messages** d’Anthropic (`/v1/messages`).
**Authentification :** `key` (`x-api-key` par défaut, ou `Authorization: Bearer` avec `apiKeyTransport: "bearer"`) ou `oauth` (Bearer + `anthropic-beta`, pour Claude Pro/Max).

- Convertit les messages en blocs de contenu Anthropic (texte, image base64, `tool_use`, `thinking`).
- **Calcul du raisonnement étendu :** Anthropic exige `max_tokens > thinking.budget_tokens`. L’adaptateur associe l’effort de raisonnement à un budget (minimal 1024 … max 32000), calcule ensuite une valeur sûre de `max_tokens` avec une marge pour la sortie et **supprime `temperature`/`top_p`** lorsque le raisonnement est activé, car Anthropic les interdit dans ce cas.
- **Sortie structurée :** les requêtes Responses `text.format` et Chat Completions `response_format` dont le type est `type: "json_schema"` deviennent `output_config.format` dans Anthropic. Le format est fusionné avec une configuration de sortie de raisonnement adaptatif existante, tout en préservant un `output_config.effort` compatible. Les requêtes Anthropic Messages routées conservent ce même format lors de la traduction OAuth stockée. L’adaptateur reproduit le sous-ensemble de JSON Schema pris en charge par le SDK TypeScript d’Anthropic : les contraintes non prises en charge sont déplacées dans `description` à titre d’instructions pour le modèle, `oneOf` devient `anyOf` et les schémas d’objet reçoivent `additionalProperties: false`. Une racine `$ref` conserve le `$defs` adjacent afin que la référence locale reste résoluble. Les champs d’enveloppe OpenAI tels que le `name` du schéma, la `description` de l’enveloppe et `strict` ne font pas partie du protocole Anthropic. Le mode objet JSON sans schéma n’a pas d’équivalent Anthropic et n’est pas traduit.
- Envoie toujours `anthropic-version: 2023-06-01`. Diffuse `content_block_delta` (`text_delta`, `thinking_delta`, le compatible `reasoning_delta`, `input_json_delta`). Le décodeur SSE conserve l’état des événements d’un fragment reçu à l’autre et accepte un événement terminal `message_stop` sans saut de ligne final.
- Pour les tours Responses routés vers Anthropic avec des outils clients, une garde terminale bornée détecte le cas hautement probable où l’utilisateur a demandé une action, mais où Claude termine en affirmant l’avoir exécutée sans appeler d’outil. Elle effectue au plus une continuation interne ; les réponses normales, les demandes de précision, les tours qui utilisent un outil et les réponses incomplètes au niveau du transport ne sont pas relancés automatiquement.

## `google`

**Cibles :** **Gemini** de Google, **Vertex AI** et **Cloud Code Assist** d’Antigravity. AI Studio utilise `/v1beta/models/{model}:streamGenerateContent` ; les autres modes utilisent leurs points de terminaison Google natifs.
**Authentification :** clé d’API, ADC Vertex ou OAuth Google Antigravity, selon `googleMode`.

- Prompt système → `systemInstruction` ; messages → `contents[]` (assistant → `model`) ; outils → `functionDeclarations`. Images sous forme d’URL de données → `inline_data`.
- Les identifiants d’appel d’outil sont générés lorsque Gemini les omet. Vertex et Antigravity conservent et rejouent les valeurs opaques `thoughtSignature` afin que les continuations après résultat d’outil préservent la continuité du raisonnement Gemini. Le cache des signatures est enregistré dans le répertoire de configuration ; les continuations survivent donc également aux redémarrages du proxy.
- **Sortie d’image intégrée :** lorsque le modèle correspond à l’un des identifiants de chat explicitement capables de produire des images (`gemini-3.1-flash-image`, `gemini-2.0-flash-preview-image-generation` ou `gemini-3-pro-image-preview`), l’adaptateur envoie `responseModalities: ["TEXT", "IMAGE"]`. Les identifiants dédiés à la génération de médias, tels que `gemini-3-pro-image`, ne sont pas inclus. Les parties `inlineData` renvoyées sont matérialisées dans le répertoire `artifacts/` d’OpenCodex configuré et exposées sous forme de liens d’image Markdown vers la route opaque authentifiée `/v1/opencodex/artifacts/<id>` (et non sous forme d’URI `file:` ou de chemins du système de fichiers hôte). Chaque image est limitée à 50 MB et chaque réponse à 100 MB de données décodées ; les charges utiles base64 mal formées sont rejetées. Les artefacts sont automatiquement élagués lorsque leur nombre dépasse 200 fichiers.

## `kiro`

**Cibles :** le service Amazon CodeWhisperer Streaming `GenerateAssistantResponse` utilisé par Kiro (`https://runtime.{region}.kiro.dev/`).
**Authentification :** jeton d’accès OAuth Kiro en Bearer, accompagné des métadonnées region/profile issues de l’identifiant Kiro.

- Construit le `conversationState` de Kiro, mappe les outils Codex et leurs résultats, puis envoie les blocs d’image pris en charge par le protocole Kiro.
- Décode `application/vnd.amazon.eventstream`, reconstruit les événements de texte, de raisonnement et d’outil, détecte les données JSON d’outil tronquées et estime l’utilisation, car le service en amont ne renvoie aucun nombre de jetons.
- Utilise à l’identique le `baseUrl` configuré lorsqu’il est personnalisé. Une URL canonique `runtime.{region}.kiro.dev` suit la région d’API de l’identifiant importé ; seule cette forme canonique peut faire l’objet d’un unique repli borné vers `q.{region}.amazonaws.com` après un échec de point de terminaison, de signature, de DNS ou de connexion.
- Gère la récupération après réinitialisation de connexion lorsqu’un rejeu est sûr, cet unique repli de point de terminaison admissible, une actualisation OAuth suivie d’un rejeu après une réponse HTTP 401, ainsi qu’une récupération bornée pour les réponses Kiro 429 transitoires. Un délai de récupération partagé et une seule sonde après ce délai empêchent les requêtes concurrentes d’épuiser des budgets de nouvelle tentative indépendants ; les dépassements fermes de quota et les erreurs de service ordinaires ne sont pas rejoués.
- Son analyseur hors flux consomme le même flux d’événements pour la boucle de recherche Web.

### Sémantique d’achèvement

Le texte de l’assistant Kiro ne comporte pas, à lui seul, de phase fiable indiquant la fin du tour. Son événement terminal `metadataEvent` peut contenir un `stopReason` natif, mais Kiro peut étiqueter comme `END_TURN` un texte qui ne décrit que la progression. Lors des tours avec outils, `END_TURN` et `STOP_SEQUENCE` prouvent donc uniquement que l’inférence s’est arrêtée ; le texte ordinaire reste un commentaire et passe par l’unique validation d’achèvement bornée.

`END_TURN`, `STOP_SEQUENCE` ou l’absence de motif d’arrêt peuvent emprunter le chemin de compatibilité. Les autres motifs explicites ont déjà interrompu l’inférence en amont ; l’adaptateur les signale donc au lieu de consommer une nouvelle requête au modèle. Une limite de jetons de sortie est présentée comme une sortie incomplète que le client peut poursuivre, tandis qu’un épuisement de la fenêtre de contexte devient une erreur de longueur de contexte non renouvelable plutôt qu’une sortie tronquée. Les arrêts dus au filtrage et aux garde-fous sont présentés comme des sorties filtrées incomplètes. Un arrêt `TOOL_USE` sans appel d’outil réel est signalé comme une contradiction, et non comme une progression.

Lorsqu’un outil client ordinaire est disponible, opencodex ajoute un outil privé `codex_kiro_final_answer` à la requête en amont. Le texte de progression est diffusé comme commentaire et ne peut pas clore le tour. L’adaptateur consomme l’appel privé, émet sa réponse comme texte final et n’expose jamais cet outil privé à Codex ou Claude Code. Le motif d’arrêt n’arrivant qu’à la fin du flux, le texte de l’assistant est retenu pendant un tour avec outils jusqu’au début d’un véritable appel d’outil ou jusqu’à la fin du flux. Il est alors libéré comme commentaire, sauf si l’outil privé a fourni la réponse finale. Lorsque le service auxiliaire de recherche Web est actif, les commentaires libérés continuent d’être diffusés avant l’événement terminal ; seuls les événements nécessaires pour déterminer si le modèle a demandé une recherche synthétique restent en mémoire tampon.

Si Kiro s’arrête sans appeler l’outil d’achèvement, l’adaptateur effectue une continuation. Les nouvelles tentatives ne contenant que du raisonnement conservent le tour utilisateur/résultat d’outil valide d’origine au lieu de fabriquer un message assistant vide ; la progression visible est rejouée avec une instruction non vide appartenant à l’adaptateur. Avant le transport, la conversation générée est contrôlée afin de vérifier l’alternance des rôles, l’absence de tours structurels vides et la correspondance des identifiants d’utilisation et de résultat d’outil. Une sortie d’outil vide reçoit un texte de remplacement neutre et non vide. La nouvelle tentative ne peut pas se répéter récursivement : si elle est vide ou ne contient que du raisonnement, elle est renvoyée comme incomplète mais renouvelable ; un véritable appel d’outil client maintient le tour ouvert. Une réponse de l’outil d’achèvement est toujours émise comme `final_answer`, même si elle répète exactement un commentaire antérieur, car l’exactitude de la phase prime sur la déduplication esthétique. Les requêtes sans outil conservent le comportement normal d’achèvement textuel.

### Effort de raisonnement

`gpt-5.6-sol` et `claude-opus-5` prennent en charge nativement un niveau d’effort vérifié, mais chaque famille de modèles nomme différemment le champ de la requête. La valeur sélectionnée `low`, `medium`, `high`, `xhigh` ou `max` est envoyée dans `additionalModelRequestFields.reasoning.effort` pour `gpt-5.6-sol`, et dans `additionalModelRequestFields.output_config.effort` pour `claude-opus-5`. Les autres modèles Kiro utilisent actuellement un raisonnement émulé : opencodex convertit le niveau choisi en instructions de réflexion bornées dans le contenu utilisateur, car leur champ d’effort natif n’a pas été vérifié. La présence d’un contrôle d’effort annoncé sur ces modèles ne prouve donc pas la prise en charge native du raisonnement en amont.

## `cursor`

**Cibles :** `agent.v1.AgentService/Run` de Cursor, en flux HTTP/2 Connect sur `api2.cursor.sh`.
**Authentification :** jeton OAuth/d’accès Cursor provenant de `provider.apiKey` ou de l’en-tête d’autorisation transmis.

- Utilise `runTurn` plutôt que le chemin habituel fetch/parse. Les requêtes, événements serveur, arguments d’outil, points de contrôle de l’utilisation et réponses du client sont encodés avec les schémas `@bufbuild/protobuf` de `cursor/gen/agent_pb.ts`, puis encadrés comme messages Connect.
- Rejoue l’état de la conversation au moyen de blobs adressés par leur contenu, remappe les appels d’outils du serveur vers Codex, découvre les modèles Cursor disponibles en direct au moyen de l’appel RPC protobuf `GetUsableModels` et ne relance une opération qu’avant que la requête d’exécution ait été écrite sur le transport.
- Expose Cursor Router sous `cursor/auto`, ainsi que les entrées explicites `cursor/auto-cost`, `cursor/auto-balance` et `cursor/auto-intelligence`. Les niveaux explicites sont encodés dans `requested_model.parameters`, tandis que l’ancienne entrée `cursor/auto` conserve la valeur par défaut du compte ou de l’équipe.
- Envoie les niveaux ordinaires de `cursor/grok-4.5` avec les identifiants de protocole exacts issus de la découverte en direct de Cursor (`cursor-grok-4.5-low`, `-medium` ou `-high`). `cursor/grok-4.5-fast` reste sélectionnable, mais le modèle canonique `grok-4.5` est envoyé avec des paramètres distincts `effort` et `fast=true`.
- L’exécution locale native de commandes sur le système de fichiers, le shell ou le réseau par Cursor est refusée par défaut. Les intégrations explicites `mcpServers` et `desktopExecutor` disposent d’activations distinctes ; `nativeLocalExec: "on"` active l’exécuteur intégré plus large et contourne la sémantique d’approbation et de bac à sable de Codex. L’ancien réglage `unsafeAllowNativeLocalExec: true` reste équivalent uniquement lorsque `nativeLocalExec` n’est pas défini.

## `azure-openai` (alias : `azure`)

**Cibles :** **Azure OpenAI**. Encapsule `openai-responses` (et utilise donc également `passthrough: true`).
**Authentification :** `key` au moyen de l’en-tête `api-key` (et non Bearer).

- Délègue la construction de la requête au relais Responses, vérifie que `baseUrl` ne contient aucun espace réservé de modèle non résolu et remplace `Authorization` par `api-key`. L’URL configurée cible directement l’API Responses v1 d’Azure ; l’adaptateur n’ajoute donc pas `api-version`.

## Utilitaires d’image (`image.ts`)

Fonctions partagées par les adaptateurs qui prennent en charge la vision :

- `parseDataUrl(url)` — sépare une URL `data:<type>;base64,<data>` en `{ mediaType, base64 }` pour les blocs d’image Anthropic/Google.
- `contentPartsToText(content)` — aplatit les parties de contenu en texte pour les messages d’outil purement textuels (une image sans description devient un court marqueur `[image]`, jamais un blob base64 qui consommerait énormément de jetons).
