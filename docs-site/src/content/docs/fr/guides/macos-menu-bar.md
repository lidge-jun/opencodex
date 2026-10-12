---
title: Application de barre de menus macOS
description: Utilisez la zone de notification macOS, le panneau natif d’utilisation et le widget de l’application de bureau OpenCodex.
---

L’élément de barre de menus macOS fait partie de l’application de bureau OpenCodex. Il affiche l’utilisation du proxy local et ouvre un panneau natif d’utilisation. La même application comprend aussi le tableau de bord et une extension WidgetKit. Consultez le [guide de l’application de bureau](/fr/guides/desktop-app/) pour l’installation sur les autres plateformes.

## Installation

Téléchargez `OpenCodex-<version>-macos.dmg` depuis la [dernière version](https://github.com/lidge-jun/opencodex/releases). Ouvrez le DMG et faites glisser `OpenCodex.app` vers Applications. L’application de bureau nécessite macOS 13 ou une version ultérieure ; son widget nécessite macOS 14 ou une version ultérieure.

## Premier lancement

Les versions publiées de `OpenCodex.app` sont signées avec un Developer ID, utilisent l’environnement d’exécution renforcé et sont notariées par Apple, avec le ticket joint à l’application. Au premier lancement, macOS ne demande normalement que la confirmation habituelle pour une application téléchargée sur Internet. S’il la bloque tout de même, ouvrez **System Settings → Privacy & Security** et choisissez **Open Anyway** pour OpenCodex. Les applications que vous compilez vous-même reçoivent une signature ad hoc ; consultez [Compilation depuis les sources](#compilation-depuis-les-sources).

À l’ouverture, l’application affiche sa progression de démarrage dans une fenêtre. Elle active **Start at Login** une fois lors du premier lancement ; vous pouvez désactiver ce réglage depuis le menu de la zone de notification. Lors des lancements suivants par l’élément de connexion, la fenêtre reste masquée tandis que l’icône demeure disponible.

## Barre de menus et panneau d’utilisation

Le titre de la barre de menus affiche par défaut le total de jetons du jour. Dans les réglages **Menu bar & widget** du tableau de bord, vous pouvez choisir les requêtes, les jetons, le coût estimé, le quota ou l’icône seule.

Utilisez **Show Usage** dans le menu de la zone de notification pour ouvrir le panneau natif. Selon vos réglages d’affichage, il présente les totaux du jour et des 30 derniers jours, un graphique d’utilisation, une liste de modèles et les limites des fournisseurs et des comptes. Les totaux comprennent les jetons et les requêtes, ainsi que le coût estimé lorsqu’il est activé. Les lignes de quota indiquent leur fenêtre, leur pourcentage et l’heure de réinitialisation. Les mesures manquantes apparaissent sous la forme `—`, et une utilisation partielle est signalée comme incomplète.

Le panneau comporte les contrôles **Refresh**, **Dashboard** et **Settings**. **Dashboard** ouvre la vue d’utilisation dans la fenêtre de bureau ; **Settings** y ouvre les réglages du composant associé. Le menu propose également **Open Dashboard**, **Open in Browser**, **Start at Login**, **Stop proxy**, **Check for Updates…**, l’élément **Install update** lorsqu’une mise à jour est disponible et **Quit**. **Stop proxy** reste affiché, mais n’est activé que si l’application a elle-même démarré le proxy ; un proxy démarré séparément continue de fonctionner. Fermer la fenêtre ou utiliser Command-Q masque l’application lorsque son icône est disponible ; utilisez **Quit** dans le menu pour la quitter.

Le bouton de mise à jour du tableau de bord ouvre la page de mise à jour de l’application ; elle vérifie et installe la même mise à jour signée que le menu de la zone de notification.

Le titre est actualisé toutes les 60 secondes. Tant que le panneau natif est ouvert, ses données sont également actualisées toutes les 60 secondes ; **Refresh** demande une mise à jour immédiate.

## Widget

Sur macOS 14 ou une version ultérieure, ouvrez une fois OpenCodex.app, puis cliquez avec la touche Contrôle sur une zone vide du bureau, choisissez **Edit Widgets**, recherchez **OpenCodex** et ajoutez la taille souhaitée. Selon leur taille, les widgets affichent différentes combinaisons de l’état du proxy, des jetons et requêtes du jour, du coût estimé, des quotas et d’un graphique d’utilisation. L’extension lit un instantané local écrit par l’application de bureau ; il contient des données d’affichage, sans clés API ni données brutes de compte. L’application actualise l’instantané du widget tous les cinq cycles de 60 secondes de l’icône, soit environ toutes les cinq minutes lorsque le proxy est connecté. WidgetKit demande aussi une nouvelle chronologie après cinq minutes.

## Connexion au proxy

L’application de bureau demande à son CLI intégré d’exécuter `ocx resolve --json`. Elle se connecte à un proxy local existant et accessible, ou ne démarre son environnement d’exécution intégré que si le CLI établit qu’aucun environnement n’écoute. Si la découverte reste incertaine, le démarrage signale le problème au lieu de lancer un second proxy. L’application communique avec le port trouvé sur `127.0.0.1`.

Pour les requêtes de gestion, l’application essaie d’abord sans jeton. Si le proxy répond HTTP 401, elle réessaie avec `OPENCODEX_ADMIN_AUTH_TOKEN` provenant de son environnement ou avec le fichier `admin-api-token` du répertoire de configuration trouvé. Elle n’utilise pas le trousseau macOS pour ce jeton. L’enveloppe de bureau ne peut pas se connecter à un proxy lié uniquement à une adresse qu’elle ne peut pas joindre en loopback.

## Compilation depuis les sources

Sur macOS 13 ou une version ultérieure, avec Bun, Rust et les outils Swift/Xcode pour macOS, compilez le tableau de bord depuis la racine du dépôt, puis exécutez les commandes de bureau depuis `desktop/` :

```bash
bun install
bun run build:gui
cd desktop
bun install
bun run prepare-sidecar
bun run prepare-widget
bun run build:local
```

`build:local` produit l’application locale et le DMG sans exiger de clé de signature pour l’outil de mise à jour Tauri. Une commande directe `bunx tauri build` exige `TAURI_SIGNING_PRIVATE_KEY`, car elle produit également un artefact de mise à jour. La compilation du widget utilise une signature ad hoc sauf si `MACOS_SIGN_IDENTITY` est défini, et les paquets de bureau locaux sont également signés ad hoc. L’application fonctionne, mais macOS n’enregistre pas une extension de widget signée ad hoc ; une compilation locale n’affiche donc généralement aucun widget OpenCodex. `build:local` signe toujours l’application ad hoc : définir seulement `MACOS_SIGN_IDENTITY` ne suffit pas. Le widget n’est enregistré que si l’application et l’extension sont toutes deux signées par la même équipe Developer ID, comme dans la version publiée. Utilisez une version publiée si vous avez besoin du widget.

## Désinstallation

Désactivez **Start at Login** dans le menu si vous l’aviez activé, puis déplacez `OpenCodex.app` d’Applications vers la Corbeille. Cela supprime le CLI intégré et l’extension du widget, mais ne supprime ni l’état `$OPENCODEX_HOME` du proxy ni un service `ocx` installé séparément. L’application de bureau écrit également un identifiant d’installation et des marqueurs d’élément de connexion dans son répertoire de configuration, ainsi qu’un instantané du widget sous `~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json` ; déplacer l’application vers la Corbeille ne supprime pas ces fichiers.
