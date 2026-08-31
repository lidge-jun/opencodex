---
title: Configuration du fournisseur
description: Entrées du fournisseur, authentification, points de terminaison, catalogues de modèles, quotas, limites de contexte et options spécifiques au fournisseur.
---

Un fournisseur indique à opencodex où se trouve un modèle, quel adaptateur de protocole il utilise et comment les requêtes sont
authentifiées.

## Champs de premier niveau liés aux fournisseurs

| Champ | Type | Par défaut | Signification |
| --- | --- | --- | --- |
| `providers` | `Record<string, OcxProviderConfig>` | — | Mappage du nom du fournisseur avec la configuration du fournisseur. |
| `openaiProviderTierVersion?` | `2` | défini par la migration | Marque la projection OpenAI prenant en compte les options uniques comme terminée. |
| `disabledModels?` | `string[]` | — | Modèles masqués du catalogue de Codex et de `/v1/models`, mais non bloqués des appels proxy directs. Un identifiant acheminé est supprimé des listes. Un identifiant natif qualifié de compte masque uniquement cette ligne de sélecteur ; un identifiant GPT natif nu masque la ligne nue et chaque ligne de sélecteur de compte pour ce modèle. La page Modèles du tableau de bord expose uniquement les lignes natives routées et nues ; utilisez ce champ de configuration directement pour masquer une ligne qualifiée par le sélecteur. |
| `providerContextCaps?` | `Record<string, number>` | `{}` | Limites de contexte Codex-visibles par fournisseur. Un plafond abaisse uniquement une fenêtre de contexte connue. |
| `contextCapValue?` | `number` | `350000` | Valeur par défaut utilisée par les contrôles de plafond de contexte du tableau de bord. La modifier applique la valeur à chaque fournisseur routé — y compris ceux qui ne possèdent aucune entrée `providerContextCaps` — uniquement lorsque l'option « appliquer à chaque fournisseur routé » est activée ; sinon, chaque fournisseur conserve son propre plafond. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Métadonnées du compte pool ChatGPT/Codex gérées par Codex Auth. Les secrets vivent séparément dans `codex-accounts.json`. |
| `pausedCodexAccountIds?` | `string[]` | `[]` | Comptes exclus de la sélection du pool jusqu'à la reprise, y compris le compte principal `__main__` lorsqu'il est mis en pause. |
| `codexAccountNamespaces?` | `Record<string, string>` | — | Mappage facultatif d’un sélecteur de modèle public arbitraire vers une cible de compte Codex stockée. Lorsque les lignes du sélecteur qualifié par compte sont activées, chaque sélecteur dont la cible est présente ajoute des lignes `<selector>/<native-openai-model>` distinctes au sélecteur Codex ; chaque ligne utilise uniquement ce compte. Dès qu'un sélecteur est actif, les lignes natives non qualifiées sont masquées dans le sélecteur, mais leurs identifiants restent routables et figurent toujours dans la réponse brute de `/v1/models`, sauf désactivation explicite. |
| `codexAccountPickerEnabled?` | `boolean` | désactivé lorsque la carte est vide | Contrôle si les mappages `codexAccountNamespaces` éligibles génèrent des lignes de sélecteur Codex qualifiées pour le compte. `true` permet aux lignes mappées d'apparaître. Si elle est omise avec une carte non vide, elle est traitée comme activée pour des raisons de compatibilité ascendante ; si la carte est vide, elle est éteinte. `false` masque les lignes générées et restaure les lignes nues du sélecteur natif sans supprimer les mappages ni désactiver le routage exact `<selector>/<native-openai-model>`. |
| `activeCodexAccountId?` | `string` | — | Compte de pool sélectionné manuellement pour la prochaine demande. La sélection efface l'affinité des threads ; les demandes en cours conservent les informations d’identification capturées. |
| `codexAccountPriorities?` | `Record<string, number>` | — | Ordre de sélection par compte pour le pool Codex : identifiant de compte → entier de `-100` à `100`, **les valeurs élevées sont prioritaires**, une valeur absente équivaut à `0`. Cette limite porte sur le classement, et non sur l'admissibilité : la sélection retient, parmi les comptes déjà admissibles, le niveau prioritaire le plus élevé qui dispose encore d'une marge de quota, puis `accountPoolStrategy` choisit un compte dans ce niveau. Un niveau est ignoré uniquement lorsque chacun de ses membres dépasse `autoSwitchThreshold`, est en temporisation, est temporairement évité, est suspendu ou doit être réauthentifié ; un quota inconnu ne suffit jamais à considérer un niveau comme épuisé. L'ordre ne rend jamais admissible un compte qui ne l'est pas et ne réaffecte jamais une tâche déjà liée à un compte. Le compte principal `__main__` participe selon les mêmes règles ; la connexion Codex Desktop peut ainsi être configurée pour être utilisée en dernier. Sans entrée, le pool se comporte exactement comme auparavant. Un mappage mal formé est ignoré avec un avertissement dans la console : l'ordre est désactivé et la configuration n'est pas réparée. Ce champ est géré par `ocx account priority` et la page Codex Auth. |
| `activeCodexAccountPinned?` | `string` | — | Identifiant du compte du dernier opérateur sélectionné manuellement. Lorsqu'il est défini, un niveau `codexAccountPriorities` supérieur ne peut pas le préempter jusqu'à ce que la broche soit libérée par drainage, exclusion, suppression ou un failover/promotion explicite. Un mouvement circulaire ordinaire à l’intérieur du niveau plafonné ne le libère pas. L'écriture d'une entrée `codexAccountPriorities` libère également le pin, donc un pin créé avant qu'un ordre n'existe ne peut pas surpasser un ensemble par la suite. `GET /api/codex-auth/active` indique à la fois si le compte effectif est épinglé (`pinned`) et le compte portant le plafond (`pinnedAccountId`). |
| `autoSwitchThreshold?` | `number` | `80` | Seuil d'utilisation pour la commutation proactive. `quota` peut réévaluer les tâches liées et non liées lors de leur prochaine requête ; `fill-first` ne l'utilise que comme seuil d'évacuation pour l'affectation des requêtes non liées ; la sélection `round-robin` normale ne l'utilise pas. Le score retient la plus élevée des fenêtres de quota connues sur 5 heures, une semaine ou 30 jours. `0` désactive uniquement la commutation proactive fondée sur l'utilisation, pas l'affectation des requêtes non liées ni la récupération après incident. |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | Stratégie d'affectation des requêtes Codex nouvelles ou non liées. Une requête est non liée lorsqu'elle ne possède aucune affinité active, définie par l'identifiant de la tâche parente et la portée du quota ; une tâche existante visible peut perdre son lien après le redémarrage du proxy ou la réinitialisation de l'affinité. `quota` sélectionne le compte admissible le moins utilisé lorsqu'aucun compte actif n'existe, conserve un compte actif admissible sous `autoSwitchThreshold` et, une fois le seuil franchi, peut déplacer une requête non liée ou relier de manière proactive une tâche liée à un compte admissible moins utilisé. `round-robin` répartit équitablement les requêtes non liées ; `fill-first` continue de les attribuer au compte actif jusqu'à sa temporisation, son indisponibilité ou le seuil d'évacuation configuré. |
| `accountPoolStickyLimit?` | `number` | `1` | Nombre d'affectations de tâches nouvelles ou non liées conservées sur une même sélection tournante avant de passer à la suivante ; le compteur avance lorsqu'une tâche est liée, et non après une réponse réussie en amont. Plage : 1–100. |
| `upstreamFailoverThreshold?` | `number` | `3` | Nombre d'échecs transitoires consécutifs avant le basculement des futures nouvelles sessions. Réglez `0` pour désactiver ce mécanisme. Pour les requêtes Responses ordinaires et les envois compacts natifs, les échecs avérés d'accessibilité DNS/TCP avant connexion sont suivis au niveau du couple fournisseur-hôte : ils n'affectent jamais l'état ni la temporisation du compte, l'affinité de tâche ou de session, la sélection du compte actif ou le routage du pool, et ne sont jamais comptabilisés dans ce seuil. |
| `upstreamHostCircuitThreshold?` | `number` | `0` | Seuil facultatif du coupe-circuit pour les échecs DNS/TCP avérés avant connexion sur les requêtes Responses OpenAI natives en mode transfert et les envois compacts. `0` le désactive ; `1`–`20` ouvre, après ce nombre de requêtes logiques arrivées à leur terme, une temporisation de 30 secondes propre à l'origine du fournisseur. Tant que le circuit est ouvert, les requêtes reçoivent `503` avec `Retry-After` avant la sélection du compte ou l'envoi en amont ; après la temporisation, une requête est admise en état semi-ouvert. Les délais d'attente et les réponses HTTP ne sont jamais comptabilisés, et toute réponse HTTP ferme le circuit. Ce mécanisme s'applique uniquement au routage du pool Codex sans compte épinglé ; il reste inactif pour `codexAccountMode: "direct"` et les sélecteurs qualifiés par compte. |
| `modelCacheTtlMs?` | `number` | `300000` | Fenêtre de fraîcheur pour le cache `/models` par fournisseur. |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Politique Anthropic de mise en cache des invites : désactivée, éphémère pendant 5 minutes ou étendue à 1 heure. |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | désactivé | Politique facultative d'actualisation proactive OAuth et de préchauffage des comptes Codex. |

Les noms des sélecteurs sont des étiquettes publiques choisies par l'utilisateur ; opencodex ne leur attribue aucune sémantique de rôle de compte.
Les clés `codexAccountNamespaces` comportent de 1 à 64 caractères. Elles commencent et se terminent par une
lettre ou un chiffre ASCII et ne contiennent que des lettres, des chiffres, `.`, `_` ou `-`. Les noms réservés
des objets JavaScript sont rejetés. Chaque valeur est soit l'identifiant valide d'un compte du pool (jamais la valeur interne `__main__`),
soit `"@main"` pour le compte Codex Desktop. Les collisions avec les fournisseurs et les noms réservés `openai` / `combo` / `policy`
sont vérifiées sans tenir compte de la casse. Un combo avec espace de noms ou un alias de profil de routage ne peut pas reprendre un sélecteur
comme préfixe d'espace de noms ; les identifiants de pool configurés et les cibles de sélecteur ne peuvent pas non plus reprendre un sélecteur.
Gardez confidentiels les identifiants bruts des comptes et les adresses e-mail : le sélecteur constitue le nom public. Consultez
[Configuration du routage](/fr/reference/configuration/routing/) pour le comportement et la priorité de la sélection exacte.

Le contrôle Codex Auth du tableau de bord gère les mappages qui possèdent un champ `codexAccountPickerEnabled` explicite.
L'activation d'un mappage géré vide crée des sélecteurs qui protègent la confidentialité. Les comptes ajoutés ultérieurement étendent ce mappage,
même lorsque les lignes du sélecteur sont masquées, sans renommer les sélecteurs existants. Un mappage écrit manuellement qui omet
ce drapeau reste manuel et n'est jamais étendu automatiquement. La suppression d'un compte conserve son mappage afin que les routes exactes
échouent de manière sûre tant que le compte manque ; l'ajout ultérieur du même identifiant restaure le sélecteur public existant
au lieu d'en attribuer un nouveau.

## Fournisseurs OpenAI réservés

`openai` et `openai-apikey` sont des identifiants réservés fixes. Par défaut, `openai.codexAccountMode` vaut `"pool"`
et sélectionne le compte principal ou l'un des comptes ajoutés ; `"direct"` utilise uniquement la connexion actuelle de l'appelant ou du compte principal.
La route API utilise exclusivement sa clé API ou son pool de clés configuré. Employez un modèle sans préfixe ou `openai-apikey/<model>` :
aucun repli d'identifiants entre les routes n'est effectué. Les lignes API GPT-5.6 indiquent un contexte de 1 050 000 et une entrée maximale de 922 000.
Les identifiants virtuels Pro sont réécrits vers le modèle de protocole de base avec `reasoning.mode: "pro"`.

`openaiProviderTierVersion: 2` marque la projection actuelle fondée sur un fournisseur unique. Avant de migrer une
configuration v1 distribuée, opencodex crée `config.json.pre-openai-tiers-v2.bak` sans remplacer une
sauvegarde dont le contenu diffère, puis réécrit en identifiants sans préfixe les identifiants sélectionnés connus de l'ancien espace de noms.

## Entrées de fournisseur (`OcxProviderConfig`)

| Champ | Type | Signification |
| --- | --- | --- |
| `adapter` | `string` | L'un des `openai-chat`, `openai-responses`, `anthropic`, `google`, `kiro`, `cursor`, `ollama-native`, `azure-openai` (ou alias `azure`). |
| `baseUrl` | `string` | URL de base de l'API en amont. La plupart des points de terminaison fixes intégrés ignorent une valeur incompatible ; les préréglages de clés protégés contre les collisions préservent une ancienne destination personnalisée portant le même nom. |
| `requestPacing?` | `{ enabled, requestsPerMinute?, minIntervalMs?, models? }` | Cadencement facultatif du démarrage des requêtes sortantes côté client, distinct de l’utilisation, de la facturation et des indicateurs de limitation en amont. Le nombre de requêtes par minute est converti en intervalle régulier ; `minIntervalMs` peut imposer un intervalle plus long. Les limites du fournisseur s’appliquent à tous ses modèles, tandis que les entrées `models` ciblent les identifiants exacts des modèles en amont, par exemple `nvidia/llama-3.1-nemotron-ultra-253b-v1`, et ne peuvent qu’ajouter du délai. L’attente dans la file ne consomme pas le délai d’expiration des en-têtes de réponse en amont. Les requêtes HTTP, Responses WebSocket et les distributions explicites `fetchResponse`/`runTurn` des adaptateurs sont couvertes. |
| `responsesPath?` | `string` | Chemin de ressource relatif pour les requêtes d'authentification par clé `openai-responses`. Il doit commencer par `/` et ne contenir aucun schéma, requête ou fragment. |
| `supportsServiceTier?` | `boolean` | Repli à trois états pour la capacité `service_tier`. `true` : le mode rapide peut injecter le champ et les valeurs de l’appelant sont conservées. `false` : le champ est retiré et jamais injecté, et aucune déclaration précise de modèle ne peut le réactiver. Absent : le fournisseur n’est pas classé ; les valeurs de l’appelant sont conservées intactes et le mode rapide n’injecte rien, sauf pour un modèle exact activé. Le registre classe OpenAI canonique comme `true`, et DeepSeek ainsi que Volcengine Ark comme `false`. Ne le définissez explicitement que pour les passerelles personnalisées qui prennent réellement en charge les niveaux. Les routes Chat exigent en plus une autorisation globale ou propre au modèle. |
| `modelSupportsServiceTier?` | `Record<string, boolean>` | Remplacements de capacité par identifiant exact de modèle en amont. La valeur exacte `true` autorise ce modèle Chat même sans `chatServiceTier` ; `false` restreint les valeurs globales et l’autorisation Chat. Une valeur globale explicite `supportsServiceTier: false` reste fermée et ne peut pas être réactivée. Les modèles non déclarés suivent le comportement global. La requête de gestion `PATCH /api/providers` fusionne les entrées et accepte `null` pour en supprimer une. |
| `chatServiceTier?` | `boolean` | Active globalement la sérialisation de `service_tier` sur `/chat/completions`. Des modèles exacts peuvent aussi l’activer avec `modelSupportsServiceTier` ; les modèles non déclarés restent bloqués lorsque ce champ est absent ou faux. |
| `preserveResponsesReasoningContent?` | `boolean` | Conserve le contenu de raisonnement en texte brut dans les éléments de raisonnement Responses relus, au lieu de l'effacer comme l'exige le moteur ChatGPT. Activez cette option pour les services en amont dont le contrat accepte la relecture du raisonnement, comme DeepSeek. Les enveloppes `ocxr1` créées par le proxy sont toujours supprimées. |
| `disabled?` | `boolean` | Conserve le fournisseur sur le disque, mais l'exclut du routage et des listes de modèles et de catalogues. |
| `apiKey?` | `string` | Clé API, ou référence `${ENV_VAR}` / `$ENV_VAR` résolue au moment de la requête. |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Style de l'en-tête de clé Anthropic. La valeur par défaut est l'en-tête natif `x-api-key` ; ce champ n'est valable que pour les fournisseurs `anthropic` authentifiés par clé. |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | Pool multi-clés. `apiKey` reflète l'entrée active ; chaque élément a `id`, `key`, `label` facultatif et `addedAt` numérique facultatif. |
| `defaultModel?` | `string` | Modèle utilisé lorsque ce fournisseur est sélectionné sans modèle explicite. |
| `models?` | `string[]` | Liste initiale ou de repli des modèles. Avec `liveModels: false`, ce sont les seuls modèles découverts. |
| `liveModels?` | `boolean` | Récupère le catalogue actif au démarrage et lors de la synchronisation (true par défaut). Les fournisseurs personnalisés utilisent `${baseUrl}/models` ; les fournisseurs intégrés peuvent employer une URL de registre et un filtre. |
| `selectedModels?` | `string[]` | Liste autorisée du catalogue après la découverte. Non vide expose uniquement ces identifiants ; vide ou omis expose tous les modèles découverts. |
| `contextWindow?` | `number` | Repli contextuel à l’échelle du fournisseur lorsque les métadonnées en amont sont absentes ; sinon, un plafond qui conserve des métadonnées en direct plus petites. Le tableau de bord Modèles expose cela séparément de `providerContextCaps`. |
| `modelContextWindows?` | `Record<string, number>` | Valeurs de repli ou plafonds de contexte par modèle. Ils remplacent `contextWindow` : une fenêtre inconnue utilise la valeur configurée, tandis que des métadonnées actives plus faibles restent déterminantes. |
| `modelInputModalities?` | `Record<string, string[]>` | Conseils de saisie par modèle tels que `["text"]` ou `["text", "image"]`. |
| `modelMaxInputTokens?` | `Record<string, number>` | Limites d'entrée maximales positives par modèle utilisées pour les conseils de compactage automatique du catalogue. |
| `modelAutoCompactTokenLimits?` | `Record<string, number>` | Budgets souples de compactage automatique par modèle, sous forme d'entiers sûrs positifs. Ils peuvent uniquement abaisser l'enveloppe effective de 90 % du contexte ou de l'entrée maximale et sont omis lorsqu'aucune fenêtre de contexte faisant autorité n'est connue. Pour le fournisseur canonique `openai`, les clés doivent être les identifiants exacts de modèles natifs pris en charge, sans préfixe de fournisseur ni de sélecteur de compte. PATCH fusionne les entrées ; `null` supprime une clé, tandis que `null` pour le champ entier efface la table. Ces marqueurs `null` sont réservés à PATCH. |
| `defaultMaxOutputTokens?` | `number` | Solution de secours `openai-chat` à l’échelle du fournisseur lorsque le client omet `max_output_tokens`. |
| `modelMaxOutputTokens?` | `Record<string, number>` | Budgets de repli `openai-chat` positifs par modèle ; les correspondances exactes ou par motif priment sur la valeur par défaut du fournisseur. |
| `modelCosts?` | `Record<string, Cost4>` | Prix affichés par modèle (USD par 1M de jetons), indexés par l'identifiant exact du modèle en amont de ce fournisseur — et non par un identifiant de fournisseur ni par une étiquette routée `provider/model`, par exemple `{ "deepseek-v4-flash": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 } }`. Tout identifiant de modèle constitue une clé valide : les fournisseurs personnalisés peuvent cibler n'importe quel point de terminaison compatible avec OpenAI au moyen de l'adaptateur `openai-chat`, et les identifiants de fournisseur locaux ou internes fonctionnent même s'ils sont absents des catalogues intégrés. Les prix configurés par l'utilisateur priment sur les catalogues intégrés dans les estimations des pages Journaux (`~$`) et Utilisation. Les entrées historiques sont recalculées à partir de la surcharge actuelle ; modifier un prix peut donc changer les totaux antérieurs. L'ordre de repli est le suivant : `modelCosts` défini par l'utilisateur → catalogue jawcode → surcharge des prix attendus → repli propre au fournisseur au niveau du modèle. Une entrée entièrement nulle passe à la source suivante. Chaque tarif doit être un nombre fini positif ou nul, inférieur ou égal à 1 000 000 (USD par 1M de jetons) ; les lignes hors plage sont rejetées par l'interface de gestion et ignorées au chargement. Ces valeurs servent uniquement à l'estimation lors de l'affichage : les surcharges n'affectent jamais le routage, la sélection des comptes, les quotas ni la facturation. |
| `headers?` | `Record<string, string>` | En-têtes supplémentaires en amont. L'autorisation, les cookies, les en-têtes de clé API, les nouvelles lignes intégrées et les noms invalides sont rejetés. |
| `openRouterRouting?` | `OpenRouterProviderRouting` | Préférences OpenRouter `order`, `only` et `allowFallbacks` par défaut ; valable uniquement pour les OpenRouter canoniques avec `openai-chat`. |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` | Remplacements exacts de l'ID de modèle qui remplacent la préférence OpenRouter à l'échelle du fournisseur. |
| `vercelGatewayRouting?` | `VercelGatewayRouting` | Préférences Vercel AI Gateway par défaut pour `order`, `only` et `sort` (`"cost"` \| `"ttft"` \| `"tps"`) ; valables uniquement pour le fournisseur Vercel AI Gateway canonique avec `openai-chat`. |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` | Mode d'authentification (`key` par défaut). Les identifiants OAuth ou d'abonnement sont stockés hors de `config.json` ; `local` est réservé aux fournisseurs dont l'entrée de registre l'autorise. |
| `codexAccountMode?` | `"pool" \| "direct"` | Réservé au fournisseur canonique `openai` ; la valeur par défaut est Pool. Le mode Direct contourne l'état du pool. |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | Remplace la politique Token Guardian de ce fournisseur OAuth. |
| `reasoningEfforts?` | `string[]` | Libellés d'effort de raisonnement Codex à annoncer et à envoyer pour tout le fournisseur. Pour les fournisseurs utilisant l'adaptateur `google`, une échelle configurée déclare également la capacité `thinkingLevel` : les requêtes directes et Vertex sans image envoient l'effort sélectionné dans `generationConfig.thinkingConfig.thinkingLevel`, tandis que Cloud Code Assist utilise le chemin propre à son enveloppe. |
| `modelReasoningEfforts?` | `Record<string, string[]>` | Libellés propres à chaque modèle. Une liste vide masque le contrôle de l'effort. Comme pour `reasoningEfforts`, chaque échelle configurée avec l'adaptateur `google` déclare la capacité `thinkingLevel` ; les requêtes directes et Vertex sans image utilisent le chemin Gemini à plat, tandis que Cloud Code Assist l'envoie dans son enveloppe de requête. |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` | Définissez un modèle sur `false` pour arrêter la publicité des résumés et supprimer les champs de livraison du résumé. |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | Énumération de livraison des réponses par modèle ; réécrit un champ de livraison existant. |
| `modelAdapters?` | `Record<string, string>` | Remplacement du protocole `openai-chat` ou `openai-responses` par modèle pour les passerelles multiprotocoles. Les entrées explicites priment sur les valeurs par défaut du registre. Le préréglage OpenCode Go sélectionne Responses pour `gpt-5.6-luna` tout en laissant les modèles apparentés sur leurs protocoles documentés ; DeepSeek peut sélectionner Responses natif pour `deepseek-v4-flash` ; GitHub Copilot déclare des valeurs par défaut limitées à Responses pour sa famille GPT-5 (`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`), car ces modèles rejettent `/chat/completions` pour le trafic des agents. Les modèles sans valeur intégrée par défaut, comme `gpt-5.4-nano`, peuvent être activés ici. Les services en amont à protocole unique et le transfert canonique ChatGPT rejettent ces remplacements. |
| Activation Responses xAI (tableau de bord) | interrupteur | Pour `xai` uniquement, définit ou efface atomiquement les entrées `modelAdapters` de `grok-4.5` et `grok-4.6`. Une seule entrée apparaît comme un état mixte jusqu’à la prochaine écriture. Les autres remplacements et le comportement des tiers restent inchangés. |
| `xaiResponsesXSearch?` | `boolean` | Désactivé par défaut. Sur une destination xAI Responses, ajoute la déclaration `x_search` hébergée par le fournisseur uniquement lorsqu’un outil `web_search` actif subsiste après la normalisation finale de la requête. Les déclarations existantes ne sont pas dupliquées, les sélecteurs `tool_choice`/`allowed_tools` de l’appelant ne sont jamais élargis, et cette option est distincte des options `search.xSearch` du service auxiliaire de recherche web. |
| `modelPreferHostedTools?` | `Record<string,string[]>` | Activation explicite par modèle exact pour les passerelles Responses hors transfert qui réservent un espace de noms aux outils hébergés. Seul `["image_generation"]` est actuellement accepté ; le modèle correspondant doit utiliser le protocole `openai-responses` et prendre en charge cet outil hébergé. Le proxy supprime les déclarations clientes `image_gen` en conflit et réécrit leurs sélecteurs afin de préserver le choix d'outil de l'appelant. Pour les modèles virtuels `-pro` de l'API OpenAI, l'identifiant public sélectionné est comparé en premier et l'identifiant résolu du modèle de base sur le protocole sert de repli. `modelAdapters` résout d'abord l'identifiant public, puis celui de base ; la seconde résolution détermine le protocole final. Les autres modèles conservent le comportement normal des alias. |
| `annotateEmptyToolOutputs?` | `boolean` | Remplace un résultat d’outil présent mais vide par un court marqueur avant qu’il n’atteigne le modèle, afin qu’un résultat vide ne soit pas interprété comme manquant. S’applique aux chaînes vides et aux tableaux de parties contenant uniquement du texte ; les parties d’image, de fichier et chiffrées ne sont jamais modifiées. La valeur par défaut issue du registre intégré est `true` pour DeepSeek ; dans les autres cas, elle n’est pas définie. Définissez `false` pour exclure un fournisseur : une valeur `false` explicite est conservée lors des modifications ultérieures qui omettent ce champ. `PATCH /api/providers?name=<provider>` accepte `true`, `false` ou `null` pour effacer le remplacement et revenir au comportement par défaut du registre. |
| `reasoningEffortMap?` | `Record<string, string>` | Alias ​​de fil à l’échelle du fournisseur pour les étiquettes de raisonnement. |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | Alias ​​de fil par modèle pour les étiquettes de raisonnement. |
| `reasoningWireFormat?` | `"gateway-object"` | Pour les passerelles compatibles avec OpenAI qui acceptent `reasoning: { enabled, effort }` au lieu de `reasoning_effort`. Le préréglage ClinePass définit ce champ automatiquement. |
| `noReasoningModels?` | `string[]` | Modèles qui rejettent les paramètres reasoning/thinking. |
| `noTemperatureModels?` | `string[]` | Modèles qui rejettent `temperature` spécifié par l’appelant. |
| `noTopPModels?` | `string[]` | Modèles qui rejettent `top_p` spécifié par l’appelant. |
| `noPenaltyModels?` | `string[]` | Modèles qui rejettent les pénalités presence/frequency. |
| `noStructuredOutputModels?` | `string[]` | ID de modèle exact dont le point final `openai-chat` rejette `response_format`. Seule une correspondance exacte du modèle demandé omet le champ ; la traduction à sortie structurée reste activée pour tous les autres modèles `openai-chat`. |
| `parallelToolCalls?` | `boolean` | Contrôler les appels d’outils parallèles. Pour `openai-chat`, ils sont activés par défaut ; `false` envoie explicitement `parallel_tool_calls: false`. Les autres adaptateurs ne les annoncent que lorsque la valeur vaut explicitement `true`. |
| `terminalContinuationGuard?` | `boolean` | Active, pour un fournisseur `openai-chat`, une relance interne bornée lorsqu’un tour exploitable annonce une action puis s’arrête proprement sans appel d’outil. La valeur par défaut est `false`, et une valeur explicite `false` équivaut à l’absence du champ. Les tentatives de combinaison et les tours de compactage routés sont exclus ; les autres adaptateurs ignorent cette option. |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean; repairInvalidIds?: boolean }` | Réparation SSE en aval désactivée par défaut pour les identifiants d'espace réservé exacts, les identifiants de terminal manquants et (avec `repairInvalidIds`) les identifiants message/reasoning manquant du préfixe canonique `msg_`/`rs_`. Les identifiants d’appel de fonction ne sont jamais réécrits. Le DeepSeek intégré active les deux derniers par défaut. |
| `responsesSnapshotRepair?` | `boolean` | Réparation côté client désactivée par défaut pour les instantanés du cycle de vie des réponses clairsemés dans SSE et JSON. Remplit les métadonnées d'état canonique, de sortie et d'outil manquantes tandis que l'inspection brute et la persistance restent inchangées. |
| `retryOn429?` | `{ enabled?: boolean; attempts?: number; intervalMs?: number; maxIntervalMs?: number; respectRetryAfter?: boolean }` | Fournisseurs à clé API uniquement (`authMode: "key"`). Nouvelle tentative facultative sur la même cible après un 429 : lorsque `retryOn429` est absent, la fonctionnalité est désactivée ; la présence d'un objet l'active, sauf avec `enabled: false`. Après un 429, le proxy attend selon `Retry-After` reçu en amont ou selon l'intervalle fixe, puis relit la requête à l'identique avec la même clé avant tout basculement de clé. Ce comportement couvre la boucle principale de récupération d'un tour textuel, le protocole de transfert Responses, le pont d'images et de vidéos, le service auxiliaire de recherche Web et les continuations du terminal. Seules les réponses HTTP 429 reçues avant le début de la diffusion peuvent être relues ; les transports `runTurn` personnalisés ne font pas partie de la boucle de nouvelle tentative HTTP. `attempts` compte les relectures avec la même clé après le premier 429, soit `attempts` + 1 envois au total, et constitue un budget commun à toute la requête, partagé entre la boucle principale de récupération, la continuation de la garde du terminal et les nouvelles tentatives du pont. L'épuisement de `attempts` arrête uniquement les relectures supplémentaires avec la même clé : le basculement normal de clé ou la gestion de l'erreur finale s'applique ensuite selon les cibles disponibles. Sur le protocole de transfert authentifié par clé, aucun basculement n'est possible ; le 429 final est donc renvoyé sans modification. Codex ne retente jamais lui-même une requête après un 429 : cette option constitue ainsi la seule protection pour les fournisseurs à clé unique. Valeurs par défaut : `enabled: true`, `attempts: 3`, `intervalMs: 5000`, `maxIntervalMs: 60000` (chaque attente est plafonnée à `maxIntervalMs`, lui-même plafonné à 600000), `respectRetryAfter: true`. |
| `transientRetryOn5xx?` | `{ enabled?: boolean; attempts?: number }` | Fournisseurs `openai-chat` authentifiés par clé uniquement. Nouvelle tentative facultative pour les états transitoires reçus en amont avant le début de la diffusion (500, 502, 503, 504, 520, 521, 522) : l'absence de l'option la désactive ; la présence d'un objet l'active, sauf avec `enabled: false`. Ce comportement couvre la requête Responses initiale, la continuation de la garde du terminal, le point de terminaison natif `/v1/chat/completions` et les réémissions liées à la récupération après un 429 ou à la récupération de compte. `attempts` représente le nombre TOTAL d'envois en amont autorisés pour une requête, premier envoi compris (de 1 à 10, valeur par défaut : 3). Il constitue un budget commun à la requête, partagé avec la récupération après une réinitialisation de connexion ; ainsi, `3` signifie qu'au plus trois requêtes réelles atteignent le fournisseur. Les attentes utilisent une temporisation exponentielle à base fixe de 400 ms, plafonnée à 5 s, et respectent `Retry-After`. Cette option est distincte de `retryOn429`, qui traite la limitation de débit ; les échecs en cours de diffusion ne sont jamais relus. |
| `autoToolChoiceOnlyModels?` | `string[]` | Modèles dont `tool_choice` accepte uniquement `auto` ou `none` ; les choix forcés sont dévalorisés. |
| `preserveReasoningContentModels?` | `string[]` | Modèles nécessitant un assistant préalable `reasoning_content` dans l'historique des discussions. |
| `requiresReasoningPlaceholderModels?` | `string[]` | Modèles dont le service en amont rejette une continuation tool_call dépourvue de `reasoning_content`, notamment en mode de réflexion DeepSeek ; un contenu de remplacement minimal est injecté en cas d'absence dans le cache de relecture. La valeur par défaut est `preserveReasoningContentModels` ; définissez `[]` pour désactiver ce comportement. |
| `thinkingToggleModels?` | `string[]` | Modèles de conversation qui utilisent `thinking.enabled` plutôt qu'une échelle d'effort. |
| `thinkingBudgetModels?` | `string[]` | Modèles de conversation utilisant l'entier `thinking_budget` ; l'effort correspond à une fraction du budget. |
| `noVisionModels?` | `string[]` | Modèles limités au texte, acheminés par le service auxiliaire de vision ; la correspondance tolère une balise Ollama `:size`. |
| `escapeBuiltinToolNames?` | `boolean` | Échapper aux noms d'outils intégrés pour les passerelles compatibles Anthropic et les restaurer lors des appels renvoyés. |
| `anthropicEofTolerance?` | `boolean` | Laissez une passerelle compatible Anthropic compléter un flux qui se termine avant `message_stop`, uniquement lorsque du texte visible ou une entrée complète d'outil d'objet JSON a été reçue. Désactivé par défaut. |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Mode Google transport/auth. Par défaut `ai-studio`. |
| `project?` | `string` | ID du projet Vertex ou Antigravity Cloud Code Assist. |
| `location?` | `string` | Région Vertex ; la valeur de repli de l'environnement est `GOOGLE_CLOUD_LOCATION`. |
| `mcpServers?` | `Record<string, CursorMcpServerConfig>` | Cursor uniquement : serveurs MCP sur entrée-sortie standard ou HTTP diffusé en continu. |
| `desktopExecutor?` | `DesktopExecutorConfig` | Cursor uniquement : commandes externes d'utilisation d'un ordinateur et d'enregistrement de l'écran. |
| `unsafeAllowNativeLocalExec?` | `boolean` | Ancien booléen de Cursor, équivalent à `nativeLocalExec: "on"` uniquement lorsque le champ plus récent n'est pas défini. |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | Politique d'exécution locale de Cursor. `off` est la valeur par défaut ; actuellement, `codex-sandbox` échoue de manière sûre comme `off`. |

Les fournisseurs à clé API peuvent détenir une clé littérale ou une référence à une variable d'environnement. Les fournisseurs OAuth utilisent le
magasin d'identifiants alimenté par `ocx login` ; le comportement de lancement de Claude Code avec abonnement est
configuré sous [`claudeCode.authMode`](/fr/reference/configuration/server/#claude-code-claudecode).

## Sécurité des connexions sortantes de diagnostic des fournisseurs

Les tests de connexion du tableau de bord et la découverte dynamique des modèles utilisent un transport borné, limité aux requêtes GET. Sans
proxy sortant, opencodex résout le nom d'hôte une seule fois et se connecte exclusivement à l'adresse ainsi validée.
HTTPS conserve l'hôte d'origine, le SNI et la vérification du certificat ; la configuration du fournisseur ne peut pas désactiver
ces contrôles.

Lorsque `HTTP_PROXY`, `HTTPS_PROXY` ou `ALL_PROXY` s'applique, ces opérations conservent la fonction de récupération native de Bun.
Les vérifications de l'URL et de l'adresse littérale sont toujours exécutées, mais le proxy choisit la route finale, la réponse DNS et l'homologue ;
opencodex ne peut donc ni épingler ni vérifier cet homologue. Il s'agit d'une limitation de sécurité explicite.

Les destinations privées ou locales nécessitent `allowPrivateNetwork: true` et, lorsqu'un proxy sortant est actif,
une entrée `NO_PROXY` correspondante. Le bouclage est ajouté automatiquement ; indiquez explicitement chaque hôte du réseau local, car
les entrées CIDR ne sont pas interprétées. Le mécanisme de correspondance prend en charge les hôtes exacts, les suffixes de domaine, les ports facultatifs,
les adresses IPv6 entre crochets et `*` ; par exemple, indiquez explicitement `192.168.1.50`. Les destinations de métadonnées et de liaison locale
restent bloquées. Les requêtes de diagnostic rejettent les redirections et signalent une cible dont les identifiants ont été retirés. L'examen des
redirections des requêtes ordinaires vers les fournisseurs reste distinct de cette protection de diagnostic.

## Groupe de comptes Codex

Utilisez **Codex Auth** dans le tableau de bord pour ajouter des comptes au groupe et actualiser les quotas. `config.json` stocke les
métadonnées non secrètes ; les jetons d'accès et d'actualisation utilisent le magasin d'identifiants renforcé. Le routage du pool
distingue l'affectation des requêtes nouvelles ou non liées, la commutation proactive fondée sur l'utilisation et la récupération après incident. Une tâche liée
conserve normalement son affinité, mais `quota` peut la relier lors de sa requête suivante une fois le seuil d'utilisation
franchi ; la suspension, la temporisation, la réauthentification et la gestion des échecs peuvent, indépendamment, effacer ou déplacer son routage.
Une requête non liée ne possède aucune liaison active à un compte ; il peut s'agir d'une tâche existante visible après le redémarrage
du proxy ou la réinitialisation de l'affinité. Un 429 ou un 402 reçu avant le début de la diffusion déclenche une nouvelle tentative unique sur un
autre compte admissible au sein de la même requête, même lorsque la commutation proactive fondée sur l'utilisation est désactivée. Les changements de
compte préservent et relisent le contexte de la conversation, mais la réutilisation du cache d'invites du fournisseur entre plusieurs
comptes n'est pas garantie et le cache peut devoir être réchauffé.

Lors d'un **401/403**, la connexion de l'application efface l'affinité de ce compte, locale au processus, et impose une réauthentification.
Lors d'un **429**, opencodex respecte `Retry-After`, place le compte en temporisation, efface l'affinité et peut
réacheminer la requête vers un autre compte admissible du pool. Ces transitions après échec restent actives avec
`autoSwitchThreshold: 0` ; ce paramètre désactive uniquement la commutation proactive basée sur l’utilisation.

La suspension d'un compte préserve ses métadonnées de quota, mais l'exclut de la commutation, du basculement, des sondes de récupération
et de l'activation manuelle. Elle efface également les affinités de tâche de ce compte. Les requêtes en cours conservent
les identifiants capturés ; les tours ultérieurs sont réacheminés. Si tous les comptes sont suspendus, le routage du pool échoue
au lieu d'en choisir un silencieusement. **Suspendre les comptes épuisés** actualise les comptes admissibles dont les identifiants sont disponibles
et suspend uniquement ceux dont l'utilisation vient d'être confirmée à 100 % ; les actualisations inconnues ou échouées ne changent rien.

| Stratégie | Comportement |
| --- | --- |
| `quota` (par défaut) | S'il n'existe aucun compte actif, choisir le compte admissible le moins utilisé selon les fenêtres de 5 heures, d'une semaine et de 30 jours. Sinon, conserver un compte actif admissible sous `autoSwitchThreshold` ; une fois le seuil franchi, une requête non liée ou la requête suivante d'une tâche liée peut être déplacée vers un compte admissible moins utilisé. `0` désactive cette réévaluation fondée sur l'utilisation, mais pas la récupération après incident. |
| `round-robin` | Répartit uniformément les requêtes non liées entre les comptes admissibles. `autoSwitchThreshold` ne modifie pas la sélection circulaire normale. `accountPoolStickyLimit` (1–100) compte les affectations effectuées avec une même sélection, et non les réponses réussies en amont. |
| `fill-first` | Attribue les requêtes non liées au compte actif jusqu'à sa temporisation, sa réauthentification ou le seuil d'évacuation configuré ; une utilisation inconnue n'impose pas de changement. Les tâches liées et saines conservent leur affinité. |

La rotation ne protège pas contre l’application des règles par les fournisseurs ; l'utilisation de plusieurs comptes peut enfreindre les conditions du fournisseur.

### `anthropicAccountPool` (expérimental)

Cette option regroupe plusieurs comptes OAuth Anthropic déjà stockés dans `auth.json`. Elle est désactivée par
défaut et n'a pas encore été éprouvée en production. Les comptes d'une même organisation peuvent partager un quota, et la
rotation automatique peut déclencher des restrictions du fournisseur.

| Clé | Type | Par défaut | Description |
| --- | --- | --- | --- |
| `anthropicAccountPool.enabled?` | `boolean` | `false` | Active l'affinité persistante et le basculement après une temporisation 429. |
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | Pour les nouvelles sessions, lorsque le compte actif atteint ce seuil, choisir la plus faible utilisation connue et mise en cache dans la fenêtre configurée. `0` désactive la sélection selon le quota. |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | Stratégie des nouvelles sessions ; `quota` classe les comptes selon la fenêtre définie par `quotaWindow`, par défaut les barres sur 5 heures, et `fill-first` évalue son seuil d'évacuation dans cette même fenêtre. |
| `anthropicAccountPool.quotaWindow?` | `"five-hour" \| "weekly" \| "max-utilization"` | `"five-hour"` | Barre d'utilisation signalée par le fournisseur, mise en cache et utilisée pour la sélection selon l'utilisation. `five-hour` conserve le comportement actuel. `weekly` utilise la barre hebdomadaire et ignore les comptes dont la barre sur 5 heures est épuisée tant qu'un autre compte admissible reste disponible, mais y revient si aucun autre ne reste. `max-utilization` utilise la valeur connue la plus élevée et peut donc employer la barre sur 5 heures avant que la barre hebdomadaire soit disponible ; si aucune n'est connue, le compte suit l'ordre des utilisations inconnues. Les utilisations connues précèdent les inconnues, mais si tous les comptes admissibles sont inconnus, la sélection en renvoie tout de même un dans leur ordre admissible. Après le départage documenté par la plus faible utilisation sur 5 heures, une égalité exacte conserve cet ordre. Une session saine avec affinité n'est pas rééquilibrée de manière proactive. Pour l'affectation des nouvelles sessions et la reprise du routage après un remplacement admissible à la suite d'un 429, `quota` classe directement les candidats admissibles avec cette fenêtre ; `fill-first` avance dans un ordre stable selon le seuil et les règles d'épuisement de cette fenêtre ; `round-robin` l'ignore. Le délai de récupération, les limites de basculement et l'éligibilité de réauthentification restent des états locaux distincts. Les barres hebdomadaires ne sont connues qu'après leur interrogation dans la page Fournisseurs du tableau de bord. |
| `anthropicAccountPool.stickyLimit?` | `number` | `1` | Liaisons de nouvelle session réussies conservées sur une sélection à tour de rôle. Portée 1–100. |

Lorsque cette option est activée, un 429 enregistre une temporisation bornée à partir de `Retry-After` ou d'un délai de repli, puis peut
faire basculer la requête vers un autre compte. L'affinité est locale au processus et de taille bornée. Un 401/403 lié aux identifiants marque le compte
comme devant être réauthentifié. Si tous les comptes admissibles sont en temporisation, les clients reçoivent un 429 accompagné de
`Retry-After` lorsqu'il est connu, et non une erreur d'authentification.

:::caution[Expérimental]
Laissez cette option désactivée, sauf si vous comprenez les risques liés aux règles d'Anthropic concernant les comptes. En cas de doute,
préférez le changement manuel avec `ocx account use anthropic <id>`.
:::

### Formes d'enregistrement gérées

Les entrées `apiKeys[]` contiennent les chaînes `id`, `name`, la valeur `key` générée et la date ISO `createdAt`.
Les entrées `codexAccounts[]` exigent `id`, `email` et `isMain` ; `plan`,
`chatgptAccountId` et le libellé confidentiel `logLabel` sont facultatifs. Ces enregistrements sont normalement gérés depuis le tableau de bord.

### `tokenGuardian` (`OcxTokenGuardianConfig`)

| Champ | Type | Par défaut | Signification |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Commutateur global d’actualisation proactive. |
| `tickSeconds?` | `number` | `21600` | Intervalle de balayage (6 heures, minimum 60 secondes). |
| `jitterSeconds?` | `number` | `300` | Délai aléatoire avant un balayage. |
| `concurrency?` | `number` | `3` | Actualisations simultanées maximales. |
| `leadSeconds?` | `number` | `900` | Délai d’actualisation supplémentaire au-delà d’un tick. |
| `failureBackoffBaseSeconds?` | `number` | `300` | Délai initial après un échec transitoire. |
| `failureBackoffMaxSeconds?` | `number` | `3600` | Plafond du délai d'attente et délai après un échec permanent. |
| `codexWarmupEnabled?` | `boolean` | `false` | Active la validation synthétique des comptes du pool Codex. |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | Revalidez un compte après 8 jours. |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | Modèle natif utilisé pour l'échauffement facultatif. |

## Points de terminaison du fournisseur fixes

Le routage résout le point de terminaison du fournisseur avant l'adaptateur. Pour la plupart des fournisseurs intégrés, le point de terminaison du registre
prime sur la valeur `baseUrl` configurée. Quatre types d'entrée conservent l'URL configurée :

- Fournisseurs compatibles : `ollama`, `vllm`, `lm-studio`, `litellm`, `qwen-cloud` et
  `alibaba-token-plan-intl` ;
- les modèles de registre renseignés par l'utilisateur, comme `azure-openai` et `cloudflare-ai-gateway` ;
- la promotion des préréglages fixes à clé API, qui préserve une ancienne destination personnalisée portant le même nom ;
- les fournisseurs absents du registre.

Les adaptateurs peuvent ensuite ajuster l'URL résolue. Kiro, par exemple, suit la région API des identifiants importés
pour construire l'adresse canonique `runtime.{region}.kiro.dev`. Consultez [Adaptateurs](/fr/reference/adapters/).

Lorsque le routage ignore `baseUrl`, opencodex consigne le point de terminaison du registre et uniquement l'origine configurée ;
un chemin configuré peut lui-même contenir un identifiant. Supprimez l'URL inutilisée ou choisissez l'entrée de fournisseur
correspondant à la région prévue. `alibaba-token-plan` est épinglé à Pékin, tandis que
`alibaba-token-plan-intl` couvre les paramètres internationaux.

Pour une passerelle `openai-responses` non conforme, la réparation se configure dans l'objet du fournisseur :

```json
{
  "providers": {
    "custom-gateway": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "${GATEWAY_KEY}",
      "responsesItemIdRepair": {
        "reasoning": ["rs_0"],
        "message": ["msg_0"],
        "repairMissingTerminalIds": true
      }
    }
  }
}
```

Les listes de valeurs de remplacement utilisent des correspondances exactes. Laissez le champ non défini pour les fournisseurs Responses
ordinaires ou avec état afin que le transfert reste strictement identique, octet par octet.

## Fournisseur Cursor (`adapter: "cursor"`)

Le pont Cursor est expérimental. Après `ocx login cursor`, ajoutez ou modifiez `providers.cursor`.
L'échelle d'optimisation du routeur Cursor est exposée sous forme d'identifiants Codex distincts, car le sélecteur ne peut pas afficher
les paramètres de modèle propres à Cursor :

| Modèle Codex | Mode du routeur Cursor |
| --- | --- |
| `cursor/auto` | Valeur par défaut de l'équipe ou du compte |
| `cursor/auto-cost` | Coût |
| `cursor/auto-balance` | Solde |
| `cursor/auto-intelligence` | Intelligence |

Les variantes explicites envoient le modèle `default` de Cursor avec son paramètre `optimization`, ce qui préserve la
sélection à chaque requête. Elles restent disponibles lorsque la découverte en direct omet `default`.

### Vision

La vision native Cursor utilise `SelectedImage` (plafond JPEG souple + `blobIdWithData`) pour les modèles
qui voient les images nativement — Claude, Gemini, GPT, Kimi et Grok notamment — à partir des images
`data:` du tour actif uniquement. Les images des tours précédents rejouent comme marqueurs texte
`[image attached]` ; les images distantes ou indécodables deviennent des marqueurs d’omission.
Auto, la famille Composer et GLM (`glm-5.2`, `glm-5.3`) restent
sur la liste curatée `noVisionModels` et passent par le sidecar de description d'images.

Les outils locaux pilotés par le serveur Cursor sont désactivés par défaut. Codex continue d'utiliser ses propres outils tels que
`apply_patch` et `exec_command` avec sa propre politique d'approbation et de bac à sable :

- `"off"` (par défaut) rejette l'exécution des outils Cursor natifs `read`, `write`, `delete`, `ls`, `grep`, `shell` et
  `fetch`.
- `"on"` active une exécution locale de confiance et contourne les règles d'approbation et de bac à sable de Codex.
- `"codex-sandbox"` est conservé pour compatibilité, mais échoue de manière sûre comme `"off"` ; le texte de la requête
  ne constitue pas une attestation fiable d'exécution en bac à sable.

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "nativeLocalExec": "off"
    }
  }
}
```

Définissez le champ dans `providers.cursor`, et non au premier niveau. Dans le tableau de bord, utilisez **Fournisseurs → Cursor
→ Modifier le JSON**, enregistrez, puis redémarrez. L'ancien réglage `unsafeAllowNativeLocalExec: true` équivaut à
`nativeLocalExec: "on"` uniquement lorsque `nativeLocalExec` n'est pas défini. MCP, l'enregistrement d'écran et le contrôle de l'ordinateur
sont contrôlés séparément par `mcpServers` et `desktopExecutor`.

Chaque `mcpServers.<name>` accepte soit `command` pour l'entrée-sortie standard, soit `url` pour HTTP diffusé en continu. Le premier mode
accepte aussi `args`, `env` et `cwd` ; HTTP accepte `headers`. Les deux prennent en charge `enabled` (`true` par défaut) et
`toolPrefix`. `desktopExecutor` accepte `computerUseCommand`, `recordScreenCommand`, `cwd`, `env`,
et `timeoutMs` (`30000` par défaut). Les commandes s'exécutent avec `sh -c`, lisent une requête JSON depuis l'entrée standard
et doivent écrire un résultat JSON sur la sortie standard.

:::caution[Sécurité]
La liaison à l'interface de bouclage par défaut accepte tout processus local sans authentification, y compris ceux d'autres utilisateurs sur un
hôte partagé. Laissez l'exécution locale désactivée, sauf si tous les appelants du plan de données sont fiables et si vous
acceptez le contournement des autorisations Codex et de la sémantique du bac à sable.
:::

## Routage des fournisseurs OpenRouter

OpenRouter peut servir un modèle au moyen de plusieurs fournisseurs d'inférence. `openRouterRouting` maintient les
requêtes chez les fournisseurs privilégiés ; `modelOpenRouterRouting` remplace ce réglage pour les identifiants de modèle exacts. Cette option
facilite l'affinité avec le cache rapide, car la prise en charge et la conservation du cache, les taux de réussite et les prix varient selon le
fournisseur d'inférence.

Les noms de fournisseurs sont les identifiants courts d'OpenRouter. Avec `allowFallbacks: false`, l'opération échoue de manière sûre ;
`true` autorise un autre fournisseur admissible après épuisement de la liste ordonnée. `only` est toujours une liste d'autorisation.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "openRouterRouting": {
        "order": ["deepseek"],
        "allowFallbacks": false
      },
      "modelOpenRouterRouting": {
        "anthropic/claude-sonnet-5": {
          "only": ["anthropic"],
          "allowFallbacks": false
        }
      }
    }
  }
}
```

Les clés de modèle sont les identifiants OpenRouter natifs exacts, sans le préfixe externe du fournisseur opencodex. La sélection de
`openrouter/anthropic-claude-sonnet-5` restaure l'identifiant natif `anthropic/claude-sonnet-5` avant d'appliquer
la règle du modèle.

## Routage des fournisseurs Vercel AI Gateway

Vercel AI Gateway peut router un modèle entre plusieurs fournisseurs d'inférence sous-jacents.
`vercelGatewayRouting` configure les préférences à l'échelle du fournisseur ; `modelVercelGatewayRouting` les remplace
pour les identifiants de modèle exacts. Lorsque les deux sont omis, `resolveVercelGatewayRouting()` renvoie `undefined`.
Les générateurs de requêtes Chat omettent alors le champ `provider`, et Vercel AI Gateway conserve son comportement de
routage dynamique par défaut.

- `order` : identifiants courts des fournisseurs en amont de Vercel AI Gateway, par ordre de priorité.
- `only` : liste d'autorisation explicite limitant les fournisseurs en amont de Vercel AI Gateway admissibles.
- `sort` : trie automatiquement les fournisseurs admissibles par `"cost"` (coût le plus faible), `"ttft"` (délai
  avant le premier jeton) ou `"tps"` (jetons par seconde).

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "adapter": "openai-chat",
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "${VERCEL_AI_GATEWAY_KEY}",
      "vercelGatewayRouting": {
        "sort": "ttft"
      },
      "modelVercelGatewayRouting": {
        "zai/glm-5.2": {
          "only": ["novita", "deepinfra"],
          "order": ["novita", "deepinfra"]
        }
      }
    }
  }
}
```

Les clés de modèle sont les sélecteurs de modèle publics de Vercel, sans le préfixe externe du fournisseur OpenCodex.
La sélection de `vercel-ai-gateway/zai-glm-5.2` restaure l'identifiant natif `zai/glm-5.2` avant d'appliquer la règle du
modèle. Le même mappage s'applique à un sélecteur natif `vercel/<model-id>` : utilisez le sélecteur encodé
`vercel-ai-gateway/vercel-<model-id>` dans OpenCodex et conservez `vercel/<model-id>` comme clé de modèle.

## Listes autorisées de modèles statiques

Réglez `liveModels: false` pour exposer uniquement `models`. Si `models` est vide ou omis, le fournisseur n'expose
aucun modèle routé. La découverte dynamique rejette plus de 4 Mio ou 2 000 lignes de modèle brutes avant leur mise en cache ;
les préréglages intégrés peuvent appliquer des limites inférieures et filtrer les lignes admissibles à la conversation. Les résultats trop volumineux ou mal formés
utilisent le catalogue obsolète ou configuré comme solution de repli. Un résultat valide ne contenant aucun modèle admissible fait autorité et n'est pas
silencieusement remplacé ou tronqué.

Utilisez `selectedModels` lorsque la découverte doit toujours s'exécuter mais que seuls les identifiants sélectionnés doivent apparaître dans Codex et
`/v1/models`. Le tableau de bord conserve la liste complète découverte pour les modifications ultérieures de la liste autorisée.

Les entrées de repli de l'aperçu GPT-5.6 utilisent le même mécanisme. Le préréglage à clé API OpenAI initialise les identifiants de base et Pro
avec un contexte de `922000` et une entrée maximale de `922000` ; OpenRouter initialise `openai/gpt-5.6-sol`,
`openai/gpt-5.6-terra` et `openai/gpt-5.6-luna` avec le contexte `922000`. Les modes pool et direct annoncent
`922000` ; le catalogue synchronisé annonce `max` tout en gardant `xhigh` distinct.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

## Exemple complet

```json
{
  "port": 10100,
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward"
    },
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "glm-5.3", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  },
  "subagentModels": ["anthropic/claude-opus-5", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 60000
  },
  "visionSidecar": { "enabled": true }
}
```
