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
```

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

Gérez les clés d'admission OpenCodex et examinez les points de terminaison et les modèles externes. `ocx api-key
<list|create|remove> ...` est un alias de `ocx access key`.

```bash
ocx access key create deployment
```

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

### `ocx opencode [opencode args...]`

Vérifiez que le proxy est actif, puis lancez opencode avec un bloc `provider.opencodex` généré dans la couche d’exécution intégrée d’OpenCode (`OPENCODE_CONFIG_CONTENT`). La configuration intégrée existante est préservée et seul `provider.opencodex` est remplacé pour ce lancement. Les fichiers `opencode.json` globaux ou propres au projet peuvent être lus afin de signaler une substitution existante, mais les fichiers sur disque ne sont jamais modifiés. Les modèles routés apparaissent sous la forme `opencodex/<provider>/<model>`. Un lancement ultérieur de `opencode` sans intermédiaire se comporte exactement comme auparavant.

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Gérez et appliquez la clôture du modèle Grok Build.

## Exportation de la configuration client

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime>`

Imprimez une configuration client connectée au proxy en cours d'exécution. La commande sérialise le
bloc fournisseur `opencodex` — URL de base, liste de modèles et référence d’identifiant du client
espace réservé de référence ou de bouclage — dans le format natif du client sélectionné.

Le proxy doit être en cours d'exécution ; la commande résout son port en direct, lit `/api/models` et émet uniquement
les modèles Codex peuvent actuellement voir.

| Option | Actions |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime>` | Requis. Sélectionne le dialecte de configuration client. |
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
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | `OPENCODEX_GAJAE_API_KEY` |
| `dsh` | `$DSH_HOME/settings.yaml` (`~/.dsh/settings.yaml` par défaut) | `settings.yaml` | none — espace réservé pour le porteur de bouclage non secret |
| `mcode` | `~/.minimax/config.yaml` (`MINIMAX_DATA_DIR`, puis l'ancien `MAVIS_DATA_DIR`, l'emportent une fois définis ; une valeur relative est refusée) | `mcode-config.yaml` | aucun — espace réservé de bouclage |
| `zcode` | `~/.zcode/v2/config.json` (`ZCODE_DATA_DIR` l'emporte une fois défini ; une valeur relative est refusée) | `config.json` | aucun — espace réservé de bouclage |
| `prime` | `~/.prime/agent/models.json` (`PRIME_AGENT_CODING_AGENT_DIR` l'emporte une fois défini ; une valeur relative est refusée) | `prime-models.json` | aucun — espace réservé de bouclage |

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
Espace réservé de bouclage non secret. Un proxy de bouclage (`127.0.0.1`, la valeur par défaut) ne nécessite aucun
clé d'admission du tout. Définissez une variable référencée uniquement lorsque le schéma client la prend en charge et
le proxy se lie au-delà du bouclage ; voir
[Accès à distance](/fr/reference/configuration/server/#accès-à-distance) pour savoir comment les clés d'admission sont délivrées. Clés pour
les fournisseurs en amont eux-mêmes sont une chose entièrement distincte, configurée par
[Fournisseurs](/fr/guides/providers/).
Gajae est l'exception : `OPENCODEX_GAJAE_API_KEY` remplit ses informations d'identification de fournisseur à partir du
environnement, mais son schéma ne peut pas envoyer l'en-tête d'admission à distance, donc le Gajae généré
l'intégration reste uniquement en boucle.

La même charge utile est servie par `GET /api/client-config` et rendue sur l'onglet API du tableau de bord, donc
le CLI, l’API, et le GUI utilisent les mêmes octets.

## Exécution et configuration

### `ocx system <status|settings|startup|diagnostics|sync|update> ...`

Gérez les paramètres d'exécution sans tête, le démarrage, la synchronisation, les diagnostics et les mises à jour.

```bash
ocx system settings --stream-mode eager-relay
```

### `ocx config <show|get|set|unset|validate|export|import> ...`

Inspectez et modifiez en toute sécurité la configuration OpenCodex validée. `show` et `get` masquent les secrets. Importer
valide avant d'écrire et nécessite `--yes`.
