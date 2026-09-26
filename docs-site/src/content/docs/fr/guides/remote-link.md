---
title: Liaison distante
description: Connecter un ordinateur OpenCodex Home à un ordinateur Child avec SSH.
---

Une liaison entre machines connecte un ordinateur OpenCodex **Home** à un ordinateur **Child** avec SSH. Home sert le trafic de Child par le tunnel SSH, et les deux ordinateurs gardent leur service OpenCodex local sur le port `10100`. Le tableau de bord transmet la clé de liaison propre à Child par SSH, sans vous demander de saisir un jeton.

## Conditions requises

- Home peut se connecter à Child avec une clé OpenSSH.
- Pour une liaison initiée par Child, Child peut se connecter à Home avec une clé OpenSSH (la connexion par mot de passe n’est pas prise en charge).
- OpenCodex 2.66.0 ou ultérieur est installé sur Child (et sur Home pour une liaison initiée par Child).
- Les deux ordinateurs utilisent macOS ou Linux.
- Le tableau de bord qui lance la liaison est ouvert sur cet ordinateur lui-même (navigateur ou application de bureau, installation autonome) ou via une session Hub appairée.

SSH par mot de passe et Windows restent hors du flux actuel. Une liaison peut être lancée des deux côtés : depuis Home, comme décrit ci-dessous, ou depuis Child, comme décrit dans la section « Connecter cet ordinateur comme Child ».

## Ajouter un Child depuis `#remote`

1. Ouvrez le tableau de bord sur `#remote` et activez Remote Link.
2. Choisissez **Home**, puis **Continue**. La liste des hôtes SSH s’ouvre.
3. Choisissez un hôte parmi les candidats SSH, ou saisissez un alias de configuration SSH.
4. Lancez le test de connexion et comparez l’empreinte proposée avec celle de l’ordinateur visé. Cette comparaison aide à détecter un mauvais hôte ou une clé d’hôte modifiée avant que SSH ne lui fasse confiance.
5. Confirmez l’empreinte, puis connectez Child.

Le tableau de bord ne demande pas de saisir un jeton. Il sonde d’abord l’hôte et ne peut appliquer la liaison qu’après votre confirmation explicite de l’empreinte.

## Connecter cet ordinateur comme Child

Sur l’ordinateur qui doit utiliser les fournisseurs de Home :

1. Ouvrez le tableau de bord sur `#remote` et activez Remote Link.
2. Choisissez **Child**. La liste des hôtes SSH s’ouvre.
3. Choisissez l’hôte SSH de Home, lancez le test de connexion, puis comparez et confirmez son empreinte d’hôte.
4. Lisez l’avertissement et choisissez **Connect as Child**.

La connexion redémarre OpenCodex sur cet ordinateur. Les tours Codex déjà en cours se terminent d’abord, et les nouvelles requêtes peuvent échouer pendant une minute au plus pendant le redémarrage. Le tableau de bord se recharge ensuite de lui-même et affiche la liaison Child. Codex continue d’utiliser `http://127.0.0.1:<port>/v1` sur cet ordinateur, sans jeton ni variable d’environnement à définir : l’OpenCodex local relaie chaque requête vers Home, qui y répond avec ses propres fournisseurs et comptes.

Le rôle **Child** n’est disponible que lorsque OpenCodex tourne sur son port configuré, car Child redémarre exactement sur ce port. Si le tableau de bord indique qu’OpenCodex ne tourne pas sur son port configuré, redémarrez-le d’abord sur ce port.

## État de la liaison

- **Connected** signifie que le tunnel SSH est prêt et que Child peut utiliser la liaison Home.
- **Reconnecting** signifie que le tunnel est réessayé. Les requêtes peuvent temporairement renvoyer `503` avec `Retry-After`.
- **Failed** signifie que la liaison nécessite une intervention. Vérifiez l’authentification SSH, la clé d’hôte confirmée, la redirection ou le délai indiqué.

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
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
```

## Guides associés

- [Déploiement Remote Hub](/fr/guides/remote-hub/)
- [Remote Workspace](/fr/guides/remote-workspace/)
