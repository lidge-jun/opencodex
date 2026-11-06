---
title: CLI Agents, routage et intégrations
description: Commandes multi-agents, combo, observabilité, accès, intégration, système et configuration.
---

Ces commandes contrôlent la politique et le routage de l'agent, inspectent le proxy actif et connectent les clients pris en charge à opencodex.

## Politique des agents

### `ocx agent <status|injection|effort|subagents|fallback|sidecar> ...`

Gérez la liste multi-agents sans tête, les plafonds d’effort, l’injection rapide, les paramètres de secours et ceux des services auxiliaires.
Utilisez `status` pour la stratégie actuelle. Voir [Surfaces de sous-agent](/fr/guides/sub-agent-surface/) pour savoir comment
les modes de surface, la délégation, l'effort et le comportement de repli s'emboîtent.

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
ocx agent sidecar web --enabled off
```

`--enabled off` est le même interrupteur que la ligne **Désactivé (Off)** du tableau de bord :
OpenCodex cesse d'exécuter le service auxiliaire et l'intégration Codex écrit
`web_search = "disabled"` dans `~/.codex/config.toml`, ce qui permet à un serveur de
recherche MCP d'être le seul chemin de recherche. `--enabled on` supprime à nouveau cette ligne.
Lorsque l'enregistrement déplace réellement l'interrupteur, la commande signale l'écriture côté Codex
qu'elle a déclenchée (`codexWebSearch` avec `--json`, une ligne `Codex config:`
sinon) et renvoie vers `ocx sync` quand elle n'a pas pu avoir lieu. L'option fonctionne aussi
pour `vision`.

### `ocx v2 <status|on|off|mode <v1|default|v2>|threads <n>|mode-hint <text|--clear>>`

Gérez l'indicateur de fonctionnalité Codex `multi_agent_v2` et le mode surface multi-agents à trois états.

| Sous-commande | Actions |
| --- | --- |
| `status` (par défaut) | Signalez l’indicateur v2 actuel, le mode multi-agent et la concurrence des threads. |
| `on` | Activez la fonctionnalité `multi_agent_v2` et resynchronisez le catalogue. |
| `off` | Désactivez la fonctionnalité `multi_agent_v2` et resynchronisez le catalogue. |
| `mode v1` | Forcez tous les modèles à v1, désactivez la v2 native et préservez la limite de threads actifs. |
| `mode default` | Respecter les axes de surface du modèle en amont. |
| `mode v2` | Forcez tous les modèles à v2, activez la v2 native et préservez la limite de threads actifs. |
| `threads <n>` | Définissez la limite de thread v1/v2 active sur un nombre entier d'au moins 1. |
| `mode-hint <text>` | Définissez l’indice de délégation proactive (mode Ultra) pour chaque modèle et effort. |
| `mode-hint --clear` | Supprimez l'indice pour que la politique dérivée de l'effort (ultra = proactive) reprenne. |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
ocx v2 mode-hint "Proactive multi-agent delegation is active."
ocx v2 mode-hint --clear
```

La sous-commande `mode` écrit `multiAgentMode` dans la configuration opencodex et resynchronise le catalogue Codex.
Les changements de mode et d’indicateur déplacent la limite numérique actuelle de fils entre les clés v1/v2 Codex valides ;
une transition ratée restaure le `config.toml` original. Les modifications s'appliquent aux nouvelles sessions Codex, tandis que
les sessions de course conservent leur surface épinglée.

`mode-hint` écrit `features.multi_agent_v2.multi_agent_mode_hint_text` en Codex
`$CODEX_HOME/config.toml` même si `multi_agent_v2` est actuellement désactivé. Le
la commande ne conserve que le remplacement ; il n'active ni ne désactive la fonctionnalité, donc
l'indice prend effet lorsqu'une surface Codex correspondante est active. L'indice remplace
la politique multi-agents dérivée de l'effort du codex-rs, donc tout modèle et tout effort de raisonnement
reçoit l’invite de délégation proactive. Cela ne change **pas** l'effort de raisonnement
lui-même. Un argument manquant ou une valeur contenant uniquement des espaces est rejeté ; seulement `--clear`
supprime l'indice. La bascule **on** du mode Ultra du tableau de bord Sous-agents a une
gate : il nécessite que la fonctionnalité native soit activée avec une surface v2 explicite
(`ocx v2 mode v2`); `ocx v2 on` à lui seul ne satisfait pas à cette porte du tableau de bord.

## Routage combiné

### `ocx combo <list|show|set|remove> ...` · `ocx route combo ...`

Gérez les modèles virtuels de basculement combiné et de round robin. `ocx route combo` est l'alias hiérarchique ;
combo est actuellement la ressource de routage prise en charge. Utilisation des cibles
`provider/model[:weight],provider/model[:weight]`.

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

`set` accepte `--strategy`, `--sticky`, `--effort`, `--alias`, `--rename-from`, `--native-alias` et
`--display-name <label|->` (`-` efface l’étiquette). Un alias natif n'en capture qu'un seul actuellement pris en charge,
identifiant de modèle OpenAI nu non qualifié. Les alias natifs `gpt-5.6-*` nus utilisent Codex Pool/Direct informations d'identification.
Les itinéraires OpenAI qualifiés par le compte restent distincts, tandis que les itinéraires qualifiés par le fournisseur tels que
`openai-apikey/gpt-5.6-*` utilisez leur clé API configurée et ne passez jamais à l'alias natif.
Lisez le contrat de sécurité et de visibilité dans le guide avant d'activer le couple de compatibilité.

Voir [Combos](/fr/guides/combos/) pour le comportement de routage et les conseils de configuration.

## Observabilité et débogage

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

Inspectez les requêtes de proxy, l’utilisation, le stockage, la mémoire et les données de débogage. Les alias directs sont :

| Alias ​​| Ressource équivalente |
| --- | --- |
| `ocx logs [filters] [--follow] [--json\|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <today\|1d\|7d\|30d\|all>] [--surface <all\|codex\|claude\|grok>] [--provider <name>] [--model <id>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

Si certains enregistrements ne peuvent pas être inclus, la sortie lisible affiche un avertissement, même sans ligne lisible. Les totaux affichés ne reflètent que les enregistrements lisibles. Si un filtre ne trouve aucune correspondance lisible, la sortie affiche l'avertissement et des indications au lieu des lignes de totaux ; les enregistrements ignorés peuvent contenir des correspondances. `--json` préserve le diagnostic `usageIncomplete` et sa raison.

### `ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

Lisez ou modifiez les remplacements de débogage d'exécution via la gestion du proxy en cours d'exécution API.

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

Sans portée, `ocx debug` imprime l'utilisation et, lorsque le proxy est arrêté, l'environnement de prochain démarrage
valeurs par défaut. Les valeurs par défaut du débogage du fournisseur sont `OCX_DEBUG=1` (l'héritage `OCX_DEBUG_FRAMES=1` fonctionne également) ; utilisation
les valeurs par défaut du débogage sont `OPENCODEX_USAGE_DEBUG=1`.

## Accès à l’API

### `ocx access <key|endpoints|models|test> ...`

Consultez la liste des clés API d’accès à OpenCodex, les points de terminaison externes et les modèles. `ocx api-key` est un alias de la famille de commandes `ocx access key`.

La création d’une clé et le lancement d’une rotation renvoient un secret en clair, affiché une seule fois, aussi bien en texte qu’en JSON. Les agents doivent confier ces étapes à une personne utilisant directement un terminal en dehors de la session de l’agent. Ne demandez jamais la clé dans la conversation : demandez uniquement la confirmation de la configuration et du test de connexion, ainsi que les identifiants non secrets de la clé et de la rotation.

```bash
ocx access key list --json
```

La confirmation du fonctionnement de la nouvelle clé n’autorise pas la révocation de l’ancienne. Pour finaliser la rotation ou supprimer l’ancienne clé, obtenez une autorisation explicite distincte pour révoquer cette clé. Consultez à nouveau la liste après l’opération autorisée. Ne contournez pas cette procédure par un appel direct à l’API.

## Intégrations client

### `ocx integration <claude|grok> ...`

Gérez les intégrations Claude et Grok prises en charge. Les familles de commandes directes ci-dessous exposent leurs
contrôles spécifiques au client.

### `ocx claude [claude args...]`

Assurez-vous que le proxy est en cours d'exécution, puis lancez Claude Code avec `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` et emplacements de modèle de
`config.claudeCode`. Les modèles routés apparaissent dans le sélecteur `/model` natif via des alias d'emplacement stables
avec Claude Code 2.1.129 ou plus récent. Sur les anciennes versions, sélectionnez avec `ANTHROPIC_MODEL` ou `/model <id>`.
Les variables `ANTHROPIC_*` exportées par l'utilisateur sont toujours prioritaires.

Claude Les commandes du profil de bureau sont :

```text
ocx claude desktop [apply]                         Save and apply the four-family profile
ocx claude desktop show [--json]                   Show routes, families, and defaults
ocx claude desktop move <route> <family> [--default]
ocx claude desktop default <family> <route|none>
ocx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
ocx claude desktop import <path> [--apply]         Validate and import JSON
```

Les familles sont `opus`, `fable`, `sonnet` et `haiku` ; les nouveaux itinéraires commencent en `opus`. `none` est valide
seulement quand cette famille est vide. Les anciens indicateurs d'application `--static`, `--hybrid` et `--discovery-only`
restent soutenus. Utilisez `ocx claude config <status|set> ...` pour les réglages Claude Code.

### `ocx codex [codex args...]`

La clé est fournie uniquement si la configuration et ses espaces de noms sont protégés contre les modifications par d’autres principaux ; l’utilisateur courant et les autorités privilégiées du système sont de confiance. Les processus du même utilisateur sont de confiance : un acteur disposant de vos droits d’écriture peut déjà lire votre fichier de clé OpenCodex. Le remplacement de configuration par ce même utilisateur entre vérification et démarrage natif est hors de ce modèle de menace ; le lanceur ne fige pas la configuration lors du transfert.

Sur une installation Windows normale, les droits ProgramData par défaut permettent à d’autres utilisateurs de créer des dossiers. Les identifiants automatiques sont donc retenus même si `ProgramData\OpenAI\Codex` est absent. Le dossier de configuration système de Codex sous ProgramData doit exister et être accessible en écriture uniquement à Administrators/SYSTEM ; ses dossiers ancêtres doivent empêcher leur remplacement par d’autres utilisateurs. Demandez à un administrateur de vérifier la politique des dossiers. opencodex ne modifie jamais lui-même les ACL et ne fournit aucune commande de préparation.

Vous pouvez aussi fournir la clé vous-même, par exemple en exportant `OPENCODEX_API_AUTH_TOKEN` ; `ocx codex` conserve sa valeur. Les fichiers de configuration système existants empêchent toujours les identifiants automatiques et nécessitent un examen séparé. Chaque motif de refus produit une courte ligne stderr précise, sans valeur de clé, contenu ni chemin de fichier de clé.

Placez `--` avant une invite d’un seul mot pour éviter la sélection d’une sous-commande Codex inconnue.

L’espace de configuration machine doit empêcher un autre utilisateur de créer les fichiers système absents. Un espace Windows ProgramData/OpenAI/Codex non protégé bloque l’injection sans créer de répertoire. macOS accepte les ACL de refus seules et les autorisations en lecture seule. Toute autorisation d’écriture, ajout, suppression, modification d’attributs, de sécurité ou de propriétaire est refusée, même après un refus. Les tags inconnus et erreurs d’inspection entraînent un refus.

Un nouveau jeton de service est chargé uniquement si argv respecte la liste ci-dessous, si aucune variable non vide de proxy HTTP(S)/ALL ou `CODEX_*`/`OPENAI_*`/`AZURE_OPENAI_*` ne surcharge l’environnement (`CODEX_HOME` canonique est permis), et si les espaces home/config/système passent les contrôles de propriété. La configuration doit contenir uniquement les clés auditées et le fournisseur loopback géré exact, sans autre consommateur de clé ni couche de configuration. Tout argument hors liste, dont `-c`/`--config`, `-p`/`--profile`, les options inconnues et `resume`/`fork`, retient le jeton avec un diagnostic sans valeurs ; les identifiants explicites et les arguments sont préservés.

Le répertoire canonique et `config.toml` doivent appartenir à l’utilisateur courant. POSIX refuse les écritures group/other ; Windows vérifie le SID propriétaire et refuse les droits d’écriture DACL hors utilisateur courant, SYSTEM et Administrators. Les droits de remplacement des ancêtres sont vérifiés. macOS exige aussi l’absence de préférences Codex forcées. Ces contrôles n’isolent pas un processus malveillant du même utilisateur ou d’un administrateur.

| Allowlist | Flags |
| --- | --- |
| Switches | `--no-daemon`, `--json`, `--ephemeral`, `--skip-git-repo-check`, `--no-alt-screen`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, `--search` |
| One value | `--model`/`-m`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--image`/`-i` |



Le chargement automatique interprète `CODEX_HOME` comme un chemin littéral, y compris `~` et les espaces, le vérifie et transmet le même chemin absolu canonique au processus enfant. Un répertoire illisible empêche le chargement. Toute valeur non vide de `HTTP_PROXY`, `HTTPS_PROXY` ou `ALL_PROXY`, quelle que soit la casse, empêche aussi le chargement indépendamment de `NO_PROXY` ; les lancements refusés et les identifiants exportés par l’utilisateur restent inchangés. Avec un nouveau jeton, `NO_PROXY` et `no_proxy` du processus enfant incluent `127.0.0.1` et `::1` en conservant les exclusions existantes. Activer `features.respect_system_proxy` ou transmettre `--enable`/`--disable` empêche le chargement automatique.

Le lanceur tente de démarrer le proxy puis transmet les arguments d’origine à Codex, sans réécrire sa configuration. Les routes natives et les passerelles tierces sautent le démarrage. Une route inconnue avertit puis tente le démarrage ; un échec avertit et continue. L’aide, la version et les commandes internes comme `login`, `doctor` et `help` sautent le démarrage et la lecture automatique du jeton.

Un `OPENCODEX_API_AUTH_TOKEN` absent est lu dans le `service-api-token` de cette installation uniquement si toute la configuration de transport du provider sélectionné correspond au bloc géré pour son écouteur loopback ou sa connexion client locale enregistrée. Le nom et les commentaires ne suffisent pas. Destinations inconnues ou distantes, profile par défaut, configuration de projet, `OPENAI_BASE_URL` et options transmises `-c`/`--config`, `-p`/`--profile`, `-C`/`--cd`, `--remote` désactivent cette lecture. Les identifiants exportés et les arguments sont conservés ; les remplacements du fichier et les collisions avec les jetons d’administration sont refusés.

Seul un wrapper autostart correspondant (`matched`) lance directement son Codex sous-jacent. Un état inconnu, y compris une exception d’inspection, exige un contournement vérifié ; les wrappers CMD Windows gérés doivent correspondre au modèle généré complet avant leur exécution avec `OCX_SHIM_BYPASS=1`. Les lanceurs npm ordinaires restent pris en charge. Un wrapper invérifiable ou obsolète entraîne le code de sortie 1 sans démarrer Codex ; actualisez-le avec `ocx codex-shim install`. Le lancement ne répare pas les shims ; le contrôle de contenu ne garantit ni la provenance du fichier Windows sous-jacent ni l’absence de remplacement concurrent.

Aide du lanceur : `ocx help codex` ; aide de Codex : `ocx codex --help`. Le comportement ultérieur de `codex` seul est conservé.

### `ocx opencode [opencode args...]`

Vérifiez que le proxy est actif, puis lancez opencode avec les blocs `provider.opencodex` et `providers.opencodex` générés dans la couche d’exécution intégrée d’OpenCode (`OPENCODE_CONFIG_CONTENT`). La configuration intégrée existante est préservée et seules ces deux clés sont remplacées pour ce lancement. Les fichiers `opencode.json` globaux ou propres au projet peuvent être lus afin de signaler une substitution existante, mais les fichiers sur disque ne sont jamais modifiés. Les modèles routés apparaissent sous la forme `opencodex/<provider>/<model>`. Un lancement ultérieur de `opencode` sans intermédiaire se comporte exactement comme auparavant.

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Gérez et appliquez la clôture du modèle Grok Build.

## Exportation de la configuration client

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime|aside|raycast|omo|cline|kilo|commandcode|droid>`

Imprimez une configuration client connectée au proxy en cours d'exécution. La commande sérialise le
bloc fournisseur `opencodex` — URL de base, liste de modèles et référence d’identifiant du client
espace réservé de référence ou de bouclage — dans le format natif du client sélectionné.

Le proxy doit être en cours d'exécution ; la commande résout son port en direct, lit `/api/models` et émet uniquement
les modèles Codex peuvent actuellement voir.

| Option | Actions |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime\|aside\|raycast\|omo\|cline\|kilo\|commandcode\|droid>` | Requis. Sélectionne le dialecte de configuration client. |
| `--json` | Imprimez le document généré en tant que JSON sur la sortie standard pour les scripts. Il s'agit de JSON même lorsque le format natif du client sélectionné est YAML, TOML ou JSON5. |
| `--out <path>` | Écrivez le format de configuration natif du client dans `<path>`. Refuse de remplacer un fichier existant. |
| `--force` | Autoriser `--out` à remplacer un fichier existant. |

```bash
ocx export --client opencode                     # config plus destination, merge warning, and counts
ocx export --client pi --json > pi-models.json   # JSON document for a pipe or a diff
ocx export --client omp --out ./omp-models.yml    # native OMP YAML
ocx export --client opencode --out ~/opencodex-opencode.json
```

Sans `--json`, la configuration générée est affichée en premier. Elle est suivie du chemin de destination canonique,
de l’avertissement de fusion, de la ligne `export` de la variable d’environnement lorsque le client en utilise une,
puis du nombre de modèles et du nombre de lignes sans limite de contexte faisant autorité. Le client applique ses
propres valeurs par défaut à ces lignes.

| Client | Destination canonique | Télécharger le nom du fichier | Var.environnement |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME` gagne une fois défini) | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` (`PI_CODING_AGENT_DIR` l'emporte une fois défini ; une valeur relative est refusée) | `pi-models.json` | none — le bloc porte le littéral `opencodex-loopback` |
| `omp` | `~/.omp/agent/models.yml` (`OMP_PROFILE` l'emporte sur `PI_PROFILE`, même lorsqu'il est vide ; les profils nommés utilisent le nom du répertoire `PI_CONFIG_DIR` relatif à la maison et ignorent `PI_CODING_AGENT_DIR`, tandis que le profil par défaut laisse `PI_CODING_AGENT_DIR` gagner) | `omp-models.yaml` | aucun — espace réservé de bouclage |
| `hermes` | `~/.hermes/config.yaml` | `hermes-config.yaml` | `OPENCODEX_HERMES_API_KEY` |
| `openclaw` | `~/.openclaw/openclaw.json` | `openclaw.json5` | `OPENCODEX_OPENCLAW_API_KEY` |
| `kimi` | `~/.kimi-code/config.toml` | `kimi-config.toml` | aucun — espace réservé de bouclage |
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | valeur de substitution non secrète pour la boucle locale |
| `dsh` | `$DSH_HOME/settings.yaml` (`~/.dsh/settings.yaml` par défaut) | `settings.yaml` | none — espace réservé pour le porteur de bouclage non secret |
| `mcode` | `~/.minimax/config.yaml` (`MINIMAX_DATA_DIR`, puis l'ancien `MAVIS_DATA_DIR`, l'emportent une fois définis ; une valeur relative est refusée) | `mcode-config.yaml` | aucun — espace réservé de bouclage |
| `zcode` | `~/.zcode/v2/config.json` (`ZCODE_DATA_DIR` l'emporte une fois défini ; une valeur relative est refusée) | `config.json` | aucun — espace réservé de bouclage |
| `prime` | `~/.prime/agent/models.json` (`PRIME_AGENT_CODING_AGENT_DIR` l'emporte une fois défini ; une valeur relative est refusée) | `prime-models.json` | aucun — espace réservé de bouclage |
| `aside` | `~/.aside/u/<account>/models.json` pour le compte que le fichier `accounts.json` d'Aside désigne comme courant ; un manifeste illisible est refusé plutôt que de retomber sur un compte | `aside-models.json` | aucun — espace réservé de bouclage |
| `raycast` | `~/.config/raycast/ai/providers.yaml`, sur macOS comme sur Windows (Raycast n'honore pas `XDG_CONFIG_HOME`) | `raycast-providers.yaml` | aucun — bouclage uniquement, aucune entrée `api_keys` n'est écrite |
| `omo` | `~/.omo/agent/models.json` (`OMO_CODING_AGENT_DIR`, puis `SENPI_CODING_AGENT_DIR`, puis `PI_CODING_AGENT_DIR` l'emportent dans cet ordre une fois définis ; une valeur relative est refusée) | `omo-models.json` | aucun — espace réservé de bouclage |
| `kilo` | premier fichier existant parmi `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json` ou `config.json` sous `~/.config/kilo` (`XDG_CONFIG_HOME` déplace ce répertoire) ; utilise `kilo.jsonc` si aucun n'existe | `kilo.jsonc` | `OPENCODEX_KILO_API_KEY` |
| `commandcode` | `~/.commandcode/providers.json` (sous Windows avec le répertoire personnel par défaut : utiliser `HOME ?? USERPROFILE` uniquement si la valeur n’est ni vide ni composée uniquement d’espaces et désigne un chemin absolu Windows, sinon `homedir()` ; un répertoire personnel fourni séparément est conservé ; ajouter `.commandcode\providers.json`) | `providers.json` | boucle locale uniquement ; `apiKey: false` ; aucune variable d’environnement |
| `droid` | `~/.factory/settings.json` (`%USERPROFILE%\.factory\settings.json` on Windows) | `factory-settings.json` | boucle locale uniquement ; aucune variable d’environnement |

Ces chemins sont les valeurs par défaut. Un `dataBaseDir` absolu dans `~/.zcode/v2/setting.json`, toujours dans le dossier personnel par défaut, déplace le stockage vers `<dataBaseDir>/.zcode/v2/provider_config.json`. `ZCODE_DATA_DIR` désigne directement la racine `.zcode` et prime sur ce réglage ; `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` prime pour le fichier des fournisseurs. Un réglage illisible, mal formé ou relatif bloque les nouvelles applications et actualisations. Les droits de propriété et les données de restauration existants sont conservés. Voir les [règles de chemin et de restauration en anglais](https://opencodex.me/guides/integrations/#zcode-314-and-later).

L'exportation Raycast est un document `providers.yaml` autonome contenant un seul élément `id: opencodex`
dans la séquence `providers` : `name: OpenCodex`, l'URL de base `/v1` du proxy et chaque modèle routé avec
ses `abilities` (`tools` et `system_message` toujours pris en charge, `vision` d'après les modalités d'entrée
du catalogue, `reasoning_effort` lorsque le modèle dispose d'une échelle d'effort, `temperature` désactivé
pour les modèles de raisonnement). Les fournisseurs personnalisés sont une fonctionnalité Raycast Pro, et
Raycast surveille le fichier : une modification enregistrée prend effet sans redémarrage. Le format est
documenté sur [manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers).
Aucune entrée `api_keys` n'est écrite ; cette exportation est donc limitée au bouclage et une liaison hors
bouclage est refusée.

L'exportation DSH gérée nécessite DSH 0.1.0-rc.6 ou plus récent et ne possède que
`llm-pi-ai.providers.opencodex`. DSH recharge à chaud ce fournisseur ; le modèle par défaut de l'utilisateur et
`deepseek-official` restent intacts. Cette exportation s'effectue uniquement en boucle et ne comporte aucune véritable information d'identification.

opencode interpole `{env:OPENCODEX_OPENCODE_API_KEY}`. Les exports Pi et OMP générés font
ne nécessitent pas de variable d’environnement : chacune porte l’espace réservé littéral `opencodex-loopback`.
Ceci est porteur car les deux clients résolvent `apiKey` lors de la construction de leurs listes de modèles et
masquer l'intégralité du fournisseur lorsqu'une configuration existante contient une référence d'environnement non définie. Le proxy n'a jamais
vérifie l'espace réservé généré lors du bouclage. OMP prend en charge les en-têtes au niveau du fournisseur, mais cette première
l'intégration reste délibérément un bouclage uniquement ; le câblage à distance `x-opencodex-api-key` est différé.

:::caution[Fusionner, ne jamais remplacer]
`ocx export` n'écrit jamais votre vraie configuration client. La destination est imprimée pour que vous puissiez la fusionner
main, et `--out` refuse d'écraser un fichier existant sans `--force`, car le remplacement d'un
config détruit les autres fournisseurs, agents et entrées MCP déjà présents.
:::

Aucune clé n'est jamais sérialisée. Les configurations portent soit une référence d'environnement documentée, soit un
Espace réservé de bouclage non secret. Une adresse de bouclage (`127.0.0.1`) ne prouve pas que l’accès est sans clé : vérifiez la politique et le point de terminaison. Les commandes de modèle/audio avec clé sélectionnée exigent une entrée explicite même en bouclage. Définissez une variable référencée uniquement lorsque le schéma client la prend en charge et
le proxy se lie au-delà du bouclage ; voir
[Accès à distance](/fr/reference/configuration/server/#accès-à-distance) pour savoir comment les clés d'admission sont délivrées. Clés pour
les fournisseurs en amont eux-mêmes sont une chose entièrement distincte, configurée par
[Fournisseurs](/fr/guides/providers/).
L’intégration gjc générée utilise une valeur de remplacement locale non secrète, sans variable d’environnement. Elle reste limitée au loopback et ne configure pas les identifiants d’accès distant.

La même charge utile est servie par `GET /api/client-config` et rendue sur l'onglet API du tableau de bord, donc
le CLI, l’API, et le GUI utilisent les mêmes octets.

## Exécution et configuration

### `ocx system <status|settings|startup|diagnostics|sync|codex-app-server|codex-restart|update|codex-cli-update> ...`

Gérez les paramètres d'exécution sans tête, le démarrage, la synchronisation, les diagnostics et les mises à jour.

`ocx system codex-restart --yes` redémarre les serveurs d'application Codex via le même module que `ocx sync --restart-codex`. Elle quitte et relance l'application Codex Desktop si celle-ci a démarré avant l'écriture du catalogue de modèles actuel ou si cette requête a modifié sa liaison `model_catalog_json`, car le sélecteur de modèles est construit au lancement. Sinon l'application reste ouverte, relance son propre app-server et conserve les brouillons non envoyés et les approbations en attente. Si l'état de l'application ou du catalogue est illisible, elle effectue le redémarrage complet. Lorsque le proxy lui-même s'exécute dans l'application Codex, le redémarrage Desktop refuse avec un message actionnable au lieu de promettre un transfert qu'il ne peut pas mener à bien.

Une liaison `model_catalog_json` modifiée par cette requête impose également le redémarrage Desktop, même si le processus a démarré après l’écriture du fichier du catalogue.

```bash
ocx system settings --stream-mode eager-relay
```

`ocx system update` met à jour OpenCodex lui-même. Utilisez cette commande distincte et en lecture seule pour Codex CLI :

```bash
ocx system codex-cli-update check --json
```

`check` ne consulte aucun registre et n’exécute pas Codex. Sur POSIX, `selectionAttested` peut être `true` si le résolveur choisit le même chemin canonique que le candidat d’environnement capturé par le lanceur publié. Un manifeste npm-global lié peut alors établir `managed: true` s’il prouve la propriété et, lorsqu’une version candidate est signalée, si elle correspond à celle du manifeste ; les candidats persistants restent non attestés. Windows x64 prend aussi en charge un `codex.cmd` npm standard absolu lié à la preuve, avec une chaîne d’outils Node/npm liée par les handles — locale au préfixe quand elle est présente, sinon la paire PATH capturée ancrée à l’architecture du lanceur — et une plateforme de support vérifiée dans le préfixe, en utilisant des handles maintenus qui refusent la réanalyse. Les autres dispositions Windows restent différées ou non gérées. Un résultat `managed` Windows ne décrit que la disposition d’installation observée : le Node/npm lié est la chaîne d’outils de métadonnées en lecture seule de l’outil de mise à jour, et non une garantie sur l’interpréteur qu’une invocation ultérieure de `codex.cmd` résoudra. Une exécution directe via Bun ou les sources n’a pas de preuve du lanceur. `plan` consulte le registre officiel avec une configuration, un cache et des journaux npm temporaires isolés, et refuse les sessions actives ou une observation incomplète des processus. Il n’installe rien et n’envoie aucun signal. Sur Windows x64, `apply` exige un préfixe npm borné doté d'une autorité d'écriture privée vérifiée et préserve les packages et shims non liés ; les dispositions observées non prises en charge renvoient `applicable: false` et `refusal: windows_apply_disabled` ; la sélection par PATH seul, les wrappers de démarrage automatique OpenCodex et les replis global/vendor restent différés. Voir [les commandes et motifs de refus complets (en anglais)](/reference/cli/agents/#read-only-codex-cli-update-plan).

Sous Windows, une commande simple capturée comme `CODEX_CLI_PATH=codex`, un chemin distant ou un chemin de périphérique produit plutôt `candidate_path_unavailable`. Le candidat a été capturé, mais son chemin ne convient pas à cette inspection.

#### Observation explicite d’une installation Windows x64

```text
ocx system codex-cli-update attest [--json]
ocx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]
```

`attest` observe en lecture seule une installation npm Windows x64 sélectionnée ou explicitement désignée. Sans options, la commande observe le candidat sélectionné identifié par l’instantané du lanceur de confiance (le `CODEX_CLI_PATH` configuré ou le premier `codex` du PATH capturé), un wrapper opencodex étant résolu vers sa sauvegarde npm renommée `codex.opencodex-real.cmd`. Fournir les quatre chemins absolus remplace la découverte ; celle-ci ne propose que des chemins et l’observation par handles conservés reste l’autorité. `--candidate` désigne le `<prefix>/codex.cmd` npm standard ou `<prefix>/node_modules/@openai/codex/bin/codex.js`. `--npm-cli` doit se terminer par `node_modules/npm/bin/npm-cli.js` et `--node` désigne un `node.exe` explicite. Les applications groupées, les emplacements reconnus de gestionnaires de versions, les shims appartenant à opencodex sans sauvegarde npm et les wrappers personnalisés sont refusés.

Des handles natifs maintiennent les répertoires parents et les fichiers pendant les lectures bornées. Les plateformes non prises en charge, points de réanalyse/junctions, écritures concurrentes, chemins dangereux et fichiers trop volumineux sont refusés. Le rapport fixe ne contient aucun chemin : `status` vaut `observed` ou `refused`, avec `installationIdentityObserved`. `selectionAttested`, `managed` et `applyAllowed` restent `false`. Vérifiez `status` : un refus rapporté peut produire un code de sortie 0.

L’identité ou le condensat décrit les fichiers au moment de l’observation, sans autorisation durable de mise à jour. Cela ne prouve ni le runtime sélectionné, ni l’installateur passé, ni la configuration npm effective, ni l’authenticité des outils. Le Node fourni est seulement observé, pas identifié comme celui que choisirait le lanceur. Aucune cible n’est exécutée ; aucune requête au registre, installation, écriture de configuration ou commande de processus n’a lieu. Le `check` Windows existant ne réalise toujours aucune E/S de fichiers candidats ou de configuration.

### `ocx config [show|get|set|unset|validate|export|import] ...`

`ocx config [show] [--json] [--source]` affiche la configuration locale sans proxy en cours d’exécution. Vous pouvez omettre `show` avec l’un ou les deux indicateurs, dans n’importe quel ordre. `--source` inclut la source, les erreurs et les avertissements de diagnostic et n’est accepté que pour l’affichage. `--json` peut précéder une action explicite sans changer l’action exécutée. Les indicateurs `--json` ou `--source` répétés et les arguments inconnus sont refusés.

Inspectez et modifiez en toute sécurité la configuration OpenCodex validée. `show` et `get` masquent les secrets. Importer
valide avant d'écrire et nécessite `--yes`.

### Forced Claude Code subagent model

The Subagents page offers **Force all subagents onto one model**, off by default. Select an exposed roster-style id, such as `combo/tev-auto`, then enable the switch. The roster is offered first; unavailable saved roster entries cannot be force targets.

`ocx agent subagents force combo/tev-auto` sets `claudeCode.subagentModelForce`; `ocx agent subagents force -` clears it. `ocx agent status` reports the setting. `GET /api/subagent-models` returns `force`, `forceAvailable`, and `forceStatus`; `PUT` accepts `{ "force": "combo/tev-auto" }` or `{ "force": null }` without changing the roster. Omitting `force` leaves it unchanged. Invalid or unexposed targets are rejected on write; stale targets are reported and skipped at launch.

This takes effect on the **next routed `ocx claude` launch**, injecting `CLAUDE_CODE_SUBAGENT_MODEL` as an explicit proxy alias (with `[1m]` only for an authoritative million-token window; native Claude targets use a reversible native alias) and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Each nonempty shell-exported variable independently wins. Native launches inject neither variable; plain `claude` is not affected. No plugin files or `settings.json` are modified by this setting.

Claude Code **2.1.257 or newer** is required for FORCE. Plugin and built-in agents (including Explore/Plan) and per-call model arguments are overridden. Forks and subagent skills with `model: inherit` keep the main conversation model. The main loop and Haiku/small-fast sidecars are unaffected. Existing roster files remain available.

The dashboard warns about old or unknown CLI versions, unavailable targets, and either variable already present in `settings.json` → `env` (which overrides launch env). Detection is read-only and server-local: it cannot inspect another launch shell, another machine, or project-local settings. An unknown result is not proof of force support.

## Hermes / Command Code: model names

Hermes and Command Code support `--model-names alias|routed` (API: `modelNames`).
The default is `routed`, independent of `preferModelAliasIds`. A connection
stores its mode; later Apply without the option preserves it. Alias mode uses
only provider-qualified aliases that the router proves equivalent; missing,
unsafe or colliding aliases fall back to routed keys. Combos keep their keys.
Removed/renamed aliases migrate on the next successful managed refresh, with
foreign-edit refusal. Named Hermes profiles need explicit Apply.

`ocx export --client hermes --model-names alias --json` previews a current
already loaded catalog without writing client files or managed state; a cold or
stale catalog returns unavailable. Explicit `--out` writes an export artifact.
See the [English integration guide](/guides/integrations/#opt-in-alias-model-names)
for the canonical workflow.
