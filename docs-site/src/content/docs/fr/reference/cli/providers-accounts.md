---
title: CLI Fournisseurs, comptes et modèles
description: Commandes de configuration du fournisseur, d'informations d'identification, de quota et de catalogue de modèles.
---

Ces commandes configurent les fournisseurs en amont, authentifient les comptes, gèrent les pools d'informations d'identification et contrôlent le catalogue de modèles exposé à Codex.

## Fournisseurs

### `ocx provider <subcommand>`

Gestion des fournisseurs non interactive. Les entrées de registre sont classées par nom ; un nom personnalisé nécessite
à la fois `--adapter` et `--base-url`.

| Sous-commande | Drapeaux pris en charge | Actions |
| --- | --- | --- |
| `list` | `--json` | Répertoriez les fournisseurs configurés et les entrées de registre restantes. |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | Ajoutez un fournisseur registry/custom. `--force` écrase ; `--sync` actualise un proxy en cours d'exécution en mode sortie humaine. |
| `edit <name>` | indicateurs de champ du fournisseur, `--headers <json>`, `--json` | Modifiez les champs de fournisseur en direct validés sans remplacer les pools de clés. `--headers` fusionne les en-têtes de requête personnalisés ; passez `{}` ou `-` pour les effacer. |
| `test <name>` | `--json` | Sondez le véritable point de terminaison du modèle en amont. |
| `show <name>` | `--json` | Afficher la configuration avec les clés API masquées. |
| `remove <name>` | `--json` | Supprimer un fournisseur autre que celui par défaut ; le dernier fournisseur ne peut pas être supprimé. |
| `set-default <name>` | `--json` | Sélectionnez un fournisseur existant par défaut. |
| `selected <name>` | `--set <ids>`, `--clear`, `--json` | Lisez ou mettez à jour la liste autorisée du modèle de fournisseur. |
| `quota` | `--refresh`, `--json` | Lire les rapports sur les quotas des fournisseurs. |
| `presets` | `--json` | Répertoriez les préréglages du fournisseur de tableau de bord. |
| `account-mode` | `pool`, `direct`, `--json` | Sélectionnez le routage de compte mutualisé ou direct Codex. |

```bash
ocx provider list --json
ocx provider test ark
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
ocx models live --provider ark --json
```

:::caution[Les en-têtes personnalisés ne sont pas un canal d'identification]
`--headers` est destiné aux métadonnées de requête non secrètes : conseils de routage, locataire ou
sélecteurs de projets, identifiants de traçage. Ce n'est **pas** un endroit pour mettre l'authentification
matériel, et le validateur rejette les noms d'en-tête d'identification standard
(`Authorization`, `X-Api-Key`, `Cookie` et le reste) avec un pointeur vers
`apiKey` / `authMode`.

Le validateur ne peut pas reconnaître un nom arbitraire tel que `X-My-Token`, donc le
la frontière est à vous de la respecter. Deux raisons pour lesquelles c'est important :

- Le JSON est un argument de ligne de commande, donc un secret qu'il contient atterrit dans l'historique du shell
  et dans la liste des processus, où tout autre processus sur la machine peut le lire
  avant que le CLI ne rédige quoi que ce soit.
- Les valeurs d'en-tête sont conservées dans `config.json` en texte clair, contrairement aux clés API,
  qui ont leur propre chemin de stockage et de masquage.

Utilisez `--api-key` ou un identifiant OAuth pour tout ce qui est secret.
:::

## Authentification

### `ocx login <provider>`

Démarrez le flux de connexion enregistré du fournisseur. Les fournisseurs OAuth ouvrent un navigateur et stockent
sous `~/.opencodex/` des informations d’identification actualisées automatiquement. Les fournisseurs à clé API
ouvrent leur tableau de bord de clés, demandent la clé, la valident lorsque c’est possible, puis enregistrent la
configuration de fournisseur obtenue. Lorsque le nom est absent ou inconnu, la commande affiche les identifiants
de fournisseurs OAuth et à clé API actuellement acceptés.

Utilisez la même commande pour **réauthentifier** après `ocx status` / `ocx doctor` rapports
réauthentification requise ou échec de l'actualisation du terminal (ou utilisez Réauthentifier dans le tableau de bord).
Les comptes du groupe Codex ne constituent pas un fournisseur public pour `ocx login` : réauthentifiez-vous
plutôt depuis le groupe de comptes Codex du tableau de bord (**Réauthentifier**) ou avec le flux non
interactif `ocx account reauth`.

```bash
ocx login xai
ocx login anthropic
```

Un proxy déjà en cours d'exécution récupère le nouvel identifiant sans redémarrage : le CLI lui demande de
rechargez ce fournisseur à partir du disque et la demande ne contient aucune information d'identification propre. Si le
le proxy en cours d'exécution ne peut pas accepter cette demande - le plus souvent parce qu'il a démarré à partir d'une version antérieure
rechargement attesté : la connexion réussit toujours et les informations d'identification sont toujours écrites sur le disque, mais le
le processus live continue de servir le précédent. Le CLI le dit et vous demande de redémarrer :

```text
⚠️  A proxy is running but could not reload this provider (unattested-target).
   The credential is saved to disk; the running proxy keeps using the previous one.
   Restart it to pick this up: ocx restart
```

### `ocx logout <provider>`

Supprimez les informations d'identification OAuth stockées pour un fournisseur.

## Comptes et pools de clés

### `ocx account <subcommand>`

Répertoriez et changez de compte de fournisseur et de pools de clés API via le proxy en cours d'exécution. L'aide expédiée
la surface est :

```text
Usage: ocx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits> ...

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
priority <provider> <id|main> [first|earlier|normal|later|last|-100..100|reset]  Selection order; omit the value to read it.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.
reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.
Switching the active account takes effect immediately; running threads move on their next request, and in-flight requests keep the account they captured.
A selection-order change applies from the next unbound request and never moves a bound thread.
```

Toutes les sous-commandes nécessitent que le proxy soit en cours d'exécution ; le CLI résout automatiquement son port d'exécution enregistré.
Les opérations réussies se terminent 0. Utilisation invalide, un fournisseur ou un identifiant inconnu, un
proxy, ou un échec API se termine 1. Les champs d'informations d'identification sont affichés exactement comme la gestion API
les renvoie (y compris son masquage) ; Les clés API brutes et les jetons OAuth ne sont jamais restitués. Affichage
les commodités sont synthétisées côté client, comme dans le tableau de bord : `main` désigne la connexion
Codex App du groupe de comptes `openai`, les comptes OAuth sans adresse e-mail apparaissent sous la forme `Account N`,
et la colonne plan/label recouvre le plan, l'e-mail masqué, l'étiquette et la clé masquée.

`--json` les lignes de compte utilisent cette forme courante (les champs facultatifs sont omis lorsqu'ils ne sont pas disponibles) :

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "masked": "sk-ab****wxyz",
  "priority": 0,
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

### `ocx account list [provider] [--json] [--all]`

Sans fournisseur, répertorie le groupe de comptes Codex, les comptes OAuth et les groupes de clés API configurés. Les fournisseurs vides
sont ignorés à moins que `--all` soit présent. Avec un fournisseur, répertorie uniquement cette famille d’informations d’identification.
La sortie destinée aux utilisateurs utilise `PROVIDER TYPE ID PLAN/LABEL PRIORITY STATUS` ; une ligne Codex sélectionnée manuellement porte la mention
`selected`. `PRIORITY` est l'ordre de sélection Codex signé (`0` lorsqu'il n'est pas défini) et affiche `-` pour les lignes
où l'ordre ne s'applique pas, comme les comptes OAuth et les clés API. Avec au moins deux comptes Kiro enregistrés et éligibles, par défaut une réponse 429 entraîne automatiquement une rotation vers un autre
compte, en privilégiant celui dont l'allocation restante connue est la plus élevée ; la rotation est activée par la présence de plusieurs comptes et peut être désactivée avec `oauthAccountFailover.enabled: false` ; `ocx account login kiro` ajoute les comptes au pool un par un. Un résultat vide est toujours un succès. `--json`
renvoie :

```text
{ accounts: AccountRow[], notes: string[] }
```

### `ocx account current <provider> [--json]`

Affiche le compte ou la clé actif. Un pool Codex sans code PIN manuel signale la priorité
sélection automatique : le niveau éligible le plus prioritaire est choisi et le compte le moins utilisé
au sein de ce niveau est sélectionné sous routage de quota ; une autre famille sans rapports d'accréditation actifs
cet état et quitte toujours 0. `--json` renvoie :

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

### `ocx account use <provider> <account-or-key-id|main> [--json]`

Sélectionne un compte Codex, un compte OAuth ou une clé API existant. Pour `openai`, `main` sélectionne la
connexion Codex App. Une sélection en mode Codex Pool efface l'affinité locale du processus et s'applique à la requête suivante,
dont un provenant d'une tâche visible existante ; le redémarrage du proxy ou l'expulsion par affinité peuvent également laisser une tâche
non lié, tandis que les demandes en cours conservent leur compte capturé. Cela contrôle uniquement le routage du pool ;
Le mode direct continue d’utiliser les informations d’identification principales de l’appelant. Commutation proactive basée sur l'utilisation,
401/403 réauthentification, 429/retry-after temps de recharge, exclusion et pré-sortie 429/402 échec
la récupération peut sélectionner ultérieurement un autre compte Pool éligible. Ces chemins de récupération restent actifs lorsque
la commutation basée sur l'utilisation est désactivée. OpenCodex rejoue la conversation après un changement de compte, mais le
Le cache d'invites côté fournisseur peut être froid. Fournisseurs ou identifiants inconnus quittent 1.
Sur une connexion **401/403**, App efface l'affinité locale de processus de ce compte et nécessite une réauthentification.
Sur un **429**, opencodex respecte `Retry-After`, démarre la temporisation du compte, efface l'affinité et peut
faire basculer la requête vers un autre compte de pool admissible. Ces transitions en cas d’échec restent actives avec
`autoSwitchThreshold: 0` ; ce paramètre désactive uniquement le basculement proactif fondé sur l’utilisation.
`--json` renvoie :

```text
{ ok: true, provider, type, activeId }
```

### `ocx account refresh <provider> [--json]`

Pour le groupe de comptes Codex, utilisez `ocx account refresh openai [--json]`. Cette commande force l'actualisation des quotas de compte et
impressions disponibles weekly/monthly pourcentages et temps de réinitialisation ; les données de quota manquantes sont signalées comme
inconnu, pas 0%. Son enveloppe JSON est `{ accounts: AccountRow[] }`, avec `quota` sur chaque Codex ligne.

Pour les fournisseurs de clés OAuth et API, cette actualisation forcée du point de terminaison du rapport de quota du fournisseur ; ce n'est pas un
reconnexion du jeton ou relecture simple de la liste des comptes. `--json` renvoie
`{ provider, report: ProviderQuotaReport | null }`. Un fournisseur sans quota pris en charge imprime le rapport
`no quota report available for <provider>` et renvoie 0. Les fournisseurs inconnus et les échecs de l’API de gestion
renvoient 1 ; une sonde de quota en amont qui échoue ou expire produit plutôt un rapport nul ou périmé
(code 0), conformément aux barres de quota du tableau de bord.

### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

Contrôle uniquement le groupe de comptes Codex `openai`. `on` règle 80 %, `off` règle 0 %, `status` lit la
valeur actuelle et `threshold <n>` accepte un entier de 0 à 100. Les autres fournisseurs et les valeurs
invalides entraînent le code de sortie 1. `--json` renvoie :

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

### `ocx account priority <provider> <account-id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]`

Lit ou définit l’ordre de sélection d’un compte du groupe Codex : **une priorité plus élevée est utilisée plus tôt**.
La valeur par défaut est `0` et la plage va de `-100` à `100`. Seul le groupe Codex `openai` peut être ordonné ;
les autres fournisseurs renvoient le code de sortie `1`. `main` cible la connexion Codex Desktop, ordonnée comme
n’importe quel autre compte du groupe : `ocx account priority openai main last` permet de la conserver comme réserve.

Les mots prédéfinis remplacent les petits entiers : `first` est `+2`, `earlier` est `+1`, `normal` est `0`,
`later` est `-1` et `last` est `-2`. `reset` ramène le compte à sa valeur par défaut et supprime ses
entrée. **L'omission de la valeur lit** la commande actuelle au lieu d'en écrire une.La commande sélectionne les comptes considérés en premier et non ceux qui sont utilisables : la sélection s'effectue toujours parmi
comptes éligibles, en prenant le niveau de commande le plus élevé qui dispose encore d'une marge de quota et en laissant
`accountPoolStrategy` pour choisir à l'intérieur. La pause, le temps de recharge et la réauthentification ne sont pas affectés.
Les modifications s'appliquent à partir de la **prochaine requête non liée**, et pas seulement à partir des sessions nouvellement démarrées : mouvements de préemption
une demande non liée augmente dès qu'un ordre supérieur retrouve de la marge. Sujets déjà liés à un compte
conservez-le normalement jusqu’à ce que ce compte soit vidé ; un échec de réauthentification, un temps de recharge du quota ou un
une séquence de défaillances transitoires libère la liaison avant cela. Toute écriture acceptée publie également un manuel
épingle "utiliser ce compte maintenant", sur le compte qui le détenait, y compris une écriture qui stocke le
commander un compte déjà possédé — c'est le seul moyen d'effacer un code PIN tout en conservant le compte
qui est actuellement sélectionné. (La compensation du compte actif via la gestion API libère un
épingle également, mais il supprime cette sélection avec elle.) Un proxy inaccessible, un
identifiant de compte inconnu, ou une valeur en dehors de l'ensemble accepté exits 1. `--json` renvoie :

```text
{ ok: true, provider, id, priority: number, preset: string | null }
```

### `ocx account login|reauth|code|cancel ...`

Exécutez l’authentification de compte basée sur un navigateur ou par code manuel à partir d’un shell sans tête. Utiliser
`ocx account --help` pour la forme de commande spécifique au fournisseur. Si une connexion au compte Codex est enregistrée mais
l'actualisation de son catalogue de modèles reste en attente, la sortie humaine se termine toujours avec succès et les impressions sont corrigées
`ocx sync` conseils de récupération sur stderr. `--json` garde la sortie standard analysable et transporte
`catalogRefreshPending: true` dans l'état de connexion terminé sans avertissement humain.

### `ocx account remove <provider> <id|main> --yes [--json]`

Cette suppression gardée et non interactive nécessite `--yes`. Avant de supprimer, il vérifie que l'identifiant
existe; un identifiant manquant quitte 1 sans envoyer DELETE. La connexion principale Codex App ne peut pas être supprimée, donc
`remove openai main --yes` est refusé. Après suppression, la famille est relue : suppression de l'épinglé
Le compte Codex efface le code PIN et revient à la sélection automatique ; OAuth promeut le premier reste
compte ou ne déclare aucun ; Les pools de clés API promeuvent la première clé restante ou n'en signalent aucune. `--json`
Les formes de réussite et d’échec sont :

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null, catalogRefreshPending?: boolean }
{ error: string } // stderr, exit 1
```

`catalogRefreshPending` est présent sur les suppressions Codex uniquement. Lorsqu'il est `true`, la suppression du compte est
déjà enregistré; la sortie humaine imprime des conseils de récupération génériques `ocx sync` sur stderr et quitte toujours 0.
Les enveloppes de retrait de compte OAuth et de clé API n'obtiennent pas ce champ.

### `ocx account add-key <provider> [--label <label>] [--json]`

Ajoute et active une clé pour un fournisseur de clés API. La clé est lue uniquement à partir de non-TTY piped/redirected
entrée standard ; entrée interactive TTY, entrée vide, fournisseurs OAuth/Codex et API échecs sortie 1. La clé est
jamais répercuté, y compris lorsqu'il apparaît à l'intérieur d'une étiquette. Préférez un gestionnaire de secrets ou une chaîne ici :

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` renvoie `{ ok: true, id: string | null, label?: string }` et n'inclut jamais la clé.

### `ocx account reset-credits <id|main> [--consume --yes]`

Inspectez Codex réinitialiser les crédits d'un compte. Consommer un crédit est destructeur et nécessite à la fois
`--consume` et `--yes`.

### `ocx account main <subcommand>`

Gérez les profils de connexion principale natifs nommés Codex sans modifier le routage du groupe de comptes OpenCodex :

```text
ocx account main doctor [--json]
ocx account main list [--json]
ocx account main register <label> [--json]
ocx account main add <label>
ocx account main switch <profile-id-or-label> --yes [--json]
ocx account main recover [--rollback --yes] [--json]
```

Chaque commande de mutation rapporte le `CODEX_HOME` effectif canonique renvoyé par le proxy en cours d'exécution.
Ce chemin peut différer du `CODEX_HOME` de l'appelant ; les commandes qui prennent en charge JSON exposent le même
valeur comme `effectiveCodexHome`.

La version 1 prend en charge l'authentification Codex basée sur les fichiers, chiffre les profils stockés avec AES-256-GCM et
conserve la clé de chiffrement dans le magasin d’informations d’identification du système d’exploitation. `add` met en scène l'officiel Codex
flux de connexion avant d’importer les informations d’identification résultantes. Fermez Codex avant de changer de profil ; un
un changement réussi préserve les tâches locales et l'historique, puis nécessite le redémarrage de Codex. Utiliser
`doctor` pour inspecter l'état du profil et `recover` pour terminer ou annuler une transition interrompue.
`switch` accepte soit l'ID du profil, soit son étiquette.

La matrice de récupération v1 couvre un processus OpenCodex sortant après qu'un fichier de transaction ait été
publié par renommer. Il ne revendique pas la durabilité en cas de crash du système d'exploitation ou du noyau ou d'une mise sous tension soudaine.
perte : `atomicWriteFileAsync()` ne `fsync` ni le fichier ni son répertoire parent.

Le coffre-fort chiffré, le journal de bascule, le marqueur de récupération et la quarantaine du journal résident
dans le répertoire canonique `<real CODEX_HOME>/.opencodex-native-main-profiles`. Toutes les instances OpenCodex
qui partagent ce répertoire Codex observent ainsi un propriétaire et un état de récupération uniques. La préparation
des identifiants en clair reste isolée sous chaque répertoire `<OPENCODEX_HOME>/native-main-profile-staging`.

Avant d’autoriser le trafic natif principal ou la récupération du journal, le propriétaire pour la durée de vie du
processus acquiert la revendication exclusive sur les identifiants et ne supprime que les résidus exacts de plantage
`auth.json.ocx.<pid>.<sequence>.tmp`. Chaque candidat doit rester un fichier ordinaire à lien unique sous le
`CODEX_HOME` canonique inchangé ; il est tronqué, vidé sur disque, puis dissocié. Toute substitution de lien ou de
point d’analyse, toute modification d’identité ou toute autre ambiguïté maintient le trafic natif principal fermé,
tandis que les noms seulement ressemblants ne sont jamais supprimés automatiquement. Cette protection couvre les
plantages coopératifs d’OpenCodex, pas un processus malveillant déjà exécuté par le même utilisateur du système.
Cet utilisateur et le système de fichiers contenant `CODEX_HOME` restent donc des éléments de confiance, et la
troncature ne garantit aucun effacement physique sur un stockage à copie sur écriture, dans des instantanés ou sur SSD.

Aperçu des builds utilisés `<OPENCODEX_HOME>/native-main-profiles`. Cette mise en page n'est jamais importée silencieusement.
Si `doctor` signale l’état du profil hérité, arrêtez tous les proxy OpenCodex partageant le même `CODEX_HOME`.
Ensuite, sauvegardez et déplacez les `*.vault.json`, `*.journal.json`, le marqueur de récupération et tout autre marqueur correspondant.
fichier journal-quarantaine référencé ensemble dans le répertoire canonique tout en préservant le propriétaire uniquement
autorisations, ou supprimez l'ancien jeu d'aperçus et exécutez à nouveau `ocx account main register`. Ne choisissez pas
entre plusieurs anciennes racines ou exécutez les deux mises en page pendant qu'un proxy de partage est actif.
Sous Windows, l'état d'aperçu saisi par l'ancienne identité d'accueil pliée en casse doit être réinitialisé plutôt que
déplacé car son AAD chiffré et l'identité du trousseau de clés du système d'exploitation ne sont intentionnellement pas réutilisés.

## Modèles

### `ocx models [subcommand]` · `ocx model <subcommand>`

`ocx model` est un alias de `ocx models`. Sans sous-commande, répertoriez les modèles implantés statiquement dans
fournisseurs configurés. `--provider` filtre un fournisseur configuré et `--json` renvoie le modèle
métadonnées. `live` lit le catalogue en cours d'exécution ; `add`, `edit`, `remove` et `list-custom` gèrent le manuel
entrées de catalogue ; `enable`, `disable` et `provider` contrôlent la visibilité ; `selected` contrôle un
liste d'autorisation des fournisseurs ; `context` contrôle les plafonds de contexte du fournisseur ; et `shadow` gère l'arrière-plan
interception d'appel fantôme.

Chaque opération par modèle proposée par le tableau de bord est disponible ici, donc une installation sans tête n'est jamais nécessaire
appuyez sur GUI pour gérer un catalogue. `add`, `remove` et `list-custom` fonctionnent sur le fichier de configuration et appliquent
à un proxy en cours d'exécution via une synchronisation de catalogue ; les autres parlent à la direction en direct API et exigent le
proxy en cours d'exécution (`ocx start` ou un service installé).

| Sous-commande | Drapeaux pris en charge | Actions |
| --- | --- | --- |
| `list` (par défaut) | `--provider <name>`, `--json` | Répertoriez les modèles prédéfinis dans les fournisseurs configurés. |
| `live` | `--provider <name>`, `--json` | Lisez le catalogue en cours d'exécution, y compris les modèles découverts lors de l'exécution. Les lignes sont marquées `native`/`routed`, `custom` et `enabled`/`disabled`. |
| `add <provider> <modelId>` | `--display-name <name>`, `--context-window <tokens>`, `--modalities <text,image,audio>` | Enregistrez un modèle dont le catalogue du fournisseur n’annonce pas. |
| `edit <custom-id>` | `--model-id <id>`, `--display-name <name\|->`, `--context-window <tokens\|0>`, `--modalities <text,image,audio\|->`, `--json` | Modifiez un modèle personnalisé. `-` libère un champ ; `0` efface la fenêtre contextuelle. |
| `remove <custom-id\|provider/modelId>` | `--yes` | Supprimez un modèle personnalisé. Nécessite `--yes` lorsque stdin n'est pas un terminal interactif. |
| `list-custom` | `--json` | Affichez tous les modèles personnalisés avec le `custom-id` que prennent les autres sous-commandes. |
| `enable <provider/model\|native-model>` | `--native`, `--json` | Rendre un modèle visible à Codex. |
| `disable <provider/model\|native-model>` | `--native`, `--json` | Masquez un modèle de Codex. |
| `provider <name> <on\|off>` | `--json` | Activez ou désactivez chaque modèle d'un fournisseur en une seule écriture. |
| `selected <provider>` | `--set <id,id...>`, `--clear`, `--json` | Lisez ou remplacez la liste autorisée du modèle de fournisseur. `--clear` supprime la liste blanche afin que chaque modèle soit proposé. |
| `context <status\|value <tokens> [--set-all]\|provider <name> on [--value <tokens>]\|provider <name> off\|all <on\|off>>` | `--json` | Lisez ou définissez la limite de la fenêtre contextuelle, globalement ou par fournisseur. `value <tokens> --set-all` redirige également chaque fournisseur acheminé (comme la bascule du tableau de bord) ; sans cela, la valeur devient uniquement la valeur par défaut. `provider ... on --value <tokens>` définit un plafond explicite pour ce fournisseur uniquement (`--value` est valide avec `on` uniquement). |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | Lisez ou définissez le modèle de remplacement pour les appels d'assistance en arrière-plan de Codex. `-` efface le modèle. `status` signale également `sourceModels`, l'assistant supprime les interceptions du proxy (par défaut : `gpt-5.6-luna` ; les clients via 0.144.x ont utilisé `gpt-5.4-mini`, qu'une substitution explicite de `sourceModels` peut restaurer). |

```bash
ocx models live --json                                  # what Codex can actually see right now
ocx models disable anthropic/claude-haiku-4             # hide one routed model
ocx models enable gpt-5.6-sol                           # no slash, so it is treated as native
ocx models provider zenmux off                          # hide a noisy provider wholesale
ocx models selected anthropic --set claude-opus-5,claude-fable-5
ocx models selected anthropic --clear                   # drop the allowlist again
ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image
ocx models list-custom --json                           # read the custom-id for edit/remove
ocx models remove deepseek/deepseek-v4 --yes
```

Un sélecteur de modèle avec une barre oblique est routé (`anthropic/claude-opus-5`) ; un identifiant nu est traité
comme un modèle OpenAI natif. L’option `--native` n’est donc nécessaire que pour forcer cette interprétation pour
un identifiant qui semblerait autrement routé.

`--modalities` accepte uniquement `text`, `image` et `audio`. Codex analyse ce champ comme une énumération fermée
et rejette un catalogue entier contenant toute autre valeur, donc `add`, `edit`, et la gestion API
tous refusent la mauvaise valeur plutôt que de stocker quelque chose que le rédacteur du catalogue devrait retirer plus tard
(#759).
