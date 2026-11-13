---
title: Liaison distante
description: Connecter un ordinateur OpenCodex Home à un ordinateur Child avec SSH.
---

Une liaison entre machines connecte un ordinateur OpenCodex **Home** à un ordinateur **Child** avec SSH. Home sert le trafic de Child par le tunnel SSH, et les deux ordinateurs gardent leur service OpenCodex local sur le port `10100`. Le tableau de bord transmet la clé de liaison propre à Child par SSH, sans vous demander de saisir un jeton.

## Conditions requises

- Home peut se connecter à Child avec une clé OpenSSH.
- Pour une liaison initiée par Child, Child peut se connecter à Home avec une clé OpenSSH (la connexion par mot de passe n’est pas prise en charge).
- OpenCodex 2.66.0 ou ultérieur est installé sur Child (et sur Home pour une liaison initiée par Child).
- Les ordinateurs peuvent utiliser macOS, Linux ou Windows x64. Windows nécessite OpenSSH Server et Windows PowerShell, sans Git Bash ni curl.
- Le tableau de bord qui ajoute un Child depuis Home est ouvert sur Home ou via une session Hub appairée. Transformer l’ordinateur actuel en Child exige une session de tableau de bord appairée par l’opérateur ; une session locale sans identifiant ne peut pas valider ce changement de routage.

SSH par mot de passe n'est pas pris en charge. Une liaison peut être lancée depuis Home ou Child. Windows utilise PowerShell via la même connexion OpenSSH vérifiée.

## Ajouter un Child depuis `#remote`

1. Ouvrez le tableau de bord sur `#remote` et activez Remote Link.
2. Choisissez **Home**, puis **Continue**. La liste des hôtes SSH s’ouvre.
3. Choisissez un hôte parmi les candidats SSH, ou saisissez un alias de configuration SSH.
4. Lancez le test de connexion et comparez l’empreinte proposée avec celle de l’ordinateur visé. Cette comparaison aide à détecter un mauvais hôte ou une clé d’hôte modifiée avant que SSH ne lui fasse confiance.
5. Confirmez l’empreinte, puis connectez Child.

Le tableau de bord ne demande pas de saisir un jeton. Il sonde d’abord l’hôte et ne peut appliquer la liaison qu’après votre confirmation explicite de l’empreinte.

La fenêtre d’ajout Child rappelle que Child utilise les fournisseurs de ce Home via SSH et affiche les prérequis ci-dessus. Les alias viennent de `~/.ssh/config` sur le Home exécutant OpenCodex, pas forcément de l’ordinateur du navigateur. Si la recherche réussit sans hôte, ajoutez une entrée `Host` comme ci-dessous puis relancez la recherche. La saisie manuelle d’un alias existant reste possible ; sélectionner ou saisir un alias active le test de connexion. La fenêtre propose un lien vers ce guide.

```sshconfig
Host devbox
  HostName devbox.example.com
  User you
  IdentityFile ~/.ssh/id_ed25519
```

Si la recherche échoue, la fenêtre affiche l’échec du chargement, la raison disponible et une action pour réessayer, sans annoncer une liste vide. Un échec du test conserve sa raison et l’indication SSH nettoyée dans la fenêtre active, sans doublon derrière elle. Consultez la raison et le diagnostic SSH ci-dessous, puis réessayez. Une nouvelle recherche conserve l’alias saisi mais exige une nouvelle vérification de l’empreinte avant connexion.

## Connecter cet ordinateur comme Child

Sur l’ordinateur qui doit utiliser les fournisseurs de Home :

1. Ouvrez le tableau de bord sur `#remote` et activez Remote Link.
2. Choisissez **Child**. La liste des hôtes SSH s’ouvre.
3. Choisissez l’hôte SSH de Home, lancez le test de connexion, puis comparez et confirmez son empreinte d’hôte.
4. Lisez l’avertissement et choisissez **Connect as Child**.

La connexion redémarre OpenCodex sur cet ordinateur. Les tours Codex déjà en cours se terminent d’abord, et les nouvelles requêtes peuvent échouer pendant une minute au plus pendant le redémarrage. Le tableau de bord se recharge ensuite de lui-même et affiche la liaison Child. Codex continue d’utiliser `http://127.0.0.1:<port>/v1` sur cet ordinateur, sans jeton ni variable d’environnement à définir : l’OpenCodex local relaie chaque requête vers Home, qui y répond avec ses propres fournisseurs et comptes.

Si **Child** demande de jumeler d’abord cet ordinateur, ouvrez son tableau de bord HTTP à l’adresse IP de bouclage configurée, par exemple `http://127.0.0.1:<configured-port>`. Le formulaire de jumelage local apparaît uniquement lorsque le jumelage manque et que le tableau de bord et l’API utilisent la même origine de bouclage. Copiez la commande `ocx gui pair --origin "http://127.0.0.1:<configured-port>"` du formulaire, exécutez-la dans un terminal sur cet ordinateur, puis collez le code à usage unique dans le formulaire. Utilisez exactement l’origine affichée ; une clé API de fournisseur ou un jeton d’administration n’est pas un code de jumelage. L’absence de jumelage et un port différent du port configuré sont deux causes distinctes.

Le rôle **Child** exige également qu’OpenCodex fonctionne en mode autonome sur son port configuré, car Child redémarre exactement sur ce port. Si le tableau de bord indique qu’OpenCodex ne tourne pas sur son port configuré, redémarrez-le d’abord sur ce port.

## État de la liaison

- **Connected** signifie que le tunnel SSH est prêt et que Child peut utiliser la liaison Home.
- **Reconnecting** signifie que le tunnel est réessayé. Les requêtes peuvent temporairement renvoyer `503` avec `Retry-After`. Sur un Child connecté depuis son propre tableau de bord, une requête attend d’abord jusqu’à 15 secondes le retour du tunnel.
- **Failed** signifie que la liaison nécessite une intervention. Vérifiez l’authentification SSH, la clé d’hôte confirmée, la redirection ou le délai indiqué. Le côté qui ouvre le tunnel SSH réessaie de lui-même après une mise en veille, une panne ou un redémarrage (Home pour un Child qu’il a ajouté, le Child pour une liaison qu’il a rejointe depuis son propre tableau de bord) : une minute après un délai dépassé ou une erreur de redirection, puis avec une attente qui double après chaque nouvel échec, jusqu’à cinq minutes, et toutes les cinq minutes après une erreur d’authentification. Une clé d’hôte modifiée n’est jamais réessayée. Pour réessayer tout de suite, choisissez **Retry** dans le tableau de bord du Home ou exécutez `ocx link reconnect --link-id <id>` sur le Home. Le tunnel de cette liaison redémarre sans redémarrer OpenCodex.

Une liaison en échec ne bascule pas silencieusement vers un fournisseur local.

## Supprimer un Child

Sélectionnez **Disconnect** pour Child et confirmez son alias. Home arrête le tunnel, révoque la clé de liaison de Child et supprime l’enregistrement enregistré.

Si Home ne peut pas joindre Child pour exécuter la déconnexion, choisissez **Remove here only**. Cela supprime le tunnel, la clé et l’enregistrement locaux. Connectez-vous ensuite à Child et exécutez :

```bash
ocx disconnect
```

Pour déconnecter une liaison initiée par Child, exécutez `ocx disconnect` sur Child. La commande déconnecte le tunnel client et révoque la liaison sur Home via SSH. Si cette révocation échoue, elle affiche : `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## Sécurité

Child utilise les fournisseurs et les identifiants de fournisseur de l’ordinateur Home via la liaison. Home crée une clé distincte pour chaque Child ; la suppression de la liaison révoque cette clé. Comparez l’empreinte de l’hôte avant de confirmer afin de ne pas accepter par erreur une mauvaise machine ou une clé modifiée. Les sessions du tableau de bord émises depuis une identité Tailscale ne peuvent pas gérer les liaisons. Sur Child, la clé reste dans OpenCodex : les identifiants que Codex ou Claude Code envoient sur Child ne sont pas transmis à Home, et tout programme de Child qui atteint `127.0.0.1:<port>` utilise Home sans clé, avec la même confiance locale qu’une installation autonome. Les pages web d’autres sites sont refusées.

## Référence CLI

```text
ocx link probe <alias> [--json]
ocx link add <alias> [--expect-fingerprint SHA256:…] [--json]
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
ocx link reconnect --link-id <id> [--json]
ocx link check (--link-id <id> | --all) [--no-wait] [--json]
ocx link update (--link-id <id> | --all) --yes [--no-wait] [--json]
ocx link sync (--link-id <id> | --all) [--no-wait] [--json]
ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]
ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]
```

Sans terminal interactif (TTY), `--expect-fingerprint` est obligatoire. Dans un terminal interactif, vous pouvez l’omettre si vous confirmez explicitement l’empreinte proposée.

Sur le Home, `ocx link check (--link-id <id> | --all)` lit pour chaque enfant lancé par le Home sa version installée, son type d’installation et sa voie de mise à jour : il exécute `ocx update --plan` de l’enfant par SSH (60 secondes par enfant, trois à la fois), qui calcule un plan sans rien modifier. Un enfant antérieur à 2.97.0 renvoie `owner-action` (`legacy-ocx`) ; sa version vient d’un appel SSH en lecture seule de plus sur macOS et Linux, ou de la version qu’il a annoncée par le lien sous Windows. Les liens ouverts depuis l’enfant et les enfants `ocx-child` sont signalés sans SSH. `ocx link status --json` ajoute alors un bloc `child` à chaque ligne (versions, écart de version, fraîcheur du catalogue, activité, dernière opération). Détails et codes de sortie : [Child install, catalog and activity](/guides/remote-link/#child-install-catalog-and-activity) (en anglais).

### Opérer les enfants depuis le Home

`ocx link sync`, `ocx link restart-codex` et `ocx link update` s’exécutent sur les enfants lancés par le Home via la connexion SSH du lien et affichent la tâche en JSON. `sync` exécute le `ocx sync --expect-link` épinglé (enfant 2.93.0 ou plus récent). `restart-codex` synchronise, puis redémarre les app-servers Codex de l’enfant pour qu’un Codex en cours charge le catalogue actuel ; `--scope codex` relance aussi l’application de bureau. Un redémarrage vise un seul lien ; `restart-codex` et `--restart-codex` exigent `--yes`, tandis que `ocx link sync --link-id <id> --restart-app-server-only` redémarre les app-servers sans confirmation. Le redémarrage est ignoré (`restart-skipped:link-active`) tant que le Home relaie une requête de modèle pour cet enfant. Pour un enfant antérieur à 2.69, une requête non diffusée en flux n’est visible qu’au début de sa réponse. `update --yes` met l’OpenCodex de l’enfant à la version de ce Home, jamais à une autre, avec le propre outil de mise à jour de l’enfant (enfant 2.97.0 ou plus récent ; npm et pnpm passent par leur lanceur Node, si bien que `ocx link check` y exécute aussi `node --version` en lecture seule), un enfant à la fois, puis resynchronise après une application réussie, échouée ou annulée ; une application au résultat inconnu n’est ni relancée ni resynchronisée, vérifiez-la avec `ocx link check`. La mise à jour interrompt les requêtes relayées pour cet enfant. Les enfants Windows ne prennent en charge que `sync`, et les enfants `ocx-child` signalent redémarrages et mises à jour comme non pris en charge. La CLI exige un Home lié à loopback ; sur tout autre Home, ces opérations ne sont pas disponibles, et la page Remote Link du tableau de bord propose les mêmes actions pour un enfant lancé par le Home. Détails et codes de sortie : [Operating Children from the Home](/guides/remote-link/#operating-children-from-the-home) (en anglais). Cette protection est au mieux : une requête qui démarre entre la vérification et le redémarrage peut encore être interrompue ; suspendez les nouvelles requêtes sur cet enfant si ses tours doivent être préservés. Le Home ne peut pas non plus savoir si Codex est au milieu d'un tour qui exécute un outil plutôt qu'une requête de modèle ; laissez donc les tours Codex actifs sur cet enfant se terminer avant de redémarrer Codex ou de mettre à jour OpenCodex là-bas. Une mise à jour manuelle redémarre l'OpenCodex de cet enfant et termine tout tour encore relayé pour lui ; les mises à jour automatiques attendent que l'enfant soit inactif. `ocx sync --restart-children` (ou `--restart-children=codex --yes`) applique la même règle lors de la propagation d’une synchronisation du Home, à tous les enfants ou à ceux désignés par `--child <linkId>` : chaque enfant est synchronisé, et seul son redémarrage est sauté (`restart-skipped:link-active`) tant qu’une requête relayée est en cours.

### Versions et actions des enfants

Sur le Home, chaque ligne Remote Link porte ce que le Home a appris en dernier sur cet enfant, et une ligne lancée par le Home porte aussi ses contrôles. Les badges indiquent :

- la version de l'enfant, avec `Behind Home (<home version>)`, `Same version as Home` ou `Newer than Home` à côté, et `Update available: <home version>` quand une mise à jour peut être appliquée. Un enfant lancé depuis son propre tableau de bord affiche sa version sans badge d'écart, et un enfant `ocx-child` affiche toujours `unknown`.
- le type d'installation (`Desktop app`, `GOAT`, `Source checkout`), ou le jeton brut en police à chasse fixe quand cette version ne le nomme pas.
- `Catalog current` ou `Catalog out of date`. `Codex restart needed (<n>)` et `Codex not running` n'apparaissent qu'une fois que l'enfant signale l'état de son Codex, ce qu'ajoutera une version ultérieure ; aucun enfant publié ne l'envoie encore, donc ces deux badges ne s'affichent pas aujourd'hui.
- la dernière opération, sous la forme `Last <operation>: <state>` avec sa raison en police à chasse fixe, et celle en cours tant qu'une tâche occupe le lien.

Quand le Home ne peut pas mettre cet enfant à jour lui-même, la ligne indique quoi faire à la place : utiliser Check for Updates dans OpenCodex Desktop sur cet enfant, mettre à jour à la main, via `mise`, ou laisser GOAT s'en charger. Une raison inconnue s'affiche comme un jeton, jamais comme une phrase devinée.

Les quatre actions démarrent la même tâche que la CLI ; elles exigent donc les mêmes versions sur l'enfant :

- **Check** lit les informations d'installation de l'enfant, comme `ocx link check`.
- **Sync now** y exécute le `ocx sync --expect-link` épinglé, comme `ocx link sync`.
- **Restart Codex** ouvre un choix de portée. `Codex app-servers` redémarre les app-servers d'arrière-plan de l'enfant pour qu'ils chargent le catalogue actuel ; cela ne rafraîchit pas l'app-server propre à l'application Codex de bureau, redémarrez donc cette application pour cela. `Codex desktop app` la quitte et la relance aussi, ce qui met fin aux conversations qui y sont ouvertes.
- **Update** amène l'OpenCodex de l'enfant à la version de ce Home avec le propre outil de mise à jour de l'enfant, comme `ocx link update`. La confirmation indique que l'OpenCodex de l'enfant redémarre et que tout tour encore relayé pour lui se termine, et que les mises à jour automatiques attendent que l'enfant soit inactif.

**Check all** et **Update all** agissent sur tous les liens éligibles lancés par le Home ; Update all traite toujours un enfant à la fois et ne vise jamais une autre version. Une tâche en cours affiche une ligne par enfant avec son état, la version de départ et d'arrivée, le résultat de la synchronisation du catalogue et celui du redémarrage. Le panneau disparaît quand la tâche se termine et les lignes se rafraîchissent ; une tâche que le Home ne connaît plus, parce qu'il a redémarré, le dit et laisse l'état de chaque ligne répondre. Tant qu'une tâche occupe un lien, ses actions et Disconnect sont désactivés ; le serveur refuse de toute façon la requête.

Sous la liste, le panneau **Child automation** affiche et modifie le même fichier de politique que `ocx link policy` : propagation du catalogue (automatique par défaut), redémarrage de Codex (jamais par défaut), mises à jour (automatiques quand inactif par défaut, pas encore actives dans cette version) et la période d'inactivité. L'enregistrement n'écrit que ce que vous avez changé. Si le fichier de politique était endommagé, le panneau indique que la propagation automatique du catalogue et les mises à jour automatiques sont désactivées, et l'enregistrement écrit alors tous les réglages pour que les modes que vous avez choisis soient ceux qui persistent. Ces contrôles ne contournent jamais le serveur : il revérifie la politique, l'état du lien et l'activité de l'enfant à chaque tâche.

Ne liez pas une machine que vous ne possédez pas : le Home y exécute des commandes avec votre clé SSH.

### Propagation automatique du catalogue et politique des enfants

La propagation du catalogue est activée par défaut. Quand le catalogue du Home change (l’actualisation automatique du catalogue signale un changement, ou une vérification toutes les 5 minutes repère une modification faite dans le tableau de bord ou par l’API de gestion), le Home attend 60 secondes que les modifications se stabilisent (au plus 5 minutes après le premier changement). Ensuite, sans aucune action de votre part, il ouvre une session SSH en arrière-plan vers chaque enfant éligible et exécute le même `ocx sync --expect-link` épinglé que `ocx link sync`, sans redémarrage de Codex sauf si vous en activez un (`childCodexRestart`, ci-dessous). Un enfant est éligible quand son lien a été lancé par le Home, que son tunnel est connecté, qu’aucune autre opération n’y tourne et que la dernière synchronisation lancée par ce Home y est antérieure au changement ; un enfant qui a seulement téléchargé le catalogue reste en retard. Un enfant qui relaie des requêtes de modèle n’est synchronisé que si ses réglages Codex correspondent déjà à ceux du Home et que son runtime client OpenCodex a redémarré depuis l’application de ces réglages, car sinon la synchronisation redémarre ce runtime ; sinon il est synchronisé une fois inactif. Une synchronisation échouée est retentée après 5 minutes, puis à intervalle doublé jusqu’à 6 heures, et un enfant antérieur à 2.93.0 n’est retenté qu’après avoir signalé une autre version. Ces tâches apparaissent comme les autres, avec `trigger: "auto"`. Un Home sans lien n’exécute rien de tout cela.

La propagation corrige le fichier de catalogue de l’enfant. Un app-server Codex déjà lancé sur l’enfant garde la liste chargée jusqu’à son redémarrage : utilisez `ocx link restart-codex --link-id <id> --yes` ou `ocx sync --restart-children`, ou laissez le Home redémarrer les app-servers avec `ocx link policy --child-codex-restart app-server-when-idle`, ce qu’il ne fait que sur un enfant encore inactif au moment de sa synchronisation. Ce réglage vaut pour la prochaine synchronisation automatique ; un enfant dont le catalogue est déjà à jour n’est pas resynchronisé, donc pas redémarré : redémarrez-le vous-même.

La politique est stockée dans `<configDir>/link/child-policy.json` sur le Home, jamais dans `config.json` :

| Réglage | Défaut | Valeurs |
|---|---|---|
| `catalogFanout` | `auto` | `auto`, `manual` |
| `childCodexRestart` | `never` | `never`, `app-server-when-idle` |
| `updates` | `auto-when-idle` | `off`, `notify`, `auto-when-idle` |
| `idleAfterMs` | `600000` (10 minutes) | 1 à 60 minutes |

Par défaut, `updates` maintient automatiquement les enfants inactifs à la version du Home. Les mises à jour automatiques ne sont pas actives dans cette version ; le réglage est déjà enregistré, si bien qu’un refus avec `ocx link policy --updates notify` ou `--updates off` restera valable quand elles arriveront. `idleAfterMs` est la durée sans requête de modèle relayée après laquelle un enfant est considéré inactif ; il détermine aussi `activity.idle` dans `ocx link status`.

```text
ocx link policy                                    # lire la politique
ocx link policy --catalog-fanout manual            # désactiver la propagation automatique du catalogue
ocx link policy --child-codex-restart app-server-when-idle
ocx link policy --updates off --idle-after-minutes 20 --json
```

`GET` et `PUT /api/link/children/policy` lisent et modifient les mêmes réglages (jeton d’administration en boucle locale, ou session du tableau de bord) ; un `PUT` n’envoie que les réglages qu’il modifie. Si le fichier est endommagé ou contient une valeur inconnue, la propagation automatique du catalogue et les mises à jour sont désactivées, et `ocx link policy` l’indique. Un enregistrement efface l’avertissement mais laisse désactivé tout réglage non nommé ; réactivez-les explicitement, par exemple `ocx link policy --catalog-fanout auto --updates auto-when-idle`. Le Home ne réécrit jamais le fichier de lui-même.

Ne liez pas une machine qui ne vous appartient pas : le Home y exécute des commandes avec votre clé SSH.

## Guides associés

- [Déploiement Remote Hub](/fr/guides/remote-hub/)
- [Remote Workspace](/fr/guides/remote-workspace/)


`ocx link probe <alias> --json` · `ocx link add <alias> --expect-fingerprint SHA256:… --json` — [CLI, restart, relay verification and recovery](/guides/remote-link/#add-a-child-from-the-terminal).
