---
title: Cycle de vie de la CLI
description: Commandes de configuration initiale, de démarrage, d’arrêt, de service, de diagnostic, de synchronisation et de mise à jour.
---

Ces commandes permettent d’installer, d’exécuter, d’examiner, de réparer et de mettre à jour le proxy opencodex local ainsi que son intégration à Codex.

## Configuration initiale

### `ocx init` · `ocx setup`

Assistant de configuration interactif (`setup` est un alias de `init`). Il demande un fournisseur (prédéfini ou personnalisé), une clé d’API (valeur littérale ou `${ENV}`), un modèle par défaut et le port du proxy, puis enregistre le tout dans `~/.opencodex/config.json`. Il peut également injecter le proxy dans `$CODEX_HOME/config.toml` (par défaut `~/.codex/config.toml`) et installer le shim de démarrage automatique de Codex.

## Cycle de vie du proxy

### `ocx start [--port <port>]`

Démarre le serveur proxy, de préférence sur le port `10100`. Si ce port est occupé, opencodex en choisit un autre qui est disponible et l’enregistre. La commande écrit l’état du PID et du port d’exécution, et refuse de démarrer une deuxième instance active. Au démarrage, elle synchronise dans le catalogue Codex les modèles de chaque fournisseur. À l’arrêt, elle rétablit le fonctionnement natif de Codex, sauf si le proxy a été lancé comme service géré (`OCX_SERVICE=1`).

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

Arrête le proxy actif à partir de son PID, supprime le fichier de PID et rétablit le fonctionnement natif de Codex. Si un service d’arrière-plan géré est installé, `ocx stop` l’arrête d’abord afin qu’il ne puisse pas relancer le proxy. Le bouton **Stop** du tableau de bord Web exécute la même opération (`POST /api/stop`) sur tous les backends, sauf le Planificateur de tâches Windows : le wrapper peut y relancer le proxy après la fin de la tâche, donc le tableau de bord refuse avec `respawnable_service`, ne modifie rien et vous demande d'exécuter `ocx stop`.

### `ocx restart`

Lorsqu’un proxy est actif, demande précisément au PID et au port dont l’identité a été vérifiée de redémarrer sur place, attend la fin du drainage normal, puis vérifie qu’un autre PID d’exécution écoute sur le même port. Le routage géré et la supervision du service restent installés pendant toute l’opération. Une requête dont l’état est incertain est observée, et non rejouée comme lors d’une séquence distincte d’arrêt et de démarrage.

Si aucun proxy n’est actif, la commande revient au démarrage normal avec `ensure`. Si l’identité d’un processus à l’écoute ne peut pas être rattachée à un PID d’exécution — notamment avec un proxy antérieur à une mise à jour — le redémarrage échoue de manière sûre, sans repli sur `ensure` ni sur une séquence arrêt/démarrage. Après avoir confirmé que le processus vous appartient, utilisez `ocx stop` puis `ocx start` pour un proxy autonome. Pour un proxy géré par un service, utilisez `ocx stop` puis `ocx service start` afin de rétablir la supervision.

### `ocx ensure`

Vérifie de manière idempotente qu’un proxy d’arrière-plan est actif, puis synchronise son catalogue de modèles en direct. Si `codexAutoStart` vaut `false`, la commande indique que le démarrage automatique est désactivé et n’effectue aucune opération.

### `ocx restore [back]` · `ocx eject [back]`

Rétablit le fonctionnement natif de Codex **sans arrêter** le proxy : les lignes de configuration injectées et les entrées routées du catalogue sont supprimées, de sorte qu’une invocation simple de `codex` utilise de nouveau Codex directement. `eject` est un alias de `restore`.

Ajoutez `back` à l’une ou l’autre forme pour rediriger une invocation simple de `codex` vers un proxy déjà actif, sans modifier le cycle de vie du proxy :

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai --yes`

Récupération explicite destinée aux anciennes versions de développement qui remappaient l’historique de Codex App avant l’ajout des sauvegardes réversibles. Fermez d’abord Codex si sa base de données d’historique est verrouillée.

Il s'agit d'un réétiquetage large et destructif : chaque fil contenant un message utilisateur et actuellement marqué `opencodex` passe à `openai`, `exec` est normalisé en `cli` et l'indicateur d'événement est activé. L'historique légitime d'un fournisseur dédié est également concerné. Sauvegardez l'état et n'exécutez la commande que si vous souhaitez cette portée complète.

### `ocx uninstall` · `ocx remove`

Arrête le service et le proxy, supprime le service et le shim Codex, rétablit le fonctionnement natif de Codex, puis supprime la configuration locale d’opencodex uniquement si toutes les étapes de restauration ont réussi. `remove` est un alias de `uninstall`. Le nettoyage de la configuration exige les métadonnées de propriété créées par une installation récente ; les répertoires anciens ou partagés sont conservés.

## État et santé

### `ocx status [--json]`

Affiche un résumé de diagnostic en lecture seule : PID du proxy, accessibilité de `/healthz`, URL du tableau de bord, chemin de configuration, fournisseur par défaut, réglage du démarrage automatique de Codex, état du service, état du shim et répertoire Codex effectif expurgé. Seule la signature explicite et hautement fiable du répertoire d’exécution Windows Orca ajoute un avertissement exploitable lorsqu’il diffère du répertoire de Codex App ; la commande ne modifie jamais `CODEX_HOME` automatiquement.

Après le résumé des connexions OAuth, la sortie destinée aux utilisateurs comprend aussi un bloc **OAuth health** : `OAuth health:
ok` lorsque tous les comptes connus sont sains, ou `OAuth health: warning` accompagné d’une ligne expurgée pour chaque compte en anomalie (fournisseur, identifiant de compte masqué, état tel qu’une réauthentification requise, une limitation de débit ou de quota, ou un conflit d’actualisation), ainsi que d’une indication facultative `Action:`. Les identifiants de compte sont masqués ; les jetons et adresses électroniques ne sont jamais affichés. Le contrat `--json` n’inclut pas encore ce bloc de santé.

```bash
ocx status
ocx status --json
```

Exemple de structure abrégée :

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

L’objet réel comprend également `listen` (port, nom d’hôte, source du runtime et de la configuration), les diagnostics de chargement de la configuration et les diagnostics du plug-in Codex intégré. Le schéma JSON est uniquement extensible : de futures versions peuvent ajouter des champs, mais les champs existants doivent rester stables. Les clés d’API, jetons OAuth, en-têtes d’autorisation, contenus de requêtes, adresses électroniques et identités de compte en sont volontairement exclus.

### `ocx health [--json]`

Vérifie l’identité du proxy actif. La sortie destinée aux utilisateurs indique le PID et le port ; `--json` produit `{ok, pid, port}`. La commande renvoie 0 uniquement lorsque le proxy est sain, et 1 dans le cas contraire, ce qui permet de l’utiliser comme sonde de service.

### `ocx ready [--json] [--wait [--timeout <seconds>]]`

Vérifie l’état de préparation après synchronisation au moyen du point de terminaison non authentifié `GET /readyz`. Il renvoie `200` lorsque le service est prêt, ou `503` avec `Retry-After: 1` pour les états `pending` et terminal `failed`. Son identité HTTP expurgée est `{service, version, uptime, pid, port, status}`. Les anciens proxys dépourvus de `/readyz` échouent de manière sûre avec l’état `unreachable` ; `/healthz` mesure la disponibilité du processus, et non son état de préparation.

Par défaut, la commande effectue une seule sonde. Avec `--wait`, elle interroge le service jusqu’à ce qu’il soit prêt ou jusqu’à l’expiration du délai, mais s’arrête immédiatement si elle observe l’état terminal `failed`. Le délai par défaut est de 45 secondes. `--timeout <seconds>` exige `--wait` et accepte un entier positif compris entre 1 et 300. La sortie JSON de la CLI est `{ready, status, pid, port}`, où `status` vaut `ready`, `pending`, `failed` ou `unreachable`. Les codes de sortie sont 0 si le service est prêt ; 1 s’il n’est pas prêt, reste en attente, échoue, dépasse le délai ou est inaccessible ; et 64 si les arguments sont invalides.

### `ocx doctor`

Exécute des diagnostics en lecture seule sur l’environnement et la connectivité : chemins d’état et type de système de fichiers, installations doubles sous WSL, environnement et configuration du proxy, accessibilité de ChatGPT, avertissements liés au plug-in Codex et à la configuration du projet, ainsi que migration d’historique en attente. La section consacrée au répertoire de Codex App détecte également le cas précis où le répertoire d’exécution Windows Orca ne correspond pas et, le cas échéant, explique la migration du service. Les chemins affichés masquent le nom d’utilisateur du système d’exploitation. La commande doctor propose des réparations, mais ne les applique pas.

La section **OAuth reliability** indique si le stockage des identifiants est accessible en écriture, si les fichiers d’opération unique et de verrouillage nécessaires à l’actualisation peuvent être créés sous `OPENCODEX_HOME`, et quels comptes OAuth ou du pool Codex sont en anomalie, avec des identifiants expurgés et une action de récupération `Action:`. Elle confirme également de manière statique que le chemin de transmission Codex ne fabrique pas de métadonnées de client officiel. La commande doctor ne modifie jamais les identifiants et n’applique aucune réparation.

## Synchronisation du catalogue

### `ocx sync [--restart-codex]`

Récupère la liste active des modèles de chaque fournisseur configuré et réinjecte le catalogue fusionné dans Codex. Exécutez cette commande après l’ajout d’un fournisseur ou pour actualiser les modèles disponibles.

Avant la découverte des fournisseurs ou le remplacement du catalogue et du cache, `ocx sync` vérifie que la configuration Codex gérée peut recevoir l’injection. Si cette validation refuse la configuration, la commande renvoie un code non nul, affiche la cause précise sur stderr et laisse le catalogue ainsi que le cache existants inchangés. `ocx restore back` effectue la même vérification préalable sans écriture avant de réactiver le routage.

Si des processus Codex `app-server` de longue durée sont encore actifs, `ocx sync` avertit qu’ils peuvent continuer à servir l’ancienne liste de modèles conservée en mémoire, même après la mise à jour de `opencodex-catalog.json` / `models_cache.json`. Ajoutez `--restart-codex` pour envoyer `SIGTERM` uniquement aux processus `codex … app-server` et `codex-code-mode-host` correspondants qui appartiennent à l’utilisateur actuel ; les tours actifs peuvent être interrompus. La recherche générale `pkill -f codex` est volontairement évitée.

### `ocx sync-cache [--restart-codex]`

Invalide le cache local du sélecteur de modèles de Codex afin qu’il soit reconstruit à partir du catalogue opencodex actif. Le même avertissement concernant un `app-server` obsolète et le même comportement facultatif `--restart-codex` que pour `ocx sync` s’appliquent.

## Service d’arrière-plan

### `ocx service [install|repair|restart|start|stop|status|uninstall|remove]`

Exécute opencodex comme service d’arrière-plan géré à l’ouverture de session — **launchd** sous macOS, **unité utilisateur systemd** sous Linux et **Task Scheduler** sous Windows — qui démarre automatiquement à la connexion et redémarre après un plantage. Les services définissent `OCX_SERVICE=1` afin qu’un redémarrage ne réécrive pas inutilement la configuration Codex.

| Sous-commande | Action |
| --- | --- |
| aucune | Installe et démarre le service s’il est absent ; sinon, actualise et redémarre le service existant. Une définition Task Scheduler Windows saine est réutilisée ; une définition obsolète peut être réenregistrée et nécessiter une élévation. |
| `install` | Crée et démarre le service. L’enregistrement exige une élévation sous Windows. |
| `repair` | Actualise sur place un service installé et le redémarre. Une définition Task Scheduler Windows saine est réutilisée ; une définition obsolète peut être réenregistrée et nécessiter une élévation. |
| `restart` | Alias de `repair`. |
| `start` | Démarre un service installé. |
| `stop` | Arrête le service et rétablit le fonctionnement natif de Codex. |
| `status` | Affiche les diagnostics du service et du proxy, ainsi que les chemins des journaux. |
| `uninstall` | Supprime le service et rétablit le fonctionnement natif de Codex. |
| `remove` | Alias de `uninstall`. |

```bash
ocx service
ocx service install
ocx service repair
ocx service restart
ocx service status
ocx service uninstall
```

Sous Windows, un `ocx service` nu n'exécute le chemin d'installation qu'après avoir prouvé l'absence à la fois du Task Scheduler et de WinSW. Si l'une des requêtes de statut est inconcluante, il refuse d'enregistrer quoi que ce soit et demande d'exécuter `ocx service status` ; n'utilisez un `ocx service install` explicite qu'après avoir confirmé l'absence.

Avant de signaler une réussite, `install`, `start` et `repair` vérifient, sur les trois plateformes, qu’un proxy répond effectivement sur le port inscrit dans le service installé. Elles attendent jusqu’à 20 secondes, puis affichent le port utilisé :

```text
✅ opencodex service installed and serving on port 10100.
```

Si aucun processus ne répond, elles affichent un avertissement et **renvoient un code non nul** :

```text
⚠️  Service installed, but no proxy answered on port 10100 within 20s.
   The manager registered the job; that is not the same as serving.
   Log:       ~/.opencodex/service.log
   Meanwhile: ocx start   (serves in the foreground)
```

Dans ce cas, un code non nul signifie *enregistré, mais non opérationnel*, et non *non installé*. Le gestionnaire de services a accepté la tâche, mais le proxy n’a jamais ouvert le port. Consultez le journal indiqué et utilisez `ocx start` pour servir temporairement au premier plan.

`ocx service status` distingue les trois mêmes états au lieu d’afficher la sortie brute du gestionnaire :

```text
✅ installed and loaded (launchd; logs: …)
   Serving on port 10100.
```

```text
⚠️  installed and loaded (launchd; logs: …)
   Registered, but no proxy is answering on port 10100.
   launchd is running an OLDER plist than the one on disk.
   Fix:    launchctl bootout gui/$(id -u)/com.opencodex.proxy && ocx service repair
   Log:    ~/.opencodex/service.log
   Repair: ocx service repair
   Meanwhile: ocx start           (serves in the foreground)
```

La commande n’affiche plus la ligne brute `launchctl list` / `systemctl status`, qui présentait une tâche enregistrée de la même manière qu’elle serve effectivement, n’écoute sur aucun port ou utilise une ancienne définition. La ligne `Diagnostics:` contient toujours le chemin du journal et toute détection de chemin périmé inscrit dans le service.

Sous Windows, le moteur du planificateur conserve sa sortie d’état plus détaillée, qui distinguait déjà l’enregistrement dans Task Scheduler de l’accessibilité du proxy.

Sous macOS, cette vérification couvre aussi un échec plus subtil : `launchctl load` peut signaler une erreur sur stderr tout en renvoyant 0. Auparavant, un chargement manqué pouvait donc laisser launchd exécuter une **ancienne** version de la définition du service alors que la commande affichait une coche. `install` échoue désormais explicitement dans ce cas et indique la commande `launchctl bootout` qui supprime la tâche obsolète.

Sous Windows, `ocx service status` distingue l’enregistrement dans Task Scheduler de l’accessibilité du proxy OpenCodex dont l’identité a été vérifiée. Il n’affiche pas le tableau localisé de `schtasks`, afin que le résumé reste lisible quelle que soit la page de codes Windows.

Sous Windows, la création de l’entrée Task Scheduler exige une élévation. Lorsqu’un texte localisé de refus d’accès est reconnu, les consignes existantes sont conservées. Si ce texte est illisible, le mécanisme de repli exige la forme de commande détenue `/create /tn opencodex-proxy /xml <non-empty-path> /f`, le code d’état 1 et la confirmation que le jeton n’est pas élevé ; l’action Startup Safety du tableau de bord peut alors demander automatiquement l’autorisation UAC. Si le mécanisme ne peut pas déterminer l’état du jeton, l’erreur d’origine du planificateur est conservée. Une tâche étrangère ou une autre opération ne peut jamais émettre le marqueur d’élévation automatique. Acceptez la demande UAC du tableau de bord ou réexécutez `ocx service install` dans une fenêtre PowerShell élevée.

Lors d’une nouvelle installation où l’absence de la tâche OpenCodex dans le planificateur est confirmée, l’autorisation UAC est désormais demandée avant l’arrêt d’un proxy existant. Le fichier XML d’enregistrement unique est préparé dans un répertoire privé aux ACL renforcées, en dehors de la racine de configuration OpenCodex, puis la tâche est enregistrée sans être exécutée. Ce n’est qu’après la réussite de cet enregistrement qu’OpenCodex supprime le fichier XML, exige des métadonnées de propriété pour une racine de configuration réellement nouvelle, arrête l’ancien processus à l’écoute, supprime et revérifie de manière bornée toute inscription WinSW native, publie les artefacts du service et démarre la tâche planifiée.

Ainsi, l’annulation ou le refus de l’UAC, comme l’impossibilité de revendiquer une nouvelle racine en toute sécurité, laisse en place le proxy fonctionnel et son routage Codex. Les inscriptions existantes ou conflictuelles continuent d’échouer de manière sûre au lieu d’être supprimées dans le cadre d’une annulation approximative.

### `ocx codex-shim <install|status|uninstall|remove>`

Entoure un lanceur `codex` basé sur un script et présent dans PATH avec un script léger de démarrage automatique. Les cibles réelles `codex.exe` restent intactes afin de ne pas casser les appels qui visent précisément cet exécutable.

Avant de valider une installation ou une réparation, OpenCodex exécute le lanceur enregistré avec `--version` en désactivant le démarrage du service. La modification est refusée et annulée si le lanceur résout `codex` vers le shim lui-même, renvoie un code non nul, dépasse cinq secondes, laisse des processus descendants actifs, ou ne peut pas être validé et nettoyé en toute sécurité. `codex-shim install` n’est donc pas inconditionnel. En cas de refus, réinstallez Codex afin que l’entrée PATH désigne un exécutable ou un lanceur concret, puis recommencez. Utilisez plutôt `ocx service install` lorsqu’un lanceur dynamique fourni par un gestionnaire de commandes ne peut pas satisfaire ces contrôles.

Pendant une mise à niveau, un shim Unix installé qui ne contient pas la garde de validation actuelle est régénéré et testé. Si son lanceur enregistré n’est pas sûr, OpenCodex supprime le shim obsolète et rétablit le lanceur d’origine au lieu de conserver l’enveloppe dangereuse.

L’installation du lanceur ne prouve pas à elle seule que les requêtes Codex passeront par OpenCodex. Après une installation saine, la commande examine le routage Codex actuel et affiche un avertissement plutôt qu’un résultat positif lorsque le routage est externe, appartient à l’utilisateur ou ne peut pas être vérifié. Elle avertit aussi lorsque des variables de proxy sortant n’existent que dans le processus actuel alors que `config.proxy` est absent ou non résolu, car les lanceurs Codex et les services d’arrière-plan peuvent ne pas hériter de cet environnement. Ces contrôles sont en lecture seule et n’affichent jamais la valeur du proxy. Corrigez le transfert signalé et exécutez `ocx doctor` avant de compter sur le démarrage automatique.

Si une mise à jour externe achevée de Codex remplace un shim installé, la prochaine commande `ocx` ordinaire sauvegarde le nouveau lanceur stable et rétablit le shim avant de répartir la commande. La commande d’inspection sans effet `ocx system codex-cli-update check` et les invocations mal formées de son espace de noms réservé `ocx system codex-cli-update` n’effectuent jamais cette réparation. Un lanceur encore en cours de modification reste intact et sera réexaminé plus tard. Un échec de réparation produit un avertissement sans faire échouer la commande demandée. Repli manuel : `ocx codex-shim install`. Définissez `codexShimAutoRestore` sur `false`, ou `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` pour désactiver ce comportement au niveau du processus.

| Sous-commande | Action |
| --- | --- |
| `install` | Installe le shim, ou le répare s’il est obsolète. |
| `uninstall` | Supprime le shim et rétablit le binaire Codex d’origine. |
| `remove` | Alias de `uninstall`. |
| `status` | Indique si le shim est installé, obsolète ou absent. |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service ou shim]
Utilisez `ocx service` pour maintenir un proxy d’arrière-plan toujours actif, ce qui est recommandé. Utilisez `ocx codex-shim` pour un démarrage léger à la demande, sans démon : le proxy ne démarre que lorsque `codex` est lancé.
:::

### `ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Installe et contrôle l’icône OpenCodex dans la zone de notification Windows. Elle démarre à l’ouverture de session et fournit des commandes du proxy accessibles en un clic. `start` et `stop` contrôlent uniquement l’icône ; utilisez son menu pour contrôler le proxy. `--no-start` s’applique à `install` et installe l’icône sans la lancer immédiatement.

## Tableau de bord

### `ocx gui`

Ouvre le [tableau de bord Web](/fr/guides/web-dashboard/) à l’adresse `http://localhost:<port>` et démarre automatiquement le proxy s’il n’est pas actif.

## Mise à jour

`ocx update` met à jour OpenCodex lui-même, et non la CLI Codex. Utilisez `ocx system codex-cli-update check` parmi les [commandes d’inspection système](/fr/reference/cli/agents/) pour vérifier, de façon bornée et en lecture seule, la provenance du candidat Codex CLI configuré. Cette commande n’interroge aucun registre de paquets et n’installe aucune mise à jour.

### `ocx update [--tag latest|preview]`

Met à jour opencodex depuis npm. Les installations stables utilisent `@latest` ; les préversions restent sur `@preview`, sauf si vous indiquez `--tag latest|preview`. La commande détecte un dépôt de sources et vous invite alors à exécuter `git pull && bun install`. Elle ne fait rien si la version la plus récente correspondant à cette balise est déjà installée.

Avant tout arrêt, les installations npm effectuent sous Unix un contrôle borné de la propriété et de l’accès au cache. Les liens symboliques imbriqués sont examinés avec `lstat`, sans être suivis ; Windows ignore explicitement ce contrôle propre à Unix. En cas d’échec, l’opération s’interrompt tandis que l’icône et le proxy fonctionnent encore. Le proxy actif est ensuite arrêté avant le remplacement des fichiers. Un service installé est reconstruit et redémarré automatiquement ; pour une installation au premier plan, la commande indique `ocx start` comme étape suivante. Avant leur conservation, les enregistrements de mise à jour du tableau de bord masquent les chemins de profil et de cache ainsi que les valeurs UID/GID.

```bash
ocx update
ocx update --tag preview
```

Les nouvelles versions deviennent disponibles lorsque le [workflow de publication](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml) les publie sur npm.
