---
title: Codex ne peut pas se connecter ou charger
description: Que faire si la connexion à Codex échoue ou si chaque requête produit une erreur après la configuration d'opencodex, et comment rendre à Codex son propre compte sans démarrer le proxy.
---

Si Codex reste bloqué sur l'écran de connexion, indique qu'il ne peut pas
charger les conditions de connexion, ou échoue à chaque requête de modèle après
la configuration d'opencodex, il pointe probablement encore vers le proxy
opencodex alors que celui-ci ne fonctionne pas. Ce cas a été signalé dans
[#5261](https://github.com/lidge-jun/opencodex/issues/5261).

## Pourquoi cela se produit

Avec la configuration locale par défaut, opencodex ne donne pas à Codex un
fournisseur distinct. Il dirige le fournisseur `openai` intégré à Codex vers le
proxy en écrivant une substitution à la racine de `$CODEX_HOME/config.toml`
(`%USERPROFILE%\.codex` sous Windows) :

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex (undo: ocx restore)
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex (undo: ocx restore)
experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"
```

Ces lignes restent sur le disque après un redémarrage. Si le proxy ne fonctionne
pas au démarrage de Codex, cette adresse ne répond pas et Codex n'a aucun autre
point de terminaison de repli. L'écran affiché ne mentionne pas opencodex, ce
qui rend cet état facile à confondre avec un problème propre à Codex.

Le proxy peut être absent pour des raisons ordinaires. Appliquer l'intégration
Codex n'installe pas de service en arrière-plan : c'est l'étape distincte
`ocx service install`. Après un redémarrage, rien ne lance donc nécessairement
le proxy. Une tâche planifiée Windows enregistrée démarre à l'ouverture de
session et non au démarrage de la machine ; elle peut aussi être désactivée,
échouer au lancement ou trouver le port occupé par un autre processus.

## Rétablir le fonctionnement de Codex

Choisissez le résultat souhaité. Les deux options fonctionnent même si le
proxy est arrêté.

**Rendre à Codex son propre compte et ses propres points de terminaison :**

```bash
ocx restore
```

Cette commande retire le routage injecté, la substitution realtime et le
pointeur vers le catalogue opencodex. Elle ne nécessite ni proxy actif, ni
session de tableau de bord, ni réseau. Codex peut ensuite se connecter et
fonctionner normalement. Pour revenir ultérieurement à opencodex,
`ocx restore back` redirige Codex vers le proxy.

**Ou redémarrer le proxy :**

```bash
ocx start
ocx service install   # keep it running across restarts
```

`ocx status` indique si le proxy répond et si Codex passe actuellement par lui.
`ocx doctor` explique cet état plus en détail et recommande une réparation.

## Si ocx n'est pas disponible

Vous pouvez annuler le routage manuellement. Ouvrez `$CODEX_HOME/config.toml`
et supprimez trois éléments : la ligne `openai_base_url`, la ligne
`experimental_realtime_ws_base_url` et toute ligne `model_catalog_json` se
terminant par `opencodex-catalog.json`. Supprimez aussi le commentaire
`# Auto-injected by opencodex` immédiatement au-dessus de chacune des deux
premières lignes.

Repérez les lignes par leur nom de clé, pas par le commentaire. opencodex place
le même commentaire de propriété au-dessus d'autres clés qu'il gère, comme
une valeur `developer_instructions` injectée. Les supprimer ne résoudrait pas
la connexion et vous ferait perdre une configuration éventuellement utile.

Supprimez la ligne `model_catalog_json` **avec** le routage, pas seule. Si
`model_catalog_json` désigne un fichier disparu, Codex ne peut plus charger du
tout sa configuration : cela ressemble au même blocage, mais pour une autre
raison.

## Comptes impossibles à ajouter ou à afficher

Un échec d'ajout au Pool, ou l'absence d'un compte ajouté dans la liste, est
distinct du blocage précédent, même si les deux se produisent dans la même
session. Le Pool est servi par l'API de gestion du proxy : le parcours
`ocx account login openai` et la liste du tableau de bord exigent donc d'abord
un proxy actif. La connexion dans le navigateur revient aussi à
`http://localhost:1455/auth/callback`, une adresse fixe qui ne peut pas être
déplacée vers un autre port. Si le port 1455 est occupé ou si aucun navigateur
ne peut être lancé, utilisez plutôt le parcours par appareil :

```bash
ocx account login openai --device
```

Consultez [Intégration de Codex](/fr/guides/codex-integration/) pour connaître
les écritures de l'injection et la façon dont le routage est choisi.
