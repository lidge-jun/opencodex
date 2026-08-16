---
title: Fournisseurs
description: Toutes les méthodes utilisées par opencodex pour s'authentifier auprès d'un fournisseur de LLM et communiquer avec lui — OAuth, clé API, transfert ChatGPT et exécution locale.
---

Un **fournisseur** associe un point de terminaison LLM en amont à la façon de l'atteindre : un adaptateur,
une URL de base, un mode d'authentification et, facultativement, une liste de modèles. Les fournisseurs sont
définis sous `providers` dans `~/.opencodex/config.json`.

## Modes de compte OpenAI

| Identifiant du fournisseur | Utilisation | Règle relative aux identifiants et aux comptes |
| --- | --- | --- |
| `openai` | Connexion Codex | Pool (par défaut) sélectionne le compte principal et les comptes ajoutés ; Direct utilise uniquement la connexion de l'appelant ou du compte principal actuel. |
| `openai-apikey` | API OpenAI | Utilise exclusivement la clé API ou le pool de clés configuré ; ne lit jamais les comptes Codex. |

Utilisez l'identifiant non qualifié `gpt-5.6-sol` avec l'option Pool/Direct de la page **Fournisseurs**, ou
`openai-apikey/gpt-5.6-sol` pour l'API. Ces routes d'authentification ne se rabattent jamais l'une sur l'autre.
La route API publie des métadonnées indiquant un contexte de 1 050 000 jetons et une entrée maximale de
922 000 jetons. Ses identifiants virtuels `sol-pro`, `terra-pro` et `luna-pro` conservent l'identité publique
sélectionnée, tandis que la requête transmise emploie le modèle de base avec `reasoning.mode: "pro"`.

Si le fournisseur `openai` intégré est absent ou désactivé, le sélecteur de comptes du tableau de bord et la
page **Authentification Codex** peuvent le restaurer : une ligne absente est créée depuis le préréglage
canonique, une ligne canonique désactivée est réactivée sans remplacer le mode ni les réglages de modèle
enregistrés, et ce parcours de récupération n'est pas proposé aux lignes `openai` non canoniques.

### Aperçu de la capacité du pool des fournisseurs

Pour la connexion Codex en mode Pool, la vue d'ensemble des fournisseurs affiche une estimation pondérée,
d'après les poids configurés, de la capacité utilisée du pool, au lieu de présenter un compte arbitraire
comme total du fournisseur. La même ligne indique également le pourcentage brut du quota du compte effectif
actuel, afin de distinguer l'estimation du pool du compte qu'utiliserait une nouvelle requête.

Lorsque les informations de réinitialisation sont disponibles, la vue d'ensemble indique l'heure de la
prochaine réinitialisation et la capacité qu'elle devrait restituer sous la forme `+N% pool capacity`.
**Couverture incomplète** signifie qu'un ou plusieurs comptes du pool ne peuvent pas contribuer de manière
sûre à l'estimation, par exemple parce que leur forfait ou leur quota est inconnu, que leur mesure est
périmée, ou que le compte est suspendu ou doit être réauthentifié.

Un avertissement de **couverture partielle des fenêtres** signifie que certains comptes inclus ont signalé
une fenêtre de quota, mais pas une autre. La vue d'ensemble conserve ces fenêtres séparément et marque comme
incomplète chaque fenêtre concernée, au lieu d'assimiler la mesure absente à de l'utilisation.

Cette estimation est destinée uniquement à l'affichage. Elle ne change ni la sélection du compte, ni
l'affinité de session, ni le changement automatique, ni les délais de récupération, ni aucune autre décision de
routage. Consultez le [groupe de comptes d'authentification Codex](/fr/guides/web-dashboard/#authentification-codex-et-groupes-de-comptes)
pour l'état de chaque compte et les contrôles de routage.

Les configurations v1 livrées migrent automatiquement vers le marqueur 2 et une ligne tenant compte de
l'option choisie. La configuration d'origine est conservée une fois dans
`~/.opencodex/config.json.pre-openai-tiers-v2.bak` ; restaurez-la avec
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`.

## Modes d'authentification

Les configurations de fournisseurs acceptent trois valeurs `authMode` (`key` est la valeur par défaut). Le
registre intégré classe séparément les préréglages locaux ; ceux-ci omettent normalement `authMode` et `apiKey`.

| `authMode` | Méthode d'authentification | Utilisé par |
| --- | --- | --- |
| `key` | Envoie votre clé API (`Authorization: Bearer …`, ou `x-api-key` / `api-key` par adaptateur). La clé peut être un littéral ou une référence `${ENV_VAR}`. | La plupart des fournisseurs. |
| `forward` | Transmet **à l'identique vos en-têtes d'authentification Codex entrants** au fournisseur, sans enregistrer de clé. Il s'agit du transfert de la connexion ChatGPT. | OpenAI (adaptateur `openai-responses`). |
| `oauth` | Résout un jeton d'accès OAuth enregistré — automatiquement actualisé avant son expiration — et l'utilise comme jeton porteur. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, Command Code, GitHub Copilot, Nous Portal. |

La relance d'une requête 429 avec la même clé, configurée par
[`retryOn429`](/fr/reference/configuration/), s'applique uniquement aux fournisseurs à clé API
(`authMode: "key"`). Les préréglages OAuth, de transfert et locaux sont exclus : leurs identifiants ne doivent
jamais être réutilisés sur le même jeton, et les environnements locaux ne possèdent aucune clé distante à
préserver. Cette fonction est facultative : elle est désactivée lorsque l'option est absente ; la présence de
l'objet l'active, sauf si `enabled: false`.

## 1. Connexion ChatGPT (transfert direct)

Le fournisseur `openai` ne nécessite **aucune clé API**. Direct transfère les identifiants de votre
`codex login` existant ; Pool résout d'abord un compte Codex principal ou ajouté, puis utilise le même serveur :

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

Seul un ensemble sélectionné d'en-têtes est transmis (`FORWARD_HEADERS` : autorisation, identifiant de
compte ChatGPT, bêta/originator/session OpenAI — voir [Adaptateurs](/fr/reference/adapters/)). Ce parcours
alimente aussi les [services auxiliaires de recherche web et de vision](/fr/guides/sidecars/).

Le catalogue du transfert ChatGPT ajoute également les identifiants non qualifiés GPT-5.6 Sol/Terra/Luna
(`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) pour les comptes qui peuvent les utiliser.

## 2. Connexion au compte (OAuth)

Huit préréglages de fournisseurs utilisent une connexion OAuth. GitHub Copilot s'y ajoute au moyen d'un pont
expérimental et non officiel reposant sur un flux d'autorisation d'appareil. opencodex enregistre leurs identifiants dans
`~/.opencodex/auth.json` et les actualise automatiquement. La CLI de connexion accepte également `chatgpt` ;
elle obtient un identifiant ChatGPT tout en créant une entrée de fournisseur en mode `forward`.

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login nous         # Nous Portal (device grant; free + paid models)
ocx login kiro         # import kiro-cli credentials (or token fallback)
ocx login google-antigravity
ocx login cursor       # standalone Cursor PKCE login
ocx login command-code # Command Code browser OAuth (or import ~/.commandcode/auth.json)
ocx login github-copilot  # GitHub device flow → Copilot token (Copilot Pro/Business)
ocx login chatgpt      # standalone ChatGPT OAuth login
ocx logout <provider>
```

| Fournisseur | Adaptateur | URL de base | Remarques |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | Catalogue Grok découvert en direct en priorité ; `grok-4.5` est le modèle de repli par défaut. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Modèles Claude ; liste des modèles récupérée en direct depuis `/v1/models`. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Modèles de programmation Kimi K2.7/K2.6/K2.5. |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Passerelle d'abonnement Nous Research (le même service en amont que celui utilisé par Hermes Agent). Connexion par autorisation d'appareil auprès de `portal.nousresearch.com` ; le jeton d'accès est le JWT d'inférence envoyé avec chaque requête. Le catalogue mixte de modèles payants et `:free` (`tencent/hy3:free`, `stepfun/step-3.7-flash:free`, ...) est découvert en direct pour le compte connecté. Les jetons d'actualisation sont à usage unique et renouvelés à chaque actualisation. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | La connexion initiale importe la session de l'installation locale de `kiro-cli`, déjà authentifiée (sous Unix, installez avec `curl -fsSL https://cli.kiro.dev/install` &#124; `bash`; sous Windows PowerShell, utilisez `irm 'https://cli.kiro.dev/install.ps1'` &#124; `iex`; puis exécutez `kiro-cli login`). **Ajouter un compte** déconnecte `kiro-cli`, lance une nouvelle connexion dans le navigateur qui change le compte utilisé par `kiro-cli`, puis enregistre les métadonnées propres au profil. Les comptes OpenCodex existants sont préservés ; une annulation ou un échec restaure la session `kiro-cli` précédente. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth avec le protocole Cloud Code Assist. La découverte en direct utilise le point de terminaison CCA authentifié `v1internal:fetchAvailableModels` et publie les modèles d'agent accessibles au compte connecté ; le catalogue maintenu reste la solution de repli. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Connexion PKCE expérimentale, transport HTTP/2 en direct et découverte de modèles filtrés par compte. |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | Expérimental. Flux d'appareil GitHub et échange `copilot_internal` (client OAuth de VS Code). Nécessite un abonnement Copilot actif ; il ne s'agit pas d'une API tierce officielle. |

Après un échec définitif d'actualisation de Nous, exécutez `ocx login nous` pour vous réauthentifier.

Pour les préréglages canoniques du forfait Kimi Coding (`kimi` pour la connexion au compte et `kimi-code`
pour la clé API), opencodex ne transmet à la requête Chat Completions qu'un `prompt_cache_key` stable fourni
par l'appelant ; il n'en génère jamais. Selon la documentation de Kimi, une clé de session ou de tâche stable
est nécessaire pour améliorer le taux de succès du cache du Coding Plan ; les requêtes dépourvues de clé le
restent. Si un service en amont explicitement activé rejette ce champ, opencodex ne le retire pas avant de
réessayer et ne modifie pas la configuration enregistrée. Tous les autres fournisseurs le refusent par défaut.

Vous pouvez également démarrer OAuth à partir du [tableau de bord Web](/fr/guides/web-dashboard/).

### Plusieurs comptes OAuth

Les fournisseurs OAuth dont les identifiants comportent un identifiant de compte ou une adresse e-mail stable
peuvent conserver plusieurs connexions. La page **Fournisseurs** affiche ces comptes dans une liste déroulante,
permet d'en ajouter un autre et de changer de compte actif sans déconnecter les autres. Une connexion ordinaire
avec un identifiant Kimi qui ne contient aucune information d'identité remplace l'emplacement actif, tandis que l'action explicite **Ajouter un
compte** préserve cet emplacement et en active un nouveau, distinct. Les comptes Kiro sont indexés par ARN de
profil. `chatgpt` n'utilise toujours qu'un seul emplacement, car les comptes du pool Codex sont gérés dans un
registre distinct. Les jetons restent dans `~/.opencodex/auth.json` ; `/api/oauth/accounts` ne renvoie que des
métadonnées masquées.

### Importation Cockpit Tools Antigravity

Dans la v1, OpenCodex importe uniquement les exportations JSON **Cockpit Tools Antigravity** destinées au
fournisseur `google-antigravity`. Dans le tableau de bord **Fournisseurs**, sélectionnez le fichier JSON local
depuis l'onglet **Comptes** de ce fournisseur. Le tableau de bord n'affiche ni le contenu du fichier ni les
valeurs des identifiants ; il indique uniquement le nombre d'éléments importés, mis à jour, en échec ou non pris
en charge. Les autres fournisseurs Cockpit sont refusés dans la v1.

La CLI accepte l'exportation uniquement depuis un fichier ou l'entrée standard : ne la collez jamais dans un argument de commande :

```bash
ocx account import google-antigravity --format cockpit-tools --file <path> [--json]
cat accounts.json | ocx account import google-antigravity --format cockpit-tools --stdin [--json]
```

Le JSON en ligne et les arguments positionnels supplémentaires sont refusés. Gardez les fichiers exportés
confidentiels et supprimez-les ou conservez-les de façon sécurisée après l'importation.

### Fiabilité OAuth

opencodex coordonne l'actualisation des jetons et le routage du pool Codex afin que les requêtes simultanées
n'entrent pas en concurrence dans le magasin d'identifiants. Il s'agit d'un mécanisme de fiabilité et de
diagnostic : il ne garantit **aucune** protection contre l'application des règles du fournisseur, les limites
de débit ou les mesures prises à l'encontre d'un compte.

**Coordination de l'actualisation.** Avant un appel routé, un jeton d'accès expiré est actualisé une fois par
`(provider, account)` :

1. Appel unique dans le processus : les appelants simultanés partagent la même promesse d'actualisation.
2. Verrouillage de fichier par compte : les écritures provenant de plusieurs processus sont sérialisées pour un même compte.
3. CAS de génération : les données ne sont enregistrées que si la génération des identifiants stockés correspond
   toujours. Une écriture plus récente l'emporte ; le résultat d'une actualisation antérieure ne peut pas l'écraser.

Les échecs définitifs d’actualisation signalent que le compte doit être réauthentifié, au lieu de relancer
indéfiniment la même opération.

**Délais de récupération du pool Codex.** Une réponse `429` ou un dépassement de quota en amont impose un délai
de récupération strict, déterminé par `Retry-After`, par les en-têtes `reset` du quota — dans la limite du
plafond prévu — ou par un bref délai de repli par défaut. Les comptes soumis à un délai `Retry-After` explicite
ne sont pas sondés avant son expiration. Les délais calculés à partir des informations de réinitialisation
peuvent bénéficier d'une autorisation de sondage cadencée, afin de détecter la reprise sans submerger le
fournisseur. Pour les modèles natifs, ces délais préservent également les groupes de quotas indépendants connus :
`gpt-5.3-codex-spark` n'empêche pas le même compte d'essayer le quota partagé de GPT-5.6 Terra/Luna, tandis
que les modèles de ce groupe partagé continuent de se protéger mutuellement. Les délais `Retry-After` explicites
et les délais par défaut s'appliquent toujours à l'ensemble du compte.

**Affinité de session.** L'affinité entre le fil Codex et le compte est locale au processus — uniquement en mémoire et
non conservée après le redémarrage du proxy. En cas d'échec des identifiants (`401` / `403`), le compte est
mis en quarantaine dans l'attente d'une réauthentification et ses affinités sont effacées. En cas de `429`, le
compte entre en délai de récupération, ses affinités sont effacées et la sélection du pool peut changer : les fils
ne restent pas épinglés après une réponse de limite de débit.

**Métadonnées du client Codex.** Le parcours de transfert ChatGPT laisse passer la liste d'autorisation
sélectionnée `FORWARD_HEADERS` — autorisation, `chatgpt-account-id`, originator, identifiants de session et de
fil, ainsi que les en-têtes Codex associés ; voir [Adaptateurs](/fr/reference/adapters/). Le mode Pool ne
remplace que l'authentification et `chatgpt-account-id` afin qu'ils correspondent à l'identifiant sélectionné.
opencodex ne fabrique **aucune** identité de client officiel, comme les en-têtes `originator`, de session ou
de fil, si l'appelant ne les a pas fournis.

**Diagnostics et réauthentification.** La sortie de `ocx status` destinée aux utilisateurs affiche un bloc d'état OAuth —
identifiants de compte expurgés, aucun jeton. `ocx doctor` ajoute une section sur la fiabilité OAuth, avec des
contrôles du magasin accessible en écriture et de l'appel unique, ainsi que des lignes WARN qui indiquent une
action de récupération. Lorsqu'un compte de fournisseur OAuth doit être réauthentifié, exécutez
`ocx login <provider>` ou utilisez **Réauthentifier** dans le tableau de bord. Les comptes du pool Codex ne
constituent pas un fournisseur `ocx login` : réauthentifiez-les dans le groupe de comptes Codex du tableau de bord. Consultez
[`ocx status` / `ocx doctor`](/fr/reference/cli/) dans la référence CLI.

### Importation des identifiants Kiro

La connexion Kiro nécessite la CLI Kiro : sous Unix, installez-la avec `curl -fsSL https://cli.kiro.dev/install | bash` ;
sous Windows PowerShell, utilisez `irm 'https://cli.kiro.dev/install.ps1' | iex`, puis connectez-vous avec `kiro-cli login`.
En l'absence de session `kiro-cli`, `ocx login kiro` se rabat sur un jeton d'accès collé ou sur la variable
d'environnement `KIRO_ACCESS_TOKEN`.

Le parcours d'importation `ocx login kiro` recherche les magasins de la CLI Kiro propres à la plateforme et
ouvre les bases SQLite en lecture seule. Deux variables d'environnement permettent de sélectionner explicitement
la source et la ligne du jeton :

- `KIROCLI_DB_PATH` sélectionne une base de données Kiro CLI SQLite non standard. Le chemin doit déjà exister ;
  pendant ce chemin d'importation, opencodex ne crée ni ne modifie la base de données, ni les fichiers WAL ou SHM.
- `KIROCLI_TOKEN_KEY` sélectionne la clé de jeton `auth_kv` exacte lorsqu'une base de données contient plusieurs
  lignes de jeton qui seraient autrement ambiguës. En l'absence de sélection, la connexion échoue au lieu de
  choisir arbitrairement.

Sous Windows, l'importation recherche `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`. La connexion forcée ou par
**Ajouter un compte** nécessite également le binaire local de la CLI : opencodex consulte d'abord `PATH`, puis se rabat sur
`%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe` et `C:\Program Files\Kiro-Cli\kiro-cli.exe`.

Après une importation réussie, opencodex conserve les informations d'identification importées dans
`~/.opencodex/auth.json`.
Gardez ces variables et la base sélectionnée confidentielles. Ne joignez ni fichier de base de données ni
diagnostic de connexion brut aux rapports de bogue.

**Ajouter un compte** suit un parcours d'écriture distinct : opencodex crée un instantané de la session en
cours, déconnecte `kiro-cli`, puis importe la nouvelle connexion effectuée dans le navigateur. Si la connexion
est annulée ou échoue, y compris pendant l'enregistrement des identifiants par OpenCodex, la restauration remplace
la base de données de la CLI Kiro et supprime ses fichiers auxiliaires WAL, SHM et journal avant de rétablir
l'instantané de la session précédente.

Comme cette restauration exige un instantané, **Ajouter un compte** refuse de déconnecter `kiro-cli` lorsqu'un
magasin de session existe mais ne peut pas être capturé (fichier illisible, schéma incompatible ou sélection de
jeton ambiguë), lorsque `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` redirigent les lectures d'importation hors du
magasin actif de la CLI, ou lorsqu'une base principale existante de la CLI ne contient aucune ligne de jeton
reconnue. Réparez ou supprimez la base illisible dans le chemin de données normal de `kiro-cli`, désactivez ces
sélecteurs d'importation, puis réessayez. La connexion depuis une machine dépourvue de session `kiro-cli`
existante n'est pas concernée.

## 3. Catalogue des clés API

opencodex fournit 79 préréglages intégrés : 67 à clé, huit OAuth, trois locaux et un préréglage par défaut de
transfert ChatGPT. Dans le tableau de bord, le sélecteur **Ajouter un fournisseur** ouvre le tableau de bord du
fournisseur à clé, valide la clé et l'enregistre ; la validation dépend du fournisseur. Parmi les entrées notables :

**ClinePass** utilise une clé API Cline avec le [catalogue d'abonnement officiel](https://docs.cline.bot/getting-started/clinepass)
et le [point de terminaison Chat Completions](https://docs.cline.bot/api/chat-completions), exploités par Cline Bot Inc. selon
les [conditions de Cline](https://cline.bot/tos). Un identifiant routé tel que `cline-pass/cline-pass/kimi-k3`
est intentionnel : le premier segment sélectionne le fournisseur opencodex, tandis que `cline-pass/kimi-k3`
est l'identifiant complet du modèle envoyé en amont. Le quota ClinePass est partagé par le compte entre des
limites glissantes sur 5 heures, hebdomadaires et mensuelles. Une sonde en direct effectuée le 2026-08-13 a
confirmé que tous les modèles ClinePass statiques acceptent `low`, `medium`, `high`, `xhigh` et `max` à
l'entrée de la passerelle. opencodex conserve les niveaux demandés ; toute normalisation propre au service en
amont reste de la responsabilité de ClinePass.

**Cline** utilise la même clé API et le même point de terminaison, avec une facturation à l'usage pour plus de
100 modèles (identifiants de type OpenRouter, comme `anthropic/claude-sonnet-4-6`). Les modèles gratuits
promotionnels de Cline ne sont accessibles que dans l'IDE ou la CLI Cline, pas par l'API ;
`minimax/minimax-m2.5` est le modèle d'expérimentation gratuite documenté pour l'API.

| Fournisseur | URL de base |
| --- | --- |
| **OpenAI (clé API)** | `https://api.openai.com/v1` |
| **Anthropic (clé API)** | `https://api.anthropic.com` |
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
| Qwen Cloud | Forfait à jetons (par défaut) : `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · Facturation à l'usage : `https://dashscope.aliyuncs.com/compatible-mode/v1` · ou personnalisé |
| Tencent Cloud Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Volcengine Ark · Coding Plan · Agent Plan | `https://ark.cn-beijing.volces.com/api/v3` · `https://ark.cn-beijing.volces.com/api/coding/v3` · `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Xiaomi MiMo (OpenAI Chat) | `https://api.xiaomimimo.com/v1` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …et plus encore | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

**OpenCode Zen** (`opencode-zen`) et le préréglage sans clé **OpenCode Free** utilisent tous deux
`https://opencode.ai/zen/v1`. Sur cette passerelle, les modèles gratuits atteignent souvent une limite de
rafale sur une courte fenêtre, d'environ 15 à 20 requêtes par minute (mesure de la communauté ; OpenCode ne publie
pas de valeur RPM). Zen peut renvoyer des erreurs génériques 429 de limitation de débit sans en-têtes
`Retry-After` / `X-RateLimit-*`. Cette limite est distincte du quota sans clé pour application de bureau
annoncé par OpenCode (environ 200 requêtes Big Pickle ou vers des modèles gratuits toutes les 5 heures sur
`opencode-free`). Lorsque Zen omet `Retry-After` sur une telle réponse 429, opencodex ajoute à l'erreur client
des indications propres au fournisseur ainsi qu'un `Retry-After` synthétique ; un `Retry-After` reçu en amont
reste prioritaire. L'attente et la nouvelle tentative avec la même clé restent facultatives et s'activent avec
[`retryOn429`](/fr/reference/configuration/).

La plupart utilisent l'adaptateur `openai-chat` avec une clé Bearer ; quelques fournisseurs qui n'exposent
qu'un point de terminaison compatible Anthropic, comme **Xiaomi MiMo**, emploient l'adaptateur `anthropic`
(`x-api-key`). Volcengine Agent Plan utilise son point de terminaison Responses natif par `openai-responses`.
Le préréglage DeepSeek intégré route également `deepseek-v4-flash` par son point de terminaison Responses natif
et conserve le streaming SSE en amont. Si ce modèle termine tous les éléments de sortie mais omet l'événement
Responses final, opencodex applique une réparation après un délai de grâce de cinq secondes, limitée à ce
modèle ; les flux mal formés ou partiels sont fermés comme incomplets, et non déclarés réussis.

> **Trois routes de facturation Volcengine :** `volcengine` correspond à l'API Ark facturée à l'usage,
> `volcengine-coding-plan` consomme le quota Coding Plan et `volcengine-agent-plan` le quota Agent Plan.
> Utilisez la clé et le point de terminaison fournis pour le même produit ; le point de terminaison `/api/v3`
> ordinaire peut entraîner une facturation à l'usage même si vous disposez d'un abonnement Plan.
> Les préréglages emploient des catalogues statiques sélectionnés, car la réponse `/models` d'Ark contient aussi
> des ressources d'embedding, d'image, de vidéo et de 3D, la passerelle Coding renvoie le même catalogue étendu,
> et la passerelle Agent Plan ne possède aucune ressource `/models`. Le modèle par défaut de la route facturée à
> l'usage est `doubao-seed-2-1-pro-260628` ; son catalogue sélectionné comprend également les modèles de texte
> DeepSeek et GLM actuels. Coding Plan utilise `ark-code-latest` par défaut, et Agent Plan `deepseek-v4-pro`.

> **Restriction d'utilisation des forfaits Volcengine :** selon la documentation de Volcengine, les quotas
> Coding Plan et Agent Plan ne sont valables que dans les outils de programmation par IA pris en charge. Elle
> avertit que l'utilisation d'une clé de forfait pour des appels API généraux peut entraîner la suspension de
> l'abonnement ou le bannissement du compte. Le routage de Codex ou Claude Code par opencodex correspond à
> l'usage documenté ; l'emploi d'une clé de forfait par une autre automatisation n'en fait pas partie. La route
> `volcengine` facturée à l'usage n'est pas soumise à cette restriction.

**Découverte Chutes.** Le préréglage `chutes` utilise la passerelle LLM compatible OpenAI, fixe et partagée de
Chutes. Il lit le catalogue public `/v1/models`, ne conserve que les lignes dont `supported_features` annonce
`tools`, préserve les identifiants de modèle contenant des barres obliques ainsi que les métadonnées en direct
sûres, et limite la découverte à 256 KiB et 128 lignes brutes. Comme ce catalogue est public, il ne peut pas
prouver la validité d'une clé fournie ; les requêtes de chat utilisent néanmoins la clé Bearer configurée. Les
hôtes Chute personnalisés déployés par l'utilisateur et les API Chutes autres que LLM relèvent toujours d'un
fournisseur personnalisé. Créez une clé depuis le [tableau de bord Chutes](https://chutes.ai/auth/start).

**Découverte DeepInfra.** Le fournisseur `deepinfra` à clé pour OpenAI Chat Completions utilise l'adaptateur
`openai-chat` avec une clé API Bearer. L'URL de liste des modèles appartenant au registre ne conserve que les
lignes étiquetées `chat`, préserve les identifiants natifs contenant des barres obliques et limite la découverte
en direct à 512 KiB et 512 lignes brutes. Créez des clés dans le
[tableau de bord DeepInfra](https://deepinfra.com/dash/api_keys).

**Découverte Hyperbolic.** Le préréglage lit `/v1/models` avec la clé Bearer configurée, préserve les
identifiants natifs contenant des barres obliques et limite la découverte en direct à 256 KiB et 256 lignes
brutes. Il couvre uniquement le chat sans serveur en texte et en vision-langage ; les points de terminaison
distincts de Hyperbolic pour les images, l'audio et les GPU sont hors périmètre. Créez des clés sur
[Hyperbolic](https://app.hyperbolic.ai).

**Découverte Nscale et Vultr.** Les deux préréglages lisent le catalogue `/v1/models` authentifié du fournisseur,
préservent les identifiants natifs et limitent la découverte à 256 KiB et 256 lignes brutes. Le catalogue de
Nscale mélange des modèles de chat, d'image et d'embedding sans champ de modalité ; le préréglage n'admet donc
que `meta-llama/Llama-3.1-8B-Instruct`, modèle employé dans l'exemple officiel d'appel d'outil de l'API Nscale.
Vultr ne documente actuellement l'appel d'outils que pour `kimi-k2-instruct` ; son préréglage n'expose donc que
ce modèle. Les autres lignes restent masquées jusqu'à ce que le fournisseur publie des preuves équivalentes de
prise en charge des outils d'agent. Créez un jeton de service dans la [console Nscale](https://console.nscale.com)
et copiez la clé d'inférence de Vultr depuis la vue d'ensemble de l'abonnement dans la
[console Vultr](https://my.vultr.com).

**Découverte Command Code.** Le préréglage lit la liste `/provider/v1/models` de Command Code depuis l'hôte
fixe de l'API Provider, préserve les identifiants natifs du fournisseur et limite la découverte à 256 KiB et
256 lignes brutes. `ocx login command-code` prend en charge OAuth par connexion dans le navigateur, avec
importation facultative des identifiants locaux depuis `~/.commandcode/auth.json` pour les utilisateurs de la
CLI Command Code. Le catalogue, propre au compte, provient du point de terminaison de découverte authentifié
après la connexion. Les requêtes de chat du préréglage Provider-API `commandcode` utilisent la clé Bearer active
configurée ; le préréglage OAuth `command-code` utilise le jeton Bearer du compte enregistré pour la découverte
authentifiée et les requêtes de chat. Créez des clés Provider-API dans
[Command Code Studio](https://commandcode.ai/studio/).

**Quota Command Code.** Le tableau de bord et `ocx account refresh` sondent les fenêtres
`/alpha/billing/credits` de Command Code (5 heures et hebdomadaire) sur l'hôte canonique
`https://api.commandcode.ai`. Le préréglage OAuth (`command-code`) utilise le jeton porteur du compte
enregistré ; le préréglage à clé d'API fournisseur (`commandcode`) utilise la clé active configurée. Une
URL de base modifiée ressemblant à l'original n'est jamais sondée. Les crédits mensuels, achetés et
gratuits restants sont affichés sous forme de fenêtre en USD lorsque Command Code signale également les
dépenses de la période.

**Découverte SambaNova Cloud.** Le préréglage lit la liste publique `/v1/models` de SambaNova Cloud depuis
l'hôte API fixe, préserve les identifiants natifs du fournisseur et limite la découverte à 128 KiB et 128
lignes brutes. Le catalogue n'étant pas authentifié, le parcours de connexion de la CLI signale que la clé ne
peut pas être vérifiée au lieu de considérer la réponse publique comme une preuve. Les requêtes de chat utilisent
néanmoins la clé Bearer configurée et désactivent les appels de fonctions parallèles, que SambaNova ne prend pas
encore en charge. Les points de terminaison de déploiements SambaStudio privés sont hors périmètre. Créez des
clés dans [SambaNova Cloud](https://cloud.sambanova.ai/apis).

**Découverte Nebius Token Factory.** Le préréglage demande le catalogue détaillé et authentifié des modèles,
puis ne conserve que les lignes dont l'architecture produit du texte, en excluant les modèles d'embedding et de
génération d'images. Il préserve les identifiants natifs contenant des barres obliques ainsi que les métadonnées
de contexte et de modalités d'entrée signalées, et limite la découverte à 512 KiB et 512 lignes brutes. Les
hôtes de déploiement dédiés sont hors périmètre. Créez des clés dans
[Nebius Token Factory](https://tokenfactory.nebius.com).

**Découverte DigitalOcean.** Le préréglage utilise une clé d'accès aux modèles avec l'hôte Serverless Inference
partagé et fixe, puis croise la réponse `/v1/models` authentifiée avec la liste d'autorisation Chat Completions
étayée par la documentation de DigitalOcean. Les identifiants inconnus, limités à Responses, d'embedding ou de
génération multimédia sont refusés par défaut. La découverte est limitée à 256 KiB et 256 lignes brutes ; les
hôtes propres aux agents et les hôtes dédiés sont hors périmètre. Créez une clé dans le
[panneau de configuration DigitalOcean](https://cloud.digitalocean.com/model-studio/manage-keys).

**Découverte Scaleway.** Le préréglage croise la liste authentifiée des modèles avec la liste d'autorisation
Serverless Chat Completions documentée par Scaleway. Les identifiants inconnus, limités à Responses,
d'embedding, de transcription et des autres modèles multimédias sont refusés par défaut ; la découverte est
limitée à 128 KiB et 128 lignes brutes. Il utilise le point de terminaison partagé du projet par défaut ; les
URL qualifiées par projet et les déploiements dédiés nécessitent un fournisseur personnalisé. Créez une clé API
dans la [console Scaleway](https://console.scaleway.com/generative-api).

**Découverte Featherless.** Le préréglage s'authentifie auprès de l'hôte fixe compatible OpenAI et ne demande
que les 100 premiers modèles populaires, filtrés en amont pour le chat et le forfait actuel. Les règles du
registre refusent ensuite toute ligne qui ne signale pas indépendamment la disponibilité du forfait, l'absence
de restriction d'accès Hugging Face et `features.tool_use: true`. La découverte est limitée à 128 KiB et 100
lignes brutes ; le catalogue de plusieurs dizaines de milliers de modèles du service n'est donc jamais
téléchargé ni mis en cache en entier. Comme `/v1/models` est documenté comme accessible avec ou sans
authentification, il ne peut pas prouver la validité d'une clé fournie ; les requêtes de chat utilisent
néanmoins la clé Bearer configurée. Les conditions de Featherless réservent les forfaits individuels à un usage
interactif ou de prototypage ; les applications arbitraires nécessitent un forfait Scale. Créez une clé dans le
[tableau de bord Featherless](https://featherless.ai/account/api-keys).

**Découverte Novita.** Le préréglage à clé utilise l'adaptateur `openai-chat` et n'envoie sa clé Bearer qu'à
l'hôte fixe compatible OpenAI de Novita. Sa liste publique de modèles est filtrée pour ne conserver que les
lignes qui signalent à la fois `model_type: chat` et le point de terminaison `chat/completions`, la découverte
étant limitée à 512 KiB et 256 lignes brutes. Les identifiants de modèle doivent être conservés exactement tels
que Novita les renvoie, y compris ceux délimités par des barres obliques, sans normalisation ni réécriture avant
le routage. Le catalogue étant public, la connexion signale que la clé ne peut pas être vérifiée au lieu de
considérer une réponse de liste réussie comme une preuve. Les capacités variant selon les modèles, le
préréglage n'annonce ni appels d'outils parallèles à l'échelle du fournisseur ni `reasoning_effort` OpenAI.
Créez une clé dans le [gestionnaire de clés Novita](https://novita.ai/settings/key-management).

> **Périmètre Baseten :** le préréglage couvre uniquement les [Model APIs](https://docs.baseten.co/inference/model-apis/overview)
> partagées de Baseten. Utilisez une [clé API](https://docs.baseten.co/organization/api-keys) personnelle pour
> un usage local, ou une clé d'équipe disposant de l'accès **Call Model APIs** pour un usage partagé ou en
> production. Les points de terminaison Truss `predict` dédiés utilisent d'autres hôtes et schémas et ne sont pas
> routés par ce préréglage.
> Pour ce préréglage, la découverte en direct est limitée à une réponse de 1 MiB et à 256 lignes de modèle brutes.

### Quota de crédits A6API

Un fournisseur `openai-chat` personnalisé qui utilise `authMode: "key"` et l'URL de base canonique
`https://api.a6api.com` ou `https://api.a6api.com/v1` bénéficie d'un indicateur de crédits A6API dans le tableau
de bord et dans la sortie de `ocx account refresh <provider>`. Le nom du fournisseur est libre ; la détection
repose sur le point de terminaison HTTPS canonique. L'indicateur convertit les unités de jetons A6API en USD à
partir de la limite de crédit ferme du compte, puis affiche le pourcentage consommé et le crédit restant.
L'expiration du jeton n'est pas présentée comme une réinitialisation du quota, car elle n'implique pas le
renouvellement des crédits.

```json
{
  "providers": {
    "my-a6": {
      "adapter": "openai-chat",
      "authMode": "key",
      "baseUrl": "https://api.a6api.com/v1",
      "apiKey": "${A6API_API_KEY}"
    }
  }
}
```

Les sondes de quota n'envoient que la clé active à l'hôte A6API canonique et refusent les redirections. Les
totaux de facturation mal formés, négatifs ou incohérents ne produisent aucun rapport, afin d'éviter d'afficher
une barre trompeuse.

> **Restriction d'utilisation de Tencent Cloud Coding Plan :** Tencent réserve cet abonnement aux outils de
> programmation interactifs. L'automatisation générale par API, les services applicatifs personnalisés et les
> traitements par lots non interactifs sont interdits et peuvent entraîner la suspension de la clé du forfait.

> **Deux routes GLM :** `zai` correspond à l'abonnement international Z.AI Coding Plan ; `zhipu-bigmodel`
> correspond au point de terminaison national BigModel de Zhipu, facturé à l'usage. Les hôtes, les clés et la
> facturation diffèrent : une clé émise pour l'un ne permet pas de s'authentifier auprès de l'autre.

### Plusieurs clés API

Les fournisseurs à clé peuvent eux aussi conserver plusieurs clés. L'ajout d'une clé depuis la page
**Fournisseurs** l'enregistre sous `provider.apiKeyPool`, l'active et la recopie dans `provider.apiKey`, afin
que le routage et les adaptateurs continuent de lire le même champ. La même liste déroulante permet de changer
ou de supprimer une clé ; l'API de gestion est `/api/providers/keys` et ne renvoie que des clés masquées.

### Changer de compte depuis le terminal

Utilisez `ocx account list`, `ocx account current` et `ocx account use` pour consulter ou changer les mêmes
groupes de comptes Codex, de comptes OAuth et de clés API sans ouvrir le tableau de bord. Consultez la
[référence de la CLI](/fr/reference/cli/providers-accounts/#ocx-account-subcommand) pour les commandes, la sortie JSON et le
comportement lors de l'ouverture d'une nouvelle session.

### Routes de préversion GPT-5.6

GPT-5.6 Sol/Terra/Luna sont préchargés dans les listes de repli des fournisseurs afin que `ocx sync` puisse
maintenir leur visibilité même lorsque les catalogues en direct ne sont pas encore à jour :

| Route Codex | Identifiants de modèle préchargés | Contexte visible dans Codex |
| --- | --- | --- |
| Connexion Codex (Pool ou Direct) | `gpt-5.6-*` | 372 000 |
| OpenAI (clé API) | `openai-apikey/gpt-5.6-*` plus `*-pro` | 1 050 000 (entrée maximale de 922 000) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` | 1 050 000 |
| Cursor | `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, `cursor/gpt-5.6-luna` | 1 000 000 |

Les entrées natives GPT-5.6 conservent les niveaux de raisonnement fixés en amont — Luna propose par exemple
`max`, mais pas `ultra`. Les entrées routées utilisent les métadonnées et les correspondances de raisonnement de
leur fournisseur. Les quatre routes restent soumises aux autorisations du service en amont ; la découverte en direct de Cursor filtre
également sa liste statique pour ne conserver que les modèles utilisables par le compte connecté.

:::note[Passerelles et proxys d'abonnement]
Un fournisseur est inclus lorsque opencodex dispose d'un adaptateur de protocole correspondant, **et non** selon
qu'il s'agit ou non d'un produit « agent ». Les identifiants d'adaptateur actuels sont `openai-chat`, `openai-responses`, `anthropic`, `google`
(modes AI Studio, Vertex et Antigravity/Cloud Code Assist), `azure` / `azure-openai`, `kiro` et
`cursor`. Une API propriétaire dépourvue de l'une de ces implémentations, comme l'API native Amazon Bedrock,
n'est pas prise en charge directement.

**GitHub Copilot** est un fournisseur OAuth (`ocx login github-copilot`) qui échange une connexion GitHub par
flux d'appareil contre un jeton d'API Copilot de courte durée, et non contre une clé API collée. **GitLab Duo**
reste une passerelle à clé ou jeton d'abonnement sur son point de terminaison compatible OpenAI.
**Cloudflare AI Gateway** exige que les identifiants de votre compte et de votre passerelle figurent dans l'URL.

Copilot présente un catalogue qui utilise plusieurs protocoles : sa famille GPT-5 (`gpt-5.3-codex`, `gpt-5.4`,
`gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`) rejette
`/chat/completions` pour le trafic d'agent. opencodex route donc ces modèles sur l'API Responses par défaut,
tandis que tous les autres modèles Copilot restent sur Chat Completions. L'ordre de priorité est le suivant :
verrouillage explicite du protocole → entrée [`modelAdapters`](/fr/reference/configuration/providers/) définie
par l'utilisateur → valeur par défaut du registre → adaptateur commun au fournisseur. Pour faire passer par
Responses un modèle dépourvu de valeur par défaut intégrée, par exemple `gpt-5.4-nano`, définissez
`"modelAdapters": { "gpt-5.4-nano": "openai-responses" }`.

Cursor est géré séparément comme adaptateur expérimental. `adapter: "cursor"` apparaît dans `ocx init` et dans
le sélecteur **Ajouter un fournisseur** du tableau de bord comme entrée expérimentale de la configuration locale,
avec les métadonnées du catalogue statique de repli de Cursor. Lorsqu'un jeton d'accès Cursor est configuré,
opencodex utilise le transport HTTP/2 direct de Cursor. Sa liste de repli intégrée comprend `gpt-5.6-sol` /
`terra` / `luna` (contexte de 1M), les variantes ordinaires et Fast de Grok 4.5 et 4.6 (500K), ainsi que
`kimi-k3` (262K) ; la découverte en direct détermine celles qui restent visibles pour le compte. Grok 4.6 expose
`low` / `medium` / `high` / `xhigh` sous les deux formes, tandis que 4.5 s'arrête à `high`. Les requêtes Fast
envoient le modèle Grok de base correspondant avec des paramètres `effort` et `fast=true` `requested_model`
distincts ; les identifiants aplatis `cursor-grok-{version}-{effort}-fast` servent uniquement à la découverte et
à la sélection. Cursor ne fournit Kimi K3 qu'avec des identifiants de protocole suffixés par l'effort ;
`cursor/kimi-k3` expose donc une échelle `low` / `high` / `max` avec `max` par défaut, conformément à la valeur
par défaut documentée de l'API du modèle. L'exécution native read/write/delete/ls/grep/shell/fetch pilotée par
le serveur Cursor est désactivée par défaut, car elle contourne le parcours d'approbation et le bac à sable de
Codex ; définissez
`unsafeAllowNativeLocalExec: true` sur l'objet `providers.cursor` dans `~/.opencodex/config.json`
uniquement pour des expériences locales de confiance, ou via **Fournisseurs → Cursor → Modifier le JSON** dans
le tableau de bord. Consultez la [référence de configuration](/fr/reference/configuration/providers/#fournisseur-cursor-adapter-cursor)
pour un exemple complet. MCP, l'enregistrement d'écran et l'utilisation de l'ordinateur sont disponibles sous
forme de points d'intégration pour un exécuteur ; sans exécuteur local configuré, opencodex renvoie des résultats
typés indiquant son absence au lieu de bloquer la requête par stratégie. OAuth Cursor et la découverte en direct
des modèles sont activés pour cet adaptateur expérimental ; Cursor ne figure toujours pas dans les listes de
connexion par clé.
:::

### Ollama Cloud

Ollama Cloud est une version hébergée — et non locale — d'Ollama, compatible avec OpenAI à l'adresse
`https://ollama.com/v1` et accessible avec une clé créée sur
[ollama.com/settings/keys](https://ollama.com/settings/keys). opencodex classe les modèles cloud selon leurs
capacités visuelles, afin que le [service auxiliaire de vision](/fr/guides/sidecars/) n'intervienne que pour les modèles
exclusivement textuels. Ces derniers, par exemple `glm-5.2`, `deepseek-v4-pro`, `gpt-oss`, `qwen3-coder`,
`minimax-m2.x` et `nemotron-3-*`, figurent dans `noVisionModels` ; les modèles à vision native, comme
`kimi-k2.6`, `minimax-m3`, `gemma4`, `qwen3.5` et `gemini-3-flash-preview`, n'y figurent pas. La correspondance
tolère les balises `:size` d'Ollama : `gpt-oss` couvre donc `gpt-oss:120b` et `gpt-oss:20b`.

## 4. Fournisseurs locaux

Faites pointer opencodex vers un serveur local compatible OpenAI, généralement avec une clé vide :

| Fournisseur | URL de base |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## Tout point de terminaison compatible OpenAI

Si un fournisseur prend en charge Chat Completions, l'adaptateur `openai-chat` peut le gérer. Choisissez
**Personnalisé** dans le tableau de bord ou `custom` dans `ocx init`, puis saisissez l'URL de base. Consultez la
[référence de configuration](/fr/reference/configuration/) pour tous les champs de fournisseur
(`headers`, `noReasoningModels`, `noVisionModels`, `models`, …).

## Limites de débit dans la vue d'ensemble des fournisseurs

La section **Limites de débit** de la vue d'ensemble des fournisseurs affiche des barres d'utilisation en direct,
actualisées depuis le point de terminaison d'usage ou de facturation propre à chaque fournisseur lorsqu'il en
existe un. Elles indiquent la part déjà consommée d'une fenêtre de 5 heures, hebdomadaire, mensuelle ou propre
au fournisseur.

Les fournisseurs qui disposent d'une sonde en direct sont OpenAI/Codex, Anthropic, xAI, Cursor, Kimi,
Google Antigravity, OpenRouter, DeepSeek, ClinePass, Z.AI, MiniMax, Moonshot, Venice, Synthetic, DeepInfra,
Neuralwatt, Command Code, ainsi que tout fournisseur personnalisé reposant sur a6api.
