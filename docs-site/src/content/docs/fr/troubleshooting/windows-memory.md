---
title: Croissance de la mémoire sous Windows
description: Pourquoi le processus bun peut utiliser plusieurs gigaoctets de RAM sous Windows, les mesures actuellement prises par opencodex et les solutions possibles dans l’attente des correctifs de Bun.
---

Sous Windows, certains utilisateurs constatent que le processus `bun` derrière opencodex atteint plusieurs gigaoctets de RSS au cours de longues sessions en flux continu (problème signalé dans [#314](https://github.com/lidge-jun/opencodex/issues/314)). Cette page explique avec transparence ce qui se produit réellement et les mesures que vous pouvez prendre.

## Cause première : problèmes en amont dans le runtime Bun

opencodex intègre le runtime Bun (actuellement en version **1.3.14**). Cette croissance de la mémoire provient de problèmes connus en amont dans Bun, et non de fuites au niveau du code JavaScript du proxy :

| Problème Bun | État (vérifié le 2026-07-23) |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — la contre-pression à la réception de `fetch()` n’est pas couplée à la consommation côté JS | Corrigé par la [PR #29831](https://github.com/oven-sh/bun/pull/29831) ; **la version qui inclut ce correctif n’a pas été vérifiée** — nous partons du principe que la version 1.3.14 intégrée ne l’inclut pas |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — plantage lorsqu’un client interrompt un flux à extraction asynchrone | Le correctif de la [PR #32120](https://github.com/oven-sh/bun/pull/32120) a été fusionné le 2026-06-21 ; nous ne le considérons pas comme présent dans la version 1.3.14. Remarque : ce plantage n’est **pas propre à Windows** (il a également été reproduit sous macOS/Linux) |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — fuite de descripteurs de socket `node:net` | Toujours **ouverte** en amont |

Sous Windows, opencodex doit conserver un chemin de code prudent pour diffuser les réponses afin d’éviter le plantage #32111. Or, ce chemin est le plus exposé au problème de contre-pression : lorsqu’un client est lent ou bloqué, le runtime peut continuer à mettre en mémoire tampon des données en amont dans une zone native que JavaScript ne peut pas limiter.

## Mesures actuellement prises par opencodex

Il s’agit d’une atténuation bornée et d’outils d’observation — **pas d’un correctif**. Avec le runtime 1.3.14 intégré, la fuite elle-même reste un problème en amont :

- **Surveillance de la mémoire** — le proxy échantillonne sa propre mémoire toutes les minutes et consigne un avertissement à fréquence limitée lorsque la mémoire observée dépasse 4 GiB. La mémoire observée correspond à la plus grande des valeurs RSS, `external` et `arrayBuffers` (et non à leur somme), car les compteurs d’ensemble de travail/RSS de Windows peuvent sous-estimer la rétention externe validée.
- **`ocx doctor`** — une section « Memory / runtime » affiche la version de Bun du processus de *service*, les compteurs RSS, external/ArrayBuffers, le contexte du tas JS et la décision relative au mode de flux. Avec le runtime Bun 1.3.14 intégré, `heapUsed` / `jscHeap` ne permettent pas à eux seuls de caractériser une fuite ; comparez la mémoire observée à `responseState` et à plusieurs échantillons avant de conclure à une fuite au niveau de l’application.
- **`GET /api/system/memory`** — expose les mêmes données via l’API de gestion authentifiée, à destination des tableaux de bord ou des scripts. Outre les compteurs RSS/heap/external, la réponse contient un bloc scalaire `responseState` (nombre d’entrées, nombre total/maximal d’octets sérialisés et âge de l’entrée la plus ancienne) pour le magasin de continuation en mémoire `previous_response_id` du proxy. Ces données permettent de mieux attribuer la croissance : si `responseState.totalBytes` et la mémoire observée augmentent ensemble, la rétention des conversations est probablement en cause (les longues chaînes `store:false` sont redéveloppées à chaque tour) ; si `responseState` reste stable tandis que la mémoire observée augmente, il faut chercher ailleurs. Les valeurs sont exclusivement scalaires : aucun corps de requête, jeton, chemin ou identifiant de compte n’est exposé. La lecture est dépourvue d’effet secondaire : elle n’élague ni n’expulse jamais de données. La carte **Observabilité de la mémoire** du tableau de bord affiche les mêmes champs et propose une action **Drainer et redémarrer** soumise à confirmation. Elle indique le nombre actuel de tours actifs, attend leur fin jusqu’à 60 s (en réutilisant le drainage existant avec 503 + `Retry-After`), puis interrompt les tours restants. Le proxy actif contrôle l’autorisation du redémarrage et la coordination du drainage, puis se termine ; lorsqu’un gestionnaire de services est installé, il lance le processus de remplacement. L’action ne signale une réussite qu’après avoir vérifié qu’un autre processus, dont l’identité est confirmée, est sain sur le même port, sans retirer l’injection Codex. Ce recyclage est plus long et mieux contrôlé que le court drainage déclenché par `POST /api/stop`.
- **Autre chemin de flux soumis à activation** — un relais borné à lecteur unique qui élimine entièrement le modèle de mise en mémoire tampon non bornée. Sous Windows, il deviendra automatiquement le chemin par défaut dès qu’une version intégrée de Bun inclura de manière vérifiable le correctif #32111 ; pour l’instant, il faut l’activer explicitement (voir ci-dessous). Sous macOS, il restera soumis à une activation explicite même après une telle version : le passage de `auto` sous macOS fera l’objet d’une décision distincte.

L’amélioration réelle du RSS apportée par ces changements reste **à vérifier par des utilisateurs Windows** — nous n’affirmons pas que la fuite est corrigée.

Le redémarrage automatique fondé sur un seuil n’est délibérément **pas** fourni. Si le processus plante, les gestionnaires de services (Task Scheduler/WinSW, launchd, systemd) le redémarrent déjà.

## Solutions possibles

1. **Attendre une mise à jour du runtime intégré.** Dès qu’une version de Bun inclura les correctifs de manière vérifiable, opencodex mettra à niveau son runtime intégré et activera automatiquement le chemin de flux plus sûr sous Windows (macOS continuera d’exiger l’activation explicite ci-dessous).

2. **Utiliser un runtime Bun de confiance avec `OPENCODEX_BUN_PATH`.** Cette configuration n’est pas validée : vous exécutez opencodex avec un runtime que nous n’avons pas testé, à vos risques et périls. Point important pour les installations en tant que service : la valeur de remplacement est lue **lors de la génération de l’artefact du service**, et non au démarrage de celui-ci. Définissez la variable d’environnement, puis réexécutez `ocx service repair` depuis le même shell afin d’inscrire ce chemin dans la définition persistante du service. Définir uniquement la variable d’environnement ne change rien pour un service déjà installé.

3. **Activer le relais borné avec `streamMode: "eager-relay"`.** Deux méthodes sont possibles : modifiez `config.json` (ajoutez `"streamMode": "eager-relay"`) ou appelez l’API de gestion — une requête `PUT /api/settings` avec `{"streamMode":"eager-relay"}` s’applique aux nouveaux tours sans redémarrage. **Avertissement relatif au risque de plantage :** avec Bun 1.3.14, ce réglage utilise la forme de flux concernée par #32111, qui peut faire planter le processus en cours de diffusion (sur tous les systèmes d’exploitation, pas uniquement Windows). Le gestionnaire de services le redémarrera, mais les requêtes en cours échoueront. `"legacy-tee"` impose le mode par défaut actuel. Sous Windows, `"auto"` (valeur par défaut) laisse le runtime décider. Sous macOS, `"auto"` conserve toujours le mode tee ; `"eager-relay"` constitue l’activation explicite.

Si vous essayez l’une de ces solutions avec une charge Windows réelle, veuillez publier les sections de mémoire de `ocx doctor` avant et après dans [#314](https://github.com/lidge-jun/opencodex/issues/314) — c’est précisément la vérification attendue pour cette mesure d’atténuation.
