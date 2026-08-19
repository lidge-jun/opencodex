---
title: Claude Code
description: "Utilisez n'importe quel modèle routé depuis Claude Code : opencodex fournit l'API Anthropic Messages et la découverte des modèles de passerelle sur le même port."
---

opencodex sert `POST /v1/messages` (ainsi que count_tokens) parallèlement à `/v1/responses`. Claude Code peut
ainsi utiliser tous les fournisseurs routés, y compris les connexions, les groupes de comptes, le basculement de
clé et les services auxiliaires, sans configuration d'authentification supplémentaire.

## Groupe de comptes OAuth Claude (expérimental)

Vous pouvez vous connecter à plusieurs comptes Claude via le tableau de bord des fournisseurs (`ocx login anthropic` /
ajouter un compte). Par défaut, chaque requête utilise uniquement le compte **actif**.

Un groupe de comptes Claude **expérimental et facultatif** (`anthropicAccountPool.enabled`) ajoute l'affinité de
session et le basculement en cas de délai de récupération 429 entre ces comptes OAuth. Pour les **nouvelles**
sessions uniquement, `anthropicAccountPool.strategy` sélectionne un compte éligible : `quota` (par défaut)
choisit la plus faible utilisation connue sur 5 heures lorsqu'elle dépasse `autoSwitchThreshold` ; `round-robin`
répartit les sessions uniformément (`stickyLimit`, `1` par défaut) ; `fill-first` utilise le compte actif jusqu'à
un délai de récupération, une réauthentification ou le seuil, puis passe au suivant. Cette fonction est
**désactivée par défaut**, affiche un avertissement dans l'interface et n'a pas été éprouvée en production.
Anthropic peut restreindre les comptes dont l'activité ressemble à une rotation automatisée ; la rotation ne
protège pas contre l'application des règles du fournisseur.

Comportement lorsque cette option est activée :

- Un **429** en amont place le compte en temporisation selon `Retry-After` lorsqu'il est présent, ou selon un délai de repli,
  efface ses affinités et peut faire basculer la requête vers un autre compte admissible, dans les limites prévues.
- L'affinité est **locale au processus** et disparaît au redémarrage du proxy.
- Les erreurs d'identification **401/403** mettent le compte en quarantaine (`needsReauth`) afin de l'exclure de la
  sélection jusqu'à sa réauthentification.
- Si chaque compte éligible est en temporisation, le proxy renvoie **429** (et non 401) avec `Retry-After`
  lorsqu'il est connu.

Voir [Configuration](/fr/reference/configuration/providers/#anthropicaccountpool-expérimental).

## Démarrage rapide

```bash
ocx claude
```

`ocx claude` s'assure que le proxy est en cours d'exécution, puis lance Claude Code avec l'environnement câblé :

| Variables | Valeur |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | Uniquement lorsque le proxy exige une clé API ; sinon, elle n'est PAS définie, afin que votre connexion claude.ai (abonnement et connecteurs) reste active |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (découverte du sélecteur `/model` natif) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Seuil de compactage du contexte automatique (par défaut `829800`) ; injecté uniquement lorsque le contexte automatique est activé |
| `ANTHROPIC_MODEL` | `claudeCode.model` (facultatif) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.tierModels.haiku ?? claudeCode.smallFastModel` (facultatif ; ancien `ANTHROPIC_SMALL_FAST_MODEL` également) |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL` | `claudeCode.tierModels.*` (facultatif) |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | `1` lorsque `alwaysEnableEffort` est activé (conditionnel) |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `DISABLE_COMPACT` | Remplacement du contexte hérité lorsque `maxContextTokens` est défini (conditionnel) |
Les variables que vous exportez vous-même gagnent toujours. Les arguments supplémentaires passent par : `ocx claude -p "hello"`.

Une exception porte sur *l'origine* d'une variable, et non sur sa priorité. L'environnement d'exécution Bun fourni
charge automatiquement les fichiers `.env` / `.env.local` d'un projet. Une valeur `ANTHROPIC_API_KEY` résiduelle dans le
répertoire depuis lequel vous lancez la commande était donc impossible à distinguer d'une exportation volontaire et pouvait
remplacer silencieusement un abonnement claude.ai valide par la facturation API. Désormais, `ocx claude`
ignore les identifiants Anthropic introduits uniquement par un fichier dotenv du projet. Une valeur réellement exportée
dans votre shell reste toujours prioritaire, quel que soit le mode d'authentification. Pour utiliser volontairement une clé API,
exportez-la (`export ANTHROPIC_API_KEY=...`) au lieu de la laisser dans un fichier de projet.

## Mode d'authentification

Claude Code a besoin d'un jeton dans `ANTHROPIC_AUTH_TOKEN` pour communiquer avec une passerelle, mais définir cette
variable désactive aussi votre connexion claude.ai et ses connecteurs. Le choix approprié dépend d'éléments que
opencodex peut détecter ; la détection automatique constitue donc le comportement par défaut.

Laissez le **Mode Auth** activé **Auto** (valeur par défaut) dans **Claude → Claude Code** et opencodex
prend la décision à chaque lancement :

| Ce qu'il trouve | Ce qu'il fait |
| --- | --- |
| Des identifiants OAuth Claude (compte OAuth dans `~/.claude.json`, `.credentials.json` ou trousseau macOS) | Laisse le jeton non défini, afin que votre abonnement et vos connecteurs continuent de fonctionner |
| Un `ANTHROPIC_API_KEY` exporté | Laisse `ANTHROPIC_AUTH_TOKEN` non défini et conserve la clé API ; Claude Code utilise l’authentification par clé API, qui désactive la connexion claude.ai et ses connecteurs |
| Pas d'authentification Claude du tout | Injecte un jeton d'espace réservé, donc Claude Code arrête de vous demander de vous connecter et achemine via le proxy |
| Détection impossible (trousseau illisible, fichier corrompu) | Suppose qu'un abonnement existe et affiche un avertissement — un échec de lecture ne fait jamais basculer un abonnement payant vers le proxy |

Ce choix est recalculé à chaque lancement, sans mise en cache : une connexion ou une déconnexion est donc prise en compte au prochain
appel de `ocx claude`, sans reconfiguration.

Choisissez explicitement **Abonnement** ou **Proxy** si vous souhaitez figer le comportement. Ce choix est
stocké dans `claudeCode.authMode` et n'est jamais remplacé par la détection, même si vous vous connectez ou vous
déconnectez ultérieurement. Revenez à Auto pour rendre de nouveau la décision automatique.

Sur macOS, l'intégration automatique (`claudeCode.systemEnv`) suit la même résolution : une commande
`claude` lancée sans passer par `ocx` se comporte donc de la même manière. Le fichier d'environnement est un instantané actualisé au
démarrage du proxy ou lors de l'enregistrement des paramètres, tandis que `ocx claude` effectue toujours une résolution immédiate.

## Profil Claude Desktop

Claude Desktop utilise un profil distinct de Claude Code. Ouvrez **Claude → Bureau** dans le
tableau de bord afin de placer chaque route disponible dans l'une des quatre familles : Opus, Fable, Sonnet ou Haiku.
Dans un nouveau profil, toutes les routes appartiennent initialement à Opus. La première route Opus devient la route globale
par défaut, et chaque famille non vide conserve toujours sa propre route par défaut.

Vous pouvez faire glisser une ligne vers une autre famille. Ce geste reste facultatif : chaque ligne propose aussi une commande de déplacement
accessible à la souris, au toucher et au clavier. Utilisez **Par défaut** pour choisir la route par défaut d'une famille,
puis sélectionnez **Enregistrer et appliquer à Claude Desktop**. Les familles vides sont autorisées. Si une route par défaut enregistrée
est temporairement indisponible, la première route disponible de la famille est utilisée jusqu'à son retour.

Vous pouvez également gérer le même profil depuis la ligne de commande :

```bash
ocx claude desktop [apply]
ocx claude desktop show [--json]
ocx claude desktop move <route> <opus|fable|sonnet|haiku> [--default]
ocx claude desktop default <opus|fable|sonnet|haiku> <route|none>
ocx claude desktop export <path|->
ocx claude desktop import <path> [--apply]
```

`ocx claude desktop` et `apply` écrivent tous deux le profil actuel dans Claude Desktop. `show` affiche un
résumé lisible ; ajoutez `--json` pour les scripts. `export -` écrit le document JSON versionné sur la sortie standard.
L'importation valide le fichier entier avant tout enregistrement : un fichier invalide laisse donc le profil actuel
inchangé. Ajoutez `--apply` pour écrire immédiatement un profil importé valide dans Claude Desktop. Utilisez `none` uniquement
pour une famille vide ; chaque famille non vide doit conserver une route par défaut.

L'application écrit dans le véritable répertoire Electron `configLibrary` de Claude Desktop : `~/Library/Application
Support/Claude/configLibrary` sur macOS, `%APPDATA%\Claude\configLibrary` sur Windows et
`${XDG_CONFIG_HOME:-~/.config}/Claude/configLibrary` sous Linux. Définissez
`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` pour remplacer explicitement la bibliothèque, ou
`CLAUDE_USER_DATA_DIR` pour utiliser une autre racine de données Claude Desktop. L'ancien répertoire `Claude-3p` n'est
ni lu ni supprimé automatiquement.

Les routes non Anthropic reçoivent des alias stables comme `claude-opus-4-8-2026MMDD`. La partie qui ressemble à une date
est un emplacement synthétique de route, et non la date de publication du modèle. Les véritables routes Anthropic Claude conservent
leur identité. Les nouvelles routes appartiennent par défaut à la famille Opus, mais déplacer une route ne change ni le
fournisseur ni le modèle qu'elle appelle. Les anciens indicateurs `--static`, `--hybrid` et `--discovery-only`
restent disponibles pour les scripts existants.

## Intégration de l'environnement système

Lorsque `claudeCode.systemEnv` est réglé sur `true` (par défaut : **off**), `ocx start` utilise `launchctl setenv`
pour injecter `ANTHROPIC_BASE_URL` et les variables d'environnement Claude Code associées à l'échelle du système.
Les nouvelles fenêtres et les nouveaux onglets du terminal font donc passer les commandes `claude` ordinaires
par le proxy sans nécessiter le wrapper `ocx claude`. Les shells déjà ouverts ne sont pas concernés et doivent
être rouverts.

`ocx stop` et l'arrêt du proxy **suppriment les variables injectées** (ils ne restaurent pas les valeurs précédentes —
seules les clés injectées par opencodex sont supprimées). Le proxy écrit également `~/.opencodex/claude-env.sh` ;
`ocx start` installe le hook source `.zshrc` uniquement lorsqu’un exécutable Claude Code CLI est
présent dans le `PATH`. Au démarrage et avec `ocx ensure`, le hook appartenant à OpenCodex est supprimé
si aucun exécutable du CLI Claude Code n’est trouvé dans le `PATH` ou si l’intégration de l’environnement
système est inactive. Claude Desktop utilise son propre profil et ne déclenche pas l’installation du hook shell.

Désactivez cette intégration avec `claudeCode.systemEnv: false` dans la configuration ou avec le commutateur de l'interface.
La fonctionnalité est réservée à macOS ; sur les autres plateformes, utilisez `ocx claude`.

## Transfert direct natif Claude (utilisation de l'abonnement)

Sans remplacement d'authentification, Claude Code conserve son identifiant OAuth claude.ai et l'envoie au proxy.
Les requêtes visant de véritables modèles `claude*`/`anthropic*`, sans alias ni correspondance dans la carte des modèles, sont transmises
**sans modification** à `api.anthropic.com` avec vos identifiants. Les fonctionnalités bêta, les signatures de réflexion, la mise en cache
des invites et l'identité de facturation restent entièrement natives, tandis que les modèles routés continuent de fonctionner dans la même session
au moyen des alias du sélecteur.

**Traitement des en-têtes :** les en-têtes de proche en proche, ainsi que `host`, `content-length`, `accept-encoding`,
`x-opencodex-api-key` et `origin` sont toujours supprimés avant le transfert. Sur une liaison sans bouclage,
le relais natif nécessite également des informations d'identification de proxy valides dans `x-opencodex-api-key` ; `Authorization`
et `x-api-key` sont alors réservés à Anthropic. Un secret d'admission du proxy trouvé dans l'un des en-têtes d'identification du fournisseur
est supprimé, tandis qu'un véritable identifiant du fournisseur présent dans l'autre en-tête est conservé. Les en-têtes d'identification
ambigus, dont les valeurs sont jointes par des virgules, ne sont jamais transmis.

Le relais se déclenche lorsque toutes ces conditions sont remplies : `nativePassthrough` n'est pas `false` ;
le modèle commence par `claude` ou `anthropic` ; le jeton porteur ou `x-api-key` commence par `sk-ant-` ;
la résolution par alias et carte des modèles renvoie le même modèle sans modification ; enfin, sur une liaison hors bouclage,
l'en-tête d'admission dédié du proxy est valide. Par conséquent, l'avertissement
« Les connecteurs claude.ai sont désactivés » n'apparaît plus avec `ocx claude`.

Désactivez ce comportement avec `claudeCode.nativePassthrough: false` ; définissez une autre destination avec
`claudeCode.anthropicBaseUrl`.

## Le sélecteur /model (« Depuis la passerelle »)

Claude Code 2.1.129+ découvre les modèles de passerelle via `GET /v1/models?limit=1000` et les répertorie dans
le sélecteur natif `/model` intitulé « Depuis la passerelle ». Comme ce sélecteur n'accepte que les identifiants commençant
par `claude` ou `anthropic`, opencodex expose les modèles routés sous forme d'alias stables et réversibles :

| Surface | Format | Exemple |
| --- | --- | --- |
| Claude Code CLI | `claude-ocx-<provider>--<model>` (simple) ou `claude-ocx2-…` (échappé) | `claude-ocx-native--gpt-5.6-sol` |
| Claude Desktop 3P | `claude-opus-4-8-<code>` (hachage base36 de 3 caractères) | `claude-opus-4-8-ncb` |

Le proxy choisit la famille pour chaque requête : `?ids=cli` ou `?ids=desktop` est prioritaire ; à défaut, l'agent utilisateur
`claude-code/*` reçoit la forme lisible de la CLI et les autres clients reçoivent la forme hachée de Claude Desktop.
Les deux familles restent toujours décodables : un modèle enregistré sous l'une ou l'autre forme dans `settings.json` continue de fonctionner.
Chaque entrée porte un nom d'affichage explicite, comme `gemini-3-pro (gemini)`, ainsi que toutes les capacités du modèle
(échelle d'effort de raisonnement et types de réflexion) dans la structure officielle ModelInfo. Le mode passerelle tierce de Claude
Desktop peut ainsi proposer son sélecteur d'effort. Les véritables modèles Anthropic conservent leurs
identifiants canoniques. La date synthétique 2026 désigne un emplacement interne, et non une date de publication. Les
anciens alias hachés et les identifiants `claude-ocx-<provider>--<model>` des configurations antérieures sont
toujours résolus.

Si le sélecteur situé au bas de Claude Desktop ne modifie pas le modèle d'une conversation 3P déjà en cours,
utilisez `/model <id>` dans cette conversation. OpenCodex ne peut pas observer l'état du sélecteur ; il
achemine l’identifiant du modèle porté par chaque requête. Confirmez le résultat sous **Journaux → requestModel**.

Les modèles dont la fenêtre de contexte de référence atteint 1M obtiennent une ligne supplémentaire `…[1m]` dans le sélecteur.
Sa sélection indique à Claude Code la fenêtre complète de 1M pour ce modèle, tout en maintenant le compactage automatique ; le proxy retire
le marqueur avant le routage.
La sélection est conservée dans le champ `model` de `settings.json` ; pour les requêtes entrantes, l'alias est de nouveau
résolu vers le modèle routé. Avec les anciennes versions de Claude Code, le sélecteur reste natif : définissez les modèles au moyen de
`ANTHROPIC_MODEL` ou tapez n'importe quel identifiant routé avec `/model` (Claude Code fait passer les chaînes).

**Règles de grammaire des alias :** le fournisseur ne doit contenir ni `/` ni `--`, et ne doit pas être égal à `native`.
Les identifiants de modèle simples, sans `/` ni `~`, conservent le préfixe v1 `claude-ocx-…`. Ceux qui contiennent `/` ou
`~` utilisent le préfixe v2 `claude-ocx2-…` avec des échappements (`/` → `~s`, `~` → `~t`), par exemple :
`openrouter/anthropic/claude-opus-4-8` → `claude-ocx2-openrouter--anthropic~sclaude-opus-4-8`.
Les alias v1 décodent littéralement (donc un identifiant de modèle historique qui contenait les séquences de deux caractères
`~s` / `~t` est conservé) ; les alias v2 développent les échappements. Les routes impossibles à représenter sous une forme lisible
utilisent l'alias haché. Les identifiants de modèle peuvent contenir `--` (la résolution se sépare uniquement au premier
`--`) ; les identifiants natifs contenant `--` utilisent eux aussi la forme hachée.

**Ordre de résolution du modèle :** retrait du marqueur `[1m]` → décodage de l'alias lisible → décodage de l'alias haché
de Claude Desktop → correspondance exacte dans `modelMap` → correspondance sans date (suffixe `-20250514` retiré) → transfert direct.

Chaque entrée porte un nom d'affichage tel que `gemini-3-pro (gemini)`, ainsi que toutes les fonctionnalités du modèle
(échelle d'effort de raisonnement et types de réflexion) dans la structure officielle `ModelInfo`. Les véritables modèles Anthropic
conservent leurs identifiants canoniques sur les deux interfaces.

### Marqueur `[1m]` de variante contextuelle

Les modèles dont la fenêtre de contexte de référence atteint 1M — ou, avec le contexte automatique, dépasse 200k tout en atteignant
au moins le seuil de compactage — obtiennent une ligne supplémentaire `…[1m]` dans le sélecteur. En la sélectionnant, Claude Code
tient compte d'un contexte complet de 1M. Le proxy supprime le suffixe `[1m]`, sans tenir compte de la casse, avant la
résolution de l'alias et le routage.

## Contexte automatique (modèles à grand contexte sans plafond 200k)

Claude Code attribue une limite de 200k jetons à tout modèle qu'il ne reconnaît pas. Le **contexte automatique**, activé
par défaut, corrige ce comportement :

1. Les modèles dont la fenêtre réelle dépasse 200k **et** atteint au moins le seuil de compactage automatique obtiennent le
   marqueur `[1m]` dans les lignes du sélecteur et les variables d'environnement qui les désignent.
2. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`829800` par défaut, plage `100000`–`1000000`) est injecté afin
   que la conversation soit automatiquement résumée à ce seuil.

Trois états de configuration :

- **absent / `true`:** activé (par défaut)
- **`false` :** désactivé — pas de marqueurs, pas d'injection de fenêtre de compactage
- **ancien réglage `maxContextTokens` défini :** le contexte automatique est implicitement désactivé

La valeur de compactage est réglable sur la page Claude. **Avertissement :** une valeur supérieure à la fenêtre réelle d'un modèle
rend ce modèle inutilisable : les tours échouent avant que le résumé puisse se déclencher.

Les modèles Anthropic natifs dont le contexte est inférieur à 1M ne sont jamais marqués automatiquement. Les valeurs que vous exportez vous-même
restent prioritaires ; le proxy s'appuie sur votre valeur pour déterminer les modèles qui peuvent recevoir le marqueur sans risque.
Les valeurs de configuration invalides définies manuellement reviennent à 829,800.

### Environnement effectif des modèles

`effectiveModelEnv` calcule six emplacements injectés par `ocx claude`, l'environnement système ou le fichier d'environnement du shell :
`ANTHROPIC_MODEL`, les quatre variables `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` et l'ancienne variable
`ANTHROPIC_SMALL_FAST_MODEL`. Le modèle Haiku effectif vaut `tierModels.haiku ?? smallFastModel` et alimente
les deux variables Haiku.

Lorsque `tierModels.haiku` et `smallFastModel` sont absents, OpenCodex laisse les deux variables auxiliaires non définies ; Claude Code choisit ensuite son modèle d'assistance natif (actuellement Sonnet), qui peut entraîner des frais de fournisseur natif.

## Agents de la liste (injectAgents)

`ocx claude` (ainsi que le démon d'environnement système) synchronise la liste des sous-agents exposés (onglet Sous-agents,
jusqu'à 5 modèles) ainsi que `ocx-self` dans `~/.claude/agents/ocx-*.md`.

- **`ocx-self`** épingle le modèle par défaut de votre sélecteur `/model` (avec repli sur `claudeCode.model`) ; il est omis
  quand ni l’un ni l’autre n’existe. Il utilise l'héritage de modèle.
- Chaque corps d'agent contient une directive `<!-- ocx-route: <model> -->` — le proxy l'utilise pour
  épingler la véritable route. L'argument `model` de l'outil Agent est donc inopérant ; utilisez `"haiku"` comme
  espace réservé.
- Le frontmatter contient le nom d'affichage ; le routage est déterminé par les directives.
- Seuls les fichiers `ocx-*.md` vérifiés par marqueur contenant `generated-by: opencodex` sont toujours
  écrasés ou supprimés ; vos propres agents ne sont jamais modifiés.
- Les fichiers sont synchronisés atomiquement par fichier (écriture + renommage).
- `enabled: false` ou `injectAgents: false` élague toutes les définitions dont la propriété est vérifiée.
- Les requêtes PUT de l'interface et les changements de liste déclenchent immédiatement une nouvelle synchronisation ; le lanceur et l'environnement système se synchronisent au démarrage.

Utilisation : `subagent_type: "ocx-gpt-5-6-sol"`. Les cibles compatibles avec un contexte de 1M portent automatiquement `[1m]`.

## Élision des compétences intégrées (blockedSkills)

La compétence `claude-api` fournie avec Claude Code injecte environ 840 Ko (~136k jetons) de documentation Anthropic
et se déclenche automatiquement lorsque des modèles Claude sont mentionnés. Les modèles routés n'ont pas été entraînés sur cet ensemble ;
par défaut, opencodex remplace donc le contenu de la compétence par un bref contenu de remplacement dans les requêtes **routées**.
Le transfert Anthropic natif reste intact.

**Deux vecteurs sont pris en charge :**

1. **Résultat d'outil :** pour les appels assistant `Skill(...)`, le corps `tool_result` associé est
   remplacé par un contenu minimal lorsque l'entrée JSON en minuscules contient un nom bloqué.
2. **Vecteur de bloc de texte :** un bloc de texte utilisateur d'au moins 10 000 caractères commençant par
   `Base directory for this skill: ` — est reconnu lorsque le nom de base du répertoire correspond à un nom bloqué
   (insensible à la casse).

Configurez cette fonction avec `claudeCode.blockedSkills` (`["claude-api"]` par défaut ; `[]` désactive entièrement
l'élision). Le contenu de remplacement préserve l'association entre l'appel d'outil et son résultat.

## Mappage des modèles (interception)

`claudeCode.modelMap` réécrit les identifiants de modèle Anthropic entrants avant le routage :

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

Ordre de recherche : alias de découverte → identifiant exact → identifiant sans le suffixe de date (`-20250514`) → transfert direct.

## Matrice des services auxiliaires : recherche web et compréhension des images

Les modèles routés ne disposent pas tous des mêmes outils hébergés ou de la même prise en charge des images. opencodex comble ces lacunes
avant que le modèle principal ne réponde :

- Le **service auxiliaire de recherche web** exécute la véritable recherche hébergée, puis fournit au modèle routé la réponse et ses
  sources sous forme de résultat d'outil.
- Le **service auxiliaire de vision** décrit une image jointe avant d'appeler un modèle répertorié dans
  `noVisionModels`, puis remplace l'image par cette description.

Les deux services auxiliaires peuvent utiliser l'un ou l'autre moteur :

| Moteur | Fonctionnement | Prérequis |
| --- | --- | --- |
| `openai` | Un petit modèle GPT via le fournisseur ChatGPT `forward` | Une connexion ChatGPT et un fournisseur actif avec `authMode: "forward"` |
| `anthropic` | Claude au moyen d'identifiants OAuth Anthropic stockés ; la recherche web utilise `web_search_20250305` et le service de vision envoie l'image à Claude pour qu'il la décrive | Un fournisseur actif avec `adapter: "anthropic"` et `authMode: "oauth"`, dont le compte actif stocké n'est pas marqué `needsReauth` |

Une valeur `backend` explicite est toujours prioritaire. Si elle est omise, opencodex sélectionne `anthropic` lorsqu'un
compte OAuth Anthropic enregistré existe ; sinon, il sélectionne `openai`. Une sélection explicite de
`anthropic` sans identifiants utilisables **échoue de manière sûre** : opencodex n'emprunte pas silencieusement les
identifiants ChatGPT et ne change pas de moteur. Le moteur OpenAI reste lui aussi désactivé sans connexion ChatGPT
et sans fournisseur de transfert.

Les nouvelles tentatives routées issues de Claude joignent la connexion ChatGPT principale à la requête interne ; les services auxiliaires
OpenAI restent donc accessibles même si la requête entrante de Claude Code ne porte que l'identifiant du proxy.
Cet identifiant n'est jamais transmis au fournisseur principal routé.

```json
{
  "webSearchSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxSearchesPerTurn": 3
  },
  "visionSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8
  }
}
```

`maxDescriptionsPerTurn` limite le nombre de nouvelles descriptions d'images pendant un tour du modèle principal. Les résultats trouvés dans le cache et
les descriptions identiques déjà en cours ne consomment pas cette limite. Les descriptions réussies des images `data:`
sont mises en cache selon le moteur, le modèle, le niveau de détail, les octets de l'image et le contexte de la requête ; une même
paire image-contexte n'est donc pas décrite de nouveau à chaque tentative. Les images distantes `https:` ne sont jamais
mises en cache, car leur contenu peut changer.

Consultez la [référence de configuration](/fr/reference/configuration/server/#services-auxiliaires) pour chaque clé.
La recherche web et la description d'images avec OAuth Anthropic réutilisent les identifiants Claude Code existants du magasin
d'empreintes précédent. Testez néanmoins ces fonctions avec votre compte et votre charge de travail avant de vous y fier
pour de longues exécutions sans surveillance.

<!-- TODO(WP5 GUI): Add the sidecar settings-screen walkthrough after the GUI controls ship. -->

## Effort de raisonnement

Le paramètre `/effort` de Claude Code est conservé sur l'ensemble de l'adaptateur :

| Format du protocole | Correspondance |
| --- | --- |
| `thinking.type: "adaptive"` + `output_config.effort` | Effort transmis directement (`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`\|`ultra`) |
| `thinking.type: "enabled"` + `budget_tokens` | ≤4096→`low`, ≤16384→`medium`, ci-dessus→`high` |
| `thinking.type: "disabled"` | `reasoning: { effort: "none" }` ; résumé omis |

La valeur résolue apparaît dans la colonne **Effort de raisonnement** du journal des demandes.

## Traduction entrante (Messages → Réponses)

Le proxy traduit chaque requête Anthropic Messages API au format Codex Responses API :

| Entrée Messages | Sortie Responses |
| --- | --- |
| Niveau supérieur `system` | `instructions` (blocs de texte joints par `\n\n`) |
| `messages[].role: "system"` | Également plié en `instructions` |
| Texte/image utilisateur | `input_text` / `input_image` (base64 → données URL) |
| Texte assistant | `output_text` |
| Assistant `tool_use` | `function_call` (`input` → JSON-stringifié `arguments`) |
| Utilisateur `tool_result` | `function_call_output` (`is_error` → préfixe `[tool error]`) |
| Relecture de `thinking` / `redacted_thinking` | Ignorée |
| Outils fonctionnels | `{type: "function"}` (`web_search*` → `{type: "web_search"}`) |
| `tool_choice` | `auto`→`auto`, `none`→`none`, `any`→`required`, fonction nommée→`{type:"function",name}`, hébergée WebSearch/web_search→`{type:"web_search"}` |
| `max_tokens` | `max_output_tokens` |
| `stop_sequences` | `stop` |

**Cas d'erreur (400) :** JSON mal formé ; `model` absent ou vide ; `messages` absent ou vide ; rôle non pris en charge ;
`tool_result` sans `tool_use_id` ; `tool_use` sans identifiant ni nom ; `tool_choice` nommé sans nom.

## Traduction sortante (Réponses → Messages SSE)

| Événement de réponses | Messages SSE |
| --- | --- |
| `response.created` | `message_start` + `ping` |
| Battement de coeur | `ping` |
| Deltas de texte | `content_block_start` → `content_block_delta` (texte) → `content_block_stop` |
| Résumé ou texte de raisonnement | Bloc `thinking` avec signature synthétique |
| Trames d'appel de fonction | Bloc `tool_use` avec `input_json_delta` |
| Événement terminal | `message_delta` → `message_stop` |
| EOF avant la borne | style 502 `api_error` |

**Mappage du motif d'arrêt :** `completed` → `tool_use` (si un outil est appelé) ou `end_turn` ;
`incomplete/max_output_tokens` → `max_tokens` ; `incomplete/content_filter` → `refusal`.

**Taxonomie des erreurs :** 400 `invalid_request_error`, 401 `authentication_error`,
402 `billing_error`, 403 `permission_error`, 404 `not_found_error`, 409 `conflict_error`,
413 `request_too_large`, 429 `rate_limit_error`, 504 `timeout_error`, 529 `overloaded_error`,
autre 5xx `api_error`. `Retry-After` est conservé.

## Mise en cache des prompts et utilisation des jetons

**Requêtes routées vers Anthropic :** l'adaptateur gère les points de rupture du cache pour les outils, le contenu système
et l'avant-dernier message utilisateur, ainsi que le champ `cache_control` automatique de premier niveau. Les tours stables
atteignent généralement un taux d'accès au cache d'environ 99.9 %.

**Routage OpenAI/ChatGPT natif :** produit une valeur `prompt_cache_key` propre à la session, à partir de
`metadata.user_id` lorsqu'il est présent ou, à défaut, d'un hachage du contenu système, ainsi qu'un en-tête `session_id`
pour l'affinité du cache. La clé de cache inclut le modèle et l'intégralité des schémas d'outils.

**Calcul des jetons d'entrée :** Anthropic soustrait `cached_tokens` et `cache_write_tokens` de
`input_tokens`, les exposant comme `cache_read_input_tokens` et `cache_creation_input_tokens`.
Les journaux de requêtes les intègrent à `inputTokens`, les lectures étant enregistrées dans `cachedInputTokens` et
`cacheReadInputTokens`, et les écritures dans `cacheCreationInputTokens`. La page Utilisation présente séparément les lectures
et la création de cache séparément.

**`count_tokens` :** les modèles routés utilisent une approximation fondée sur le système sérialisé, les messages et les outils.
Les modèles Anthropic natifs accompagnés d'un identifiant `sk-ant-` transmettent la requête au véritable point de terminaison
Anthropic `/v1/messages/count_tokens`.

## Capture de débogage

`ocx debug claude on|off|status|reset`, `OCX_CLAUDE_DEBUG=1` ou `PUT /api/debug {"claude": true}`
contrôle la capture entrante. `GET /api/claude/inbound-debug` renvoie `{enabled, entries}` (le plus récent
premier, anneau de 20).

Chaque entrée enregistre : `at`, `endpoint`, `model`, `resolvedModel`, `stream`, `maxTokens`,
`thinkingType`, `thinkingBudgetTokens`, `outputConfigEffort`, `metadataKeys`,
les indicateurs `hasMetadataUserId` et `hasSystem`, la valeur brute `anthropicBeta`, ainsi qu'un HMAC de huit caractères pour
l'identifiant utilisateur ou système. **Aucun texte d'invite, objet brut ni hachage stable entre les entrées n'est enregistré.** La désactivation
du débogage Claude efface immédiatement l'anneau.

## Interface graphique (page Claude)

La barre latérale du tableau de bord comporte une page **Claude** dédiée (sous API) et une bascule **Claude ON**
(étiquette volontairement identique dans toutes les langues). La page affiche :

- Interrupteur général des requêtes entrantes
- Démarrage rapide (`ocx claude`) et bloc d'environnement manuel
- Sélecteur de mode rapide (Auto / ON / OFF)
- Basculement automatique du contexte et liste déroulante du seuil de compactage
- Bascule d'enregistrement automatique des sous-agents
- Éditeur d'interception des modèles (modelMap)
- Aperçu en direct des alias du sélecteur

`GET /api/claude-code` renvoie les valeurs par défaut effectives, la configuration, le registre des fenêtres de contexte, l'environnement effectif,
les identifiants de route, les alias et le port disponibles. `PUT /api/claude-code` applique une mise à jour partielle et conserve les
champs omis ; `null` réinitialise les valeurs de contexte, de liste de blocage et de seuil de compactage.

## Dépannage

**Claude Code indique « 0 recherche effectuée »** — Les versions actuelles traduisent les éléments Responses terminés
`web_search_call` en blocs Anthropic `server_tool_use` et `web_search_tool_result` appariés,
y compris `usage.server_tool_use.web_search_requests`. Mettez à jour opencodex si une ancienne version terminait
la recherche alors que Claude Code indiquait toujours zéro.

**Un service auxiliaire ne s'active pas** — Pour `backend: "openai"`, vérifiez que vous êtes connecté à ChatGPT et
qu'un fournisseur avec `authMode: "forward"` est actif. Pour `backend: "anthropic"`, vérifiez que le compte OAuth Anthropic
actif et stocké n'est pas marqué `needsReauth`. Une sélection explicite d'Anthropic sans ces identifiants
échoue volontairement de manière sûre.

**"Les connecteurs claude.ai sont désactivés"** — Un `ANTHROPIC_API_KEY` ou `ANTHROPIC_AUTH_TOKEN` est défini
dans votre shell. `ocx claude` s'abstient délibérément de définir `ANTHROPIC_API_KEY` ; si vous l'avez exportée,
supprimez-la de l'environnement. `ocx claude` injecte `ANTHROPIC_BASE_URL`, la découverte, le contexte automatique et les modèles configurés, mais jamais `ANTHROPIC_API_KEY`.

**Les modèles ne s'affichent pas dans le sélecteur de modèles** — Vérifiez que `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` est bien
défini (automatique avec `ocx claude`). Exécutez `ocx claude` pour actualiser le cache des modèles de la passerelle dans
`~/.claude/cache/gateway-models.json`. Vérifiez que `claudeCode.enabled` n'est pas `false`.

**Environnement obsolète après un changement de port** — Si le port du proxy a changé, les anciens shells peuvent conserver
une valeur `ANTHROPIC_BASE_URL` obsolète. Ouvrez un nouveau terminal ou réexécutez `ocx claude`.

**Plafond de contexte 200k malgré un grand modèle** — Sélectionnez la variante `[1m]` dans le sélecteur ou activez
le contexte automatique, activé par défaut. Si le sélecteur n'affiche aucune ligne `[1m]`, la fenêtre de contexte de référence du modèle
peut être inférieure au seuil de compactage automatique.

**Nombre élevé de jetons provenant du chargement des compétences** — La compétence `claude-api` fournie (~136k jetons) se charge automatiquement
quand un modèle Claude est mentionné. Ce comportement est normal avec le transfert natif ; pour les modèles routés, opencodex la remplace
par défaut par un contenu minimal (`blockedSkills: ["claude-api"]`).

**Les sous-agents sont envoyés au mauvais modèle** — Les agents de la liste (`ocx-*`) utilisent les directives
`<!-- ocx-route: ... -->`, et non l'argument `model` de l'outil Agent. Vérifiez que la directive désigne la route voulue.
Utilisez `"haiku"` comme valeur de remplacement pour le modèle.
