---
title: Configuration du serveur et de l'environnement d'exécution
description: Écouteur, accès à distance, clés d'admission, délais d'attente, stockage, services auxiliaires, appels fantômes et comportement au démarrage.
---

Les paramètres du serveur contrôlent la manière dont le proxy local écoute, protège le trafic distant, gère les ressources et
exécute des fonctionnalités d'assistance autour des demandes du fournisseur.

## Champs du serveur

| Champ | Type | Par défaut | Signification |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Port d'écoute proxy. |
| `hostname?` | `string` | `"127.0.0.1"` | Adresse de liaison. Les liaisons hors bouclage nécessitent `OPENCODEX_API_AUTH_TOKEN`. |
| `proxy?` | `string` | — | URL du proxy HTTP(S) ou SOCKS5 sortant (`socks5://host:port`) ou `${ENV_VAR}`. Les URL HTTP s’appliquent à `HTTP_PROXY` / `HTTPS_PROXY` si elles sont vides. Les URL SOCKS5 utilisent le tunnel SOCKS5 intégré et sont aussi exposées via `ALL_PROXY` (`ocx start --socks5`); `HTTP(S)_PROXY` héritées sont effacées dans ce processus. Le bouclage reste dans `NO_PROXY`. |
| `emptyCompletionRetry?` | `boolean` | `false` | Active une nouvelle tentative Responses identique lorsqu’une réponse ne contient ni texte ni appel d’outil. Cette tentative peut être facturée. `OCX_EMPTY_COMPLETION_RETRY=0` la désactive sans modifier la configuration ; les combinaisons et les tours de compactage routés restent exclus. |
| `stallTimeoutSec?` | `number` | `300` (public) / désactivé (local) | Secondes sans progression utile en amont (Responses et Chat natif) avant la coupure du flux. Sans réglage, un amont **local** (loopback, privé ou nom `.local`/`.lan`) est désactivé par défaut et un amont public vaut 300 s ; une valeur positive s'applique aux deux (minimum 1 s) ; `0` désactive partout le watchdog de silence. Pour Responses qui replie le SSE canonique ChatGPT en JSON non-streaming, un plafond total indépendant de 15 minutes subsiste même lorsque ce watchdog est désactivé. Les lectures de corps en attente de `/v1/responses/compact` partagent ce budget mais valent 300 s par défaut même pour un amont local ; une valeur explicite, y compris `0`, prime. |
| `connectTimeoutMs?` | `number` | `200000` | Délai maximal par tentative pour DNS/TCP/TLS et les en-têtes finaux ; il prend fin avant la génération du corps. |
| `shutdownTimeoutMs?` | `number` | `5000` | Délai de vidange gracieux avant l’annulation des tours actifs. |
| `websockets?` | `boolean` | `false` | Annonce et autorise la route WebSocket Responses destinée aux clients. La valeur false maintient les clients sur HTTP/SSE ; elle ne désactive pas une optimisation WebSocket canonique admissible vers ChatGPT en amont. |
| `corsAllowOrigins?` | `string[]` | `[]` | Origines exactes supplémentaires autorisées par CORS. Les origines de bouclage sont toujours autorisées. Les origines d'extensions de navigateur basées sur l'autorité telles que `chrome-extension://<extension-id>` sont prises en charge ; `*` n'est pas un caractère générique. Firefox et Safari régénèrent l'extension UUID (par installation / par lancement de navigateur), mettez donc à jour l'entrée lorsque l'origine change. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | Identifiants `ocx_…` générés pour l'admission au plan de données sur les liaisons hors bouclage. Ils n'autorisent pas les API de gestion ; l'accès à la gestion utilise l'identifiant distinct décrit dans la [référence de l'API de gestion](/fr/reference/management-api/). Gérés depuis le tableau de bord. |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | désactivé | Politique facultative de nettoyage des sessions archivées. Elle n'est jamais activée implicitement. |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | Plafond en Mio pour les journaux, caches, objets binaires et charges utiles de continuation évincables qui appartiennent à l'application. Plage : 64–4096 ; il ne s'agit pas d'un plafond RSS. |
| `metricsExport.enabled?` | `boolean` | `false` | Active les métriques de requêtes agrégées, locales au processus, sur `GET /api/metrics` authentifié. Redémarrage requis ; lorsque désactivé, le chemin renvoie 404 et aucune activité d'export n'est démarrée. |
| `codexAutoStart?` | `boolean` | `true` | Autorise le lanceur intermédiaire Codex à exécuter `ocx ensure` avant de démarrer Codex. Avec la valeur false, cette vérification ne fait rien. |
| `codexShimAutoRestore?` | `boolean` | `true` | Restaure le lanceur intermédiaire installé après son remplacement par une mise à jour externe de Codex terminée. Désactivation par variable d'environnement : `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`. |
| `syncResumeHistory?` | `boolean` | `true` | Compatibilité historique Codex App réversible. Les métadonnées originales sont sauvegardées et restaurées par `ocx stop` / `ocx restore`. |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | désactivé | Redirigez les appels Codex helper/shadow reconnus vers un modèle choisi tout en conservant l'effort de raisonnement configuré pour la requête. Le préfixe source par défaut est `gpt-6-luna`, `gpt-5.6-luna` ; les clients plus anciens via 0.144.x utilisaient `gpt-5.4-mini`, que `sourceModels` peut restaurer. |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | activé lorsqu'il est utilisable | Options du service auxiliaire de recherche Web. |
| `visionSidecar?` | `OcxVisionSidecarConfig` | activé lorsqu'il est utilisable | Options du service auxiliaire de description d'images. |
| `images?` | `OcxImagesConfig` | sélection automatique OpenAI | Options de relais d'images autonomes pour Codex `image_gen`. |

Si une ancienne version de développement a modifié les métadonnées de l'historique de reprise avant que la prise en charge de la sauvegarde n'existe, exécutez
`ocx recover-history --legacy-openai --yes` pour forcer la récupération du fournisseur natif.
La commande réétiquette chaque ligne `opencodex` contenant un message utilisateur, y compris l'historique légitime d'un fournisseur dédié ; consultez l'avertissement sur la portée complète dans la référence du cycle de vie avant de l'exécuter.

### Délais et fin de réponse du Chat natif

Le Chat natif utilise aussi `stallTimeoutSec` pendant l’attente de la sortie amont. Le texte non vide, le raisonnement, le refus, les mises à jour d’outils et les événements de fin renouvellent ce délai ; les commentaires de maintien de connexion, le rôle seul et les statistiques seules ne le renouvellent pas. L’attente d’un client lent suspend le décompte. Un blocage produit `upstream_stall_timeout` : un événement d’erreur en streaming, ou HTTP 502 sans streaming. Une annulation avant le résultat terminal renvoie une erreur d’annulation plutôt qu’une réponse partielle réussie. Le Chat sans streaming accepte les délimiteurs SSE LF et CRLF et les champs data multilignes.

## Accès à distance

La liaison par défaut à `127.0.0.1` est limitée au bouclage. Une adresse hors bouclage telle que `0.0.0.0`
exige un identifiant pour le plan de données : `OPENCODEX_API_AUTH_TOKEN` ou au moins une entrée `apiKeys`
configurée. Pour utiliser le jeton d’environnement, exportez-le avant le démarrage :

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

Le proxy refuse une liaison distante sans identifiant du plan de données. L’installation d’un service exige
spécifiquement `OPENCODEX_API_AUTH_TOKEN` ; exportez-le avant `ocx service install` afin que launchd, systemd
ou le Planificateur de tâches le reçoive. Les clients du plan de données peuvent envoyer :

```text
x-opencodex-api-key: your-secret-token
```

Ce jeton n’autorise pas les routes de gestion `/api/*`. Celles-ci exigent l’identifiant administrateur
indépendant décrit dans la [documentation de l’API de gestion](/fr/reference/management-api/), lequel doit
être différent de tous les identifiants du plan de données.

| Point de terminaison | `Authorization: Bearer` | `x-opencodex-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` | non accepté | **obligatoire** | non accepté |
| `/v1/chat/completions` | non accepté | **obligatoire** | non accepté |
| `/v1/messages` | accepté | accepté | accepté |
| `/v1/messages/count_tokens` | accepté | accepté | accepté |
| `/v1/models` | accepté | accepté | accepté |

Responses et Chat Completions réservent `Authorization` à un éventuel transfert direct vers Codex ; seul
l'en-tête d'admission dédié y est donc accepté. Les `apiKeys` générées depuis le tableau de bord peuvent remplacer le
jeton d'environnement après le démarrage ; les valeurs candidates sont comparées en temps constant.

Messages et `count_tokens` continuent d'accepter les trois formes d'admission pour assurer la compatibilité avec les clients routés. Le
transfert natif vers Anthropic est plus strict sur une liaison hors bouclage : l'admission du proxy doit utiliser
`x-opencodex-api-key`, tandis que `Authorization` et `x-api-key` sont réservés aux identifiants Anthropic.
Tout secret d'admission de proxy placé dans les en-têtes de ces fournisseurs est supprimé avant le transfert.

:::caution[Exposition au réseau local]
Une liaison à `0.0.0.0` expose le proxy et l'accès aux fournisseurs configurés sur le réseau local. Utilisez-la uniquement sur des
réseaux de confiance avec un jeton robuste.
:::

### Clients locaux qui ne peuvent pas recevoir le jeton

Une liaison distante exige un identifiant de chaque appelant, y compris des appelants locaux. Cela pose problème dans un cas précis :
un `codex app-server` lancé par un processus hôte qui résout directement le point d'entrée Codex
(`require.resolve('@openai/codex/bin/codex.js')`) ne traverse jamais la cale `codex` générée,
donc il n'hérite jamais de `OPENCODEX_API_AUTH_TOKEN` et chaque appel de modèle échoue avec `401` avant un
le flux s’ouvre.

`unauthenticatedLoopbackListener` ouvre un second écouteur lié à `127.0.0.1`, qui accepte les requêtes sans
identifiant. L'écouteur principal reste inchangé : les appelants distants ont toujours besoin du jeton.

```json
{
  "hostname": "0.0.0.0",
  "port": 10100,
  "unauthenticatedLoopbackListener": { "enabled": true, "port": 10200 }
}
```

`ocx sync` écrit ensuite `base_url = "http://127.0.0.1:10200/v1"` dans le bloc du fournisseur Codex géré
et omet l'en-tête d'authentification ; un serveur d'applications lancé directement fonctionne ainsi sans avoir à transmettre d'identifiants.

Le port est obligatoire et doit différer du port proxy. Il n'est jamais attribué par le système d'exploitation : un port éphémère
changerait au fil des redémarrages tandis que les serveurs d'applications déjà en cours d'exécution conservaient le `base_url` précédent.

L'écouteur ne sert que `POST /v1/responses`, sa mise à niveau WebSocket, `POST /v1/responses/compact`,
`POST /v1/alpha/search` (le relais de recherche web natif de Codex), `GET /v1/models` et les mises à
niveau WebSocket vocales autonomes. Tout le reste, y compris `/api/*` et le tableau de bord, renvoie `404`.

:::danger[Surface non authentifiée]
Chaque processus de la machine peut utiliser cet écouteur. Il consomme le quota du compte et utilise les identifiants de
fournisseurs payants ; il peut aussi épuiser la capacité partagée de traitement des tours dont dépendent les clients distants authentifiés.
Ne l'activez pas sur un hôte partagé ou mutualisé.

La liaison à `127.0.0.1` signifie que le noyau refuse les connexions distantes, mais il n'arrête pas un navigateur :
une page que vous visitez peut permettre à votre navigateur de se connecter à `127.0.0.1`. L'auditeur applique donc le
mêmes vérifications `Host` et `Origin` qu'une liaison de bouclage ordinaire. Désactivé par défaut.
:::

### Redirection de port SSH

L'utilisation à distance ne nécessite pas de liaison à distance. Gardez le bouclage et transférez-le :

```bash
ssh -L 20100:localhost:10100 you@remote
```

N'importe quel port local fonctionne. Les requêtes dont l'hôte se résout en `localhost`, `127.0.0.1` ou `::1` restent
bouclage quel que soit le port, donc `http://localhost:20100/v1` fonctionne. Définissez cette base URL dans le client ;
`ocx` écrit uniquement l'adresse locale `127.0.0.1` par défaut dans la configuration du client géré.

Les rappels OAuth du fournisseur écoutent sur un port distant fixe. Connectez-vous depuis la machine distante ou redirigez
également ce port :

```bash
ssh -L 20100:localhost:10100 -L 1455:localhost:1455 you@remote
```

Si un port de rappel enregistré est déjà utilisé et que la surface de connexion propose une saisie manuelle, OpenCodex
conserve l'URI de redirection enregistrée et renvoie tout de même l'URL d'autorisation du fournisseur. Terminez la
connexion au fournisseur, puis collez dans OpenCodex l'URL de redirection finale affichée dans la barre d'adresse du navigateur ou le
code d'autorisation. Le flux en attente préserve l'état et la validation PKCE. Pour les appelants sans saisie
manuelle, l'opération échoue toujours de manière sûre.

:::caution[Le bouclage transféré n'est pas authentifié]
La commande `ssh -L` simple écoute sur votre interface de bouclage locale et convient à la liaison non authentifiée par défaut. N'utilisez pas
`ssh -g -L`, une publication de conteneur trop large ou des modes de redirection qui exposent le côté client sur
`0.0.0.0`. Liez explicitement avec `ssh -L 127.0.0.1:20100:localhost:10100` en cas de doute.
:::

## Nettoyage du stockage

`storageCleanupPolicy` est désactivé par défaut. Lorsqu'il est activé, il s'exécute selon `startup`, `daily`, `weekly`
ou `manual` après que les octets archivés dépassent `trigger.archivedBytesOver`. Il sélectionne les archives les plus anciennes vers
soit `target.reduceToBytes` soit `target.removeOldestPercent`. `mode` est par défaut `quarantine` ; utiliser
`permanent` uniquement comme un choix destructeur explicite. La politique persiste `lastRun` et `nextRun`.
Configurez-le sur la page Stockage ou avec `GET`/`PUT /api/storage/cleanup-policy` ; déclencher une exécution manuelle
avec `POST /api/storage/cleanup-policy/run`.

## Claude Code (`claudeCode`)

Ces paramètres régissent `/v1/messages`, `/v1/messages/count_tokens`, le lanceur `ocx claude` et la page du tableau de bord Claude.

| Clé | Type | Par défaut | Description |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | Budget d'inactivité du corps de transfert natif en secondes pendant qu'une lecture est en attente, et non en durée totale. 1 minimum ; exactement `0` désactive. |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | Plafond cumulatif du corps lors d'un transfert natif, pour les réponses diffusées en continu comme pour celles mises en mémoire tampon. La valeur exacte `0` désactive ce plafond. |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | automatique | Manière dont le lancement gère `ANTHROPIC_AUTH_TOKEN`. Le mode automatique détecte l'authentification à chaque lancement ; une valeur explicite n'est jamais remplacée. |
| `claudeCode.authModeMigratedAt?` | `string` | non défini | Marqueur de mise à niveau interne unique. Ne réglez pas manuellement. |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | hériter | Effort écrit pour générer `~/.claude/agents/ocx-*.md` ; distinct des plafonds d’orientation et de proxy Codex. Redémarrez par `ocx claude` pour régénérer. |

L'authentification automatique sélectionne l'abonnement lorsqu'une authentification Claude stockée est trouvée, le proxy lorsqu'aucune ne l'est et
l'abonnement avec un avertissement lorsque la détection n'est pas concluante. Voir
[Mode d'authentification de Claude Code](/fr/guides/claude-code/#mode-dauthentification).

## Appels fantômes

Codex utilise de petits modèles auxiliaires pour des tâches telles que les titres et les messages de commit. Activez
`shadowCallIntercept` pour rediriger les préfixes de modèle source reconnus vers un autre modèle configuré. Le
modèle de remplacement conserve l'effort de raisonnement configuré pour la requête. Définissez `sourceModels` uniquement lorsqu'un client utilise d'autres identifiants de modèles auxiliaires.
L'interception dépend du modèle : toute requête dont l'identifiant de modèle nu correspond à `sourceModels`
peut être redirigée, y compris une requête normale portant `request_kind: "turn"`. Les requêtes marquées
comme enfants générés par `x-openai-subagent: collab_spawn` ou par `subagent_kind: "thread_spawn"` dans
l'en-tête JSON `x-codex-turn-metadata` sont exemptées, afin qu'un sous-agent explicitement généré conserve son modèle.

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-6-luna", "gpt-5.6-luna"]
  }
}
```

### Quand la cible est indisponible

Le remplacement est la seule destination choisie par l'opérateur : une cible qui ne se résout plus fait échouer l'appel auxiliaire au lieu de l'envoyer ailleurs. Lorsque le fournisseur de la cible est désactivé ou supprimé, ou que son combo n'existe plus, une requête interceptée renvoie `409` avec le code d'erreur `intercept_target_unavailable` avant tout envoi en amont. Le journal des requêtes enregistre le même code. La requête n'est pas transmise au modèle auxiliaire natif et ne se replie pas sur le fournisseur par défaut, car l'un comme l'autre changerait la destination, les identifiants et le coût sans votre choix. Une cible combo ou profil de routage continue de basculer entre ses propres membres. Une cible qualifiée comme `provider/model` dont le segment fournisseur ne désigne rien de configuré est traitée de la même façon, et l'API des réglages refuse de l'enregistrer. Un identifiant de modèle nu résolu via le fournisseur par défaut reste valide.

Désactiver (`PATCH /api/providers?name=<provider>` avec `disabled: true`) ou supprimer un fournisseur vers lequel la cible se résout réussit toujours ; la réponse ajoute `dependentShadowIntercept: { model, enabled }` et le tableau de bord affiche un avertissement. Réactiver le fournisseur, ou choisir une autre cible, rétablit l'interception.

## Services auxiliaires

### `images` (`OcxImagesConfig`)

| Champ | Type | Par défaut | Signification |
| --- | --- | --- | --- |
| `provider?` | `string` | sélection automatique OpenAI | Fournisseur personnalisé `openai-responses` à clé API, sélectionné explicitement pour `/v1/images/generations` et `/v1/images/edits`. Les identifiants gérés par le registre sont rejetés. |
| `timeoutMs?` | `number` | `300000` | Délai d’expiration de l’ensemble de la demande pour une demande d’images autonome. |

La sélection explicite échoue de manière sûre lorsque le fournisseur est absent, désactivé, incompatible ou ne dispose pas d'une
clé utilisable ; elle ne se rabat jamais sur un autre service en amont payant. Le point de terminaison doit implémenter les routes de
l'API Images d'OpenAI et la forme de réponse attendue par Codex.

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

| Champ | Type | Par défaut | Signification |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | activé lorsqu'il est utilisable | Interrupteur principal. Avec `false`, OpenCodex cesse d'intercepter `web_search` et l'intégration Codex écrit `web_search = "disabled"` dans `~/.codex/config.toml`. |
| `backend?` | `"openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"` | `openai` | Une valeur explicite est prioritaire ; l'absence de valeur sélectionne toujours `openai`. `anthropic` et `xai` ne s'exécutent que s'ils sont configurés explicitement ; `gemini` et `exa` restent réservés jusqu'à la livraison de leur executor. |
| `model?` | `string` | dépendant du backend | `gpt-5.6-luna` pour OpenAI, `claude-sonnet-5` pour Anthropic ou `grok-4.6` pour xAI. L'héritage explicite `gpt-5.4-mini` migre au démarrage. |
| `exaApiKey?` | `string` | aucun | Clé opérateur pour le backend `exa`. Écriture seule : les lectures de gestion ne renvoient jamais la valeur stockée. |
| `xSearch?` | `object` | omis | Activation facultative de `x_search` hébergé, propre à xAI : `enabled`, tableaux mutuellement exclusifs `allowedXHandles` / `excludedXHandles` (20 au maximum), et dates ISO `fromDate` / `toDate` (`YYYY-MM-DD`). |
| `reasoning?` | `string` | `low` | Effort secondaire. `minimal` est rejeté lors de la recherche sur le Web. |
| `maxSearchesPerTurn?` | `number` | `3` | Recherches réelles autorisées par tour de modèle principal. |
| `routedModelStallTimeoutMs?` | `number` | `200000` | Date limite d'inactivité du corps brut du modèle routé uniquement pour les fichiers de configuration. Entier 1–2147483647 ; chaque morceau non vide le réinitialise. |
| `timeoutMs?` | `number` | `60000` | Date limite pour une recherche hébergée. |

Le moteur OpenAI nécessite une connexion à ChatGPT et un fournisseur ChatGPT `forward` activé. Les relectures routées
entrantes depuis Claude injectent l'authentification ChatGPT principale dans la requête interne. Le moteur Anthropic utilise les
identifiants actifs stockés auprès d'un fournisseur Anthropic OAuth activé. Si le moteur Anthropic est sélectionné explicitement
mais qu'aucun compte n'est utilisable, l'opération échoue de manière sûre au lieu de se rabattre sur un autre moteur. L'exécuteur Anthropic utilise son
outil `web_search_20250305` natif. Le backend xAI nécessite un compte OAuth Grok stocké et utilisable, emploie
`web_search` hébergé et ajoute `x_search` hébergé lorsque `xSearch.enabled` vaut true. Une entrée de gestion
`xSearch` mal formée renvoie `400` ; un bloc persistant mal formé échoue de manière sûre pendant la planification.
Les voies `gemini` et `exa` ne s'activent jamais par découverte d'identifiants ni par fallback ; l'opérateur doit
les sélectionner explicitement. `exaApiKey` est accepté en écriture mais omis des réponses de gestion.

Quatre horloges régissent la recherche : base `stallTimeoutSec`, `connectTimeoutMs`, inactivité du modèle routé et
délai d'expiration de la recherche hébergée. Le chien de garde efficace du pont est le maximum plus 30 secondes. Le décrochage routé est
une garde d'inactivité, pas un délai de génération total.

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Champ | Type | Par défaut | Signification |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | activé lorsqu'il est utilisable | Commutateur principal de description d'images. |
| `backend?` | `"openai" \| "anthropic"` | automatique | La valeur explicite prévaut ; si elle est omise, un identifiant OAuth Anthropic stocké et utilisable est privilégié, sinon `openai`. |
| `model?` | `string` | dépendant du backend | `gpt-5.6-luna` pour OpenAI ou `claude-sonnet-5` pour Anthropic. |
| `maxDescriptionsPerTurn?` | `number` | `8` | Nouvelles descriptions des ratés du cache admises par tour principal. `0` désactive les appels ; les valeurs non valides utilisent la valeur par défaut. |
| `timeoutMs?` | `number` | `45000` | Délai d'expiration de la récupération par le service auxiliaire. Entier 1–2147483647. |

La vision ne s'active que pour les images envoyées à un modèle répertorié dans le champ `noVisionModels` de son fournisseur. OpenAI impose les
mêmes exigences de connexion et de transfert que pour la recherche ; lorsqu'Anthropic est sélectionné explicitement, l'opération échoue de manière sûre sans
identifiant utilisable. Les descriptions `data:` réussies utilisent un cache limité indexé par moteur, modèle, niveau de détail,
octets de l'image et contexte de message normalisé. Les accès au cache et les doublons d'un même tour ne consomment pas la limite.
Les images `https:` distantes et les descriptions échouées ou vides ne sont pas mises en cache.

Les services auxiliaires Anthropic OAuth réutilisent l'empreinte OAuth Claude Code existante d'opencodex. Effectuez un test d'endurance avec le
compte et la charge de travail prévus.

## Clés Remote Hub et valeurs par défaut

`runtimeRole` vaut `standalone` par défaut. Un hub utilise `hub.managementPublicOrigin`, `hub.managementIngress` limité au loopback (`enabled:false` si absent) et les identités exactes de `remoteGui.allowedTailscaleUsers` (liste vide si absente). La clé client reste dans `service-api-token`, jamais dans `config.json`; `service-api-token.prev` peut exister pendant une rotation. Les usages ne sont pas répliqués.

`remoteGui.allowInsecureHttp` est un ancien no-op déprécié, conservé uniquement pour que les anciens fichiers passent encore le schéma strict. Supprimez-le de la configuration : les grants de pairing ne sont acceptés que sur loopback ou via HTTPS authentifié, et `true` ne réactive pas le pairing HTTP en clair.

## Diagnostic réseau des quotas Codex

Le champ `quotaRefresh` de la ligne du compte Codex principal décrit la récupération du quota, pas le quota restant ni les droits d’accès au modèle. Il peut être absent lorsque les données sont en cache ou qu’aucune récupération n’a eu lieu. La requête utilise l’environnement du service proxy en cours d’exécution, pas celui du terminal interactif. Sans `proxy`, l’environnement existant est conservé ; `"auto"` lit les paramètres HTTP/HTTPS statiques de Windows ou macOS au démarrage. Sur macOS, un proxy hérité empêche cette lecture. Sur macOS, un motif valide `*.<domain>` devient `.<domain>` : `foo.local` contourne le proxy pour `*.local`, `xlocal` non, et le nom racine `local` le contourne aussi. Les plages exactes `169.254/16`, `169.254.0.0/16` et `fe80::/10` sont ignorées avec un diagnostic : les adresses IP link-local passent par le proxy. Les autres plages CIDR, motifs glob et exceptions de noms simples refusent la découverte sans modifier l’environnement. Les adresses IP et `*` restent acceptés. PAC/WPAD, les paramètres SOCKS seuls et les changements à chaud ne sont pas pris en compte automatiquement. Un succès avec TUN ne valide pas à lui seul le chemin du proxy HTTP. Consultez [les commandes et les états en anglais](/reference/configuration/server/#codex-quota-network-diagnostics).

### Forced Claude Code subagent model

The Subagents page offers **Force all subagents onto one model**, off by default. Select an exposed roster-style id, such as `combo/tev-auto`, then enable the switch. The roster is offered first; unavailable saved roster entries cannot be force targets.

`ocx agent subagents force combo/tev-auto` sets `claudeCode.subagentModelForce`; `ocx agent subagents force -` clears it. `ocx agent status` reports the setting. `GET /api/subagent-models` returns `force`, `forceAvailable`, and `forceStatus`; `PUT` accepts `{ "force": "combo/tev-auto" }` or `{ "force": null }` without changing the roster. Omitting `force` leaves it unchanged. Invalid or unexposed targets are rejected on write; stale targets are reported and skipped at launch.

This takes effect on the **next routed `ocx claude` launch**, injecting `CLAUDE_CODE_SUBAGENT_MODEL` as an explicit proxy alias (with `[1m]` only for an authoritative million-token window; native Claude targets use a reversible native alias) and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Each nonempty shell-exported variable independently wins. Native launches inject neither variable; plain `claude` is not affected. No plugin files or `settings.json` are modified by this setting.

Claude Code **2.1.257 or newer** is required for FORCE. Plugin and built-in agents (including Explore/Plan) and per-call model arguments are overridden. Forks and subagent skills with `model: inherit` keep the main conversation model. The main loop and Haiku/small-fast sidecars are unaffected. Existing roster files remain available.

The dashboard warns about old or unknown CLI versions, unavailable targets, and either variable already present in `settings.json` → `env` (which overrides launch env). Detection is read-only and server-local: it cannot inspect another launch shell, another machine, or project-local settings. An unknown result is not proof of force support.

## Continuité de l’historique des pools

Le plafond d’un pool s’applique au fournisseur canonique choisi par le routage, indépendamment du libellé de compte dans les journaux. Pour chaque fournisseur `P` actuellement configuré, OpenCodex associe automatiquement `h(pool, P)`, son alias de pool salé propre à cette installation, à `P` lors de la lecture des soldes. Cela inclut les soldes historiques conservés sous ce même alias. Les plafonds indépendants ne nécessitent ni association manuelle du fournisseur à lui-même ni calcul avec le sel.

Les autres libellés historiques, y compris ceux contenant un numéro de compte, restent sans propriétaire confirmé. Chaque solde d’origine est compté une seule fois dans son groupe associé ; tout solde positif encore non associé est ajouté, par prudence, une fois à chaque pool candidat. Les montants réglés, réservés et non résolus comptent tous. Un historique inconnu peut donc limiter un pool inutilisé. Les noms actuels et l’ordre des comptes ne prouvent pas à quel fournisseur cet historique appartient. Les plafonds de racine et d’identité restent indépendants.

Pour un historique dont vous avez vérifié le propriétaire, ajoutez une entrée dans `spendPoolAliases`, au premier niveau de `config.json`, en dehors de `spend`. La clé est l’alias salé exact du pool dans le journal de cette installation, composé de 32 caractères hexadécimaux minuscules ; la valeur est l’ID exact d’un fournisseur vérifié et actuellement configuré, sans espaces au début ni à la fin. Gardez le journal, le sel et les éléments justificatifs privés. L’alias propre d’un fournisseur configuré ne peut pas être attribué à un autre fournisseur. La validation est répétée lorsque les fournisseurs changent et lit le sel existant sans en créer.

Les associations automatiques et explicites s’appliquent uniquement à la lecture : elles ne déplacent pas les soldes et n’inscrivent aucun lien d’identité dans le journal. Supprimer une association explicite rend l’historique inconnu, sauf si son alias est celui d’un fournisseur actuellement configuré. Une association invalide est rejetée à l’écriture ; une modification manuelle invalide conserve les plafonds mais bloque l’admission du pool.

Un historique inconnu et inactif expire seulement quand sa dernière activité est strictement antérieure à la limite de `spend.retentionDays`. Un manque de capacité ne raccourcit pas ce délai pour un solde positif. Les réservations actives et leurs cibles restent protégées, même à zéro jeton. La suppression doit être enregistrée durablement avant de réduire le total utilisé pour l’admission.

### Réservations et limite d’envoi

Lorsqu’un plafond de racine, d’identité ou de pool s’applique, le premier envoi pour chaque cible ou clé nécessite une réservation dans la capacité normale de suivi. Sans réservation, aucun envoi n’atteint le fournisseur. Les nouvelles tentatives stables réutilisent les mêmes périmètres ; une autre cible ou clé nécessite une nouvelle réservation. `L` est la limite des envois physiques pour l’ensemble de la requête, figée au démarrage de la requête : quatre par défaut, ou jusqu’à dix-huit avec le profil de requête OAuth existant.

L’activation des limites, les plafonds de jetons applicables à la racine, à l’identité et au pool, ainsi que `L`, sont déterminés au démarrage de chaque requête. Les changements de configuration s’appliquent uniquement aux requêtes démarrées après le changement. Une requête déjà en cours garde sa politique initiale pour toutes les nouvelles tentatives et continuations : activer ou abaisser un plafond ne la restreint pas davantage ; le relever ou le supprimer ne l’assouplit pas. Une requête commencée en observation seule reste dans ce mode jusqu’à sa fin.

Le règlement final attend les rapports des envois démarrés. Un ID d’envoi n’est oublié qu’après enregistrement durable de sa comptabilité ; son solde demeure. La limite borne les envois, pas la facture : toute utilisation réelle supérieure à l’estimation reste comptabilisée. Sans plafond applicable, le comportement reste en observation seule, y compris l’omission des écritures lorsque la capacité de suivi est pleine. Aucun point de contrôle d’identité n’est ajouté.

Claude CLI, CodeBuddy et Qoder comptent chaque invocation CLI comme un envoi et exigent une réservation normale avant le lancement. Les nouvelles tentatives et les tours d’outils internes au CLI ne consomment pas séparément la limite d’envois de la requête. Leur coût est réglé selon l’utilisation réelle rapportée, y compris la part dépassant l’estimation initiale.

### Retour à 2.80.0 : contrat C

Les nouveaux enregistrements utilisent le format v1 ordinaire et le domaine d’alias `pool`. La version 2.80.0 non modifiée les lit, compacte le journal et applique la rétention selon ses propres règles par libellé. Conservez le journal actuel et son sel : restaurer une ancienne copie perd les dépenses enregistrées depuis. Aucun correctif rétroporté, blocage du lanceur ou commande de rapprochement n’est nécessaire.

Le retour à 2.80.0 ne garantit ni l’agrégation canonique ni le même solde disponible que si un trafic identique avait toujours été traité par 2.80.0. Lors d’une nouvelle mise à niveau, les associations automatiques des fournisseurs configurés et les correspondances explicites actuelles s’appliquent aux soldes d’origine encore conservés. Aucun nouveau point de contrôle ne dépend de métadonnées de liaison d’identité à préserver par l’ancien lecteur.

Les journaux de versions expérimentales non publiées contenant `pool-current` ou `poolContinuity` sont exclus du contrat C, même après compactage. Leurs soldes d’origine restent un historique inconnu jusqu’à l’expiration normale, sans conversion ni suppression immédiate.

Un enregistrement complet mais invalide, y compris un `null` final, bloque l’admission sous plafond. Le compactage peut conserver les données valides dans un point de contrôle propre, mais le refus reste actif jusqu’au redémarrage avec ce journal propre. Une dernière ligne JSON incomplète suit les règles de récupération existantes. Voir les limites et codes d’erreur dans la [référence anglaise](/reference/configuration/server/#historical-pool-continuity).
