---
title: Liaison distante
description: Connecter un ordinateur OpenCodex Home à un ordinateur Child avec SSH.
---

Une liaison entre machines connecte un ordinateur OpenCodex **Home** à un ordinateur **Child** avec SSH. Home sert le trafic de Child par le tunnel SSH, et les deux ordinateurs gardent leur service OpenCodex local sur le port `10100`. Le tableau de bord transmet la clé de liaison propre à Child par SSH, sans vous demander de saisir un jeton.

## Conditions requises

- Home peut se connecter à Child avec une clé OpenSSH.
- OpenCodex est installé sur Child.
- Les deux ordinateurs utilisent macOS ou Linux.
- Le tableau de bord Home dispose d’une session appairée complète.

SSH par mot de passe, Windows et la liaison initiée par Child ne font pas partie du flux actuel. Le flux initié par Child est **bientôt disponible**.

## Ajouter un Child depuis `#remote`

1. Ouvrez le tableau de bord sur `#remote` et activez Remote Link.
2. Choisissez **Home**.
3. Sélectionnez **Add child**.
4. Choisissez un hôte parmi les candidats SSH, ou saisissez un alias de configuration SSH.
5. Lancez le test de connexion et comparez l’empreinte proposée avec celle de l’ordinateur visé. Cette comparaison aide à détecter un mauvais hôte ou une clé d’hôte modifiée avant que SSH ne lui fasse confiance.
6. Confirmez l’empreinte, puis connectez Child.

Le tableau de bord ne demande pas de saisir un jeton. Il sonde d’abord l’hôte et ne peut appliquer la liaison qu’après votre confirmation explicite de l’empreinte.

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

## Sécurité

Child utilise les fournisseurs et les identifiants de fournisseur de l’ordinateur Home via la liaison. Home crée une clé distincte pour chaque Child ; la suppression de la liaison révoque cette clé. Comparez l’empreinte de l’hôte avant de confirmer afin de ne pas accepter par erreur une mauvaise machine ou une clé modifiée. Les sessions du tableau de bord émises depuis une identité Tailscale ne peuvent pas gérer les liaisons.

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
