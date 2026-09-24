---
title: Application de bureau
description: Installez et utilisez l’application de bureau OpenCodex sur macOS, Windows et Linux.
---

L’application de bureau OpenCodex associe une icône native de zone de notification au tableau de bord web. Son CLI intégré cherche un proxy local existant ; l’application ne démarre son environnement d’exécution intégré que si l’absence de proxy est établie.

Le tableau de bord est servi depuis le point de terminaison du proxy local trouvé (port `10100` par défaut). L’application de bureau est une enveloppe locale autour de ce tableau de bord et de son environnement d’exécution intégré.

## Installation

### macOS

Téléchargez `OpenCodex-<version>-macos.dmg` depuis la [dernière version](https://github.com/lidge-jun/opencodex/releases). Ouvrez le DMG et faites glisser `OpenCodex.app` vers Applications. L’application nécessite macOS 13 ou une version ultérieure.

Les versions publiées de `OpenCodex.app` sont signées avec un Developer ID et notariées par Apple. Au premier lancement, macOS ne demande normalement que la confirmation habituelle pour une application téléchargée. S’il la bloque tout de même, utilisez **System Settings → Privacy & Security → Open Anyway**.

### Windows

Téléchargez `OpenCodex-<version>-windows-x64.msi` et lancez l’installation. Windows SmartScreen peut afficher un avertissement, car l’installateur n’est pas encore signé ; choisissez **More info → Run anyway** après avoir vérifié que le téléchargement provient de la page des versions.

### Linux

Téléchargez `OpenCodex-<version>-linux-x86_64.AppImage` ou `OpenCodex-<version>-linux-amd64.deb` depuis la page des versions.

Pour l’AppImage :

```bash
chmod +x OpenCodex-<version>-linux-x86_64.AppImage
./OpenCodex-<version>-linux-x86_64.AppImage
```

Pour les distributions fondées sur Debian :

```bash
sudo apt install ./OpenCodex-<version>-linux-amd64.deb
```

L’icône de zone de notification nécessite un environnement de bureau compatible avec AppIndicator.

## Premier lancement

L’application demande à son CLI intégré d’exécuter `ocx resolve --json` et se connecte à un proxy local accessible s’il en existe déjà un. Elle ne démarre son environnement d’exécution intégré que lorsque le CLI établit l’absence de proxy ; un résultat incertain est affiché comme un échec de démarrage. Le tableau de bord s’ouvre alors dans la vue web de l’application, au point de terminaison loopback trouvé. Un lancement à l’ouverture de session qui démarre masqué dans la zone de notification conserve plutôt la page de démarrage légère et ne charge le tableau de bord qu’à sa première ouverture depuis la zone de notification ou à un nouveau lancement de l’application.

Utilisez l’action **Open dashboard** ou **Open in browser** de la zone de notification pour passer du tableau de bord intégré à votre navigateur habituel. Le menu permet aussi de rechercher les mises à jour.

Sur macOS, fermer le tableau de bord laisse l’application active dans la barre des menus. Ouvrez à nouveau OpenCodex depuis le Dock ou le Finder pour réafficher le tableau de bord sans redémarrer le proxy.

## Utilisation dans la zone de notification

Sur macOS et Windows, cliquez sur l’icône pour ouvrir un panneau compact d’utilisation. L’action **Show usage** l’ouvre également, notamment sous Linux lorsque la zone de notification ne transmet pas les clics. Sous Linux, le tableau de bord s’ouvre au démarrage, même si l’environnement de bureau n’affiche pas d’icône.

Le panneau d’utilisation présente les totaux du jour et des 30 derniers jours, le graphique configuré, une liste compacte de modèles et les limites des fournisseurs et des comptes. Les comptes à rebours de réinitialisation des quotas figurent à côté des barres ; survolez-les pour voir l’heure exacte. Les réglages **Menu bar & widget** existants déterminent les sections et le graphique visibles. Les fournisseurs masqués sont exclus du titre, des totaux, des quotas et du graphique. Le graphique inclut l’activité de l’intervalle de temps en cours. Un indicateur de données partielles signifie qu’une partie des données ne peut pas être attribuée de façon fiable. Les mesures manquantes ne sont pas présentées comme une utilisation nulle. Sous Windows et Linux, faites défiler le panneau pour atteindre Refresh et Dashboard après une longue liste de comptes.

Sur macOS, ce panneau utilise des contrôles SwiftUI natifs et un panneau AppKit défilant. Apple Liquid Glass est utilisé à partir de macOS 26 ; les systèmes plus anciens emploient le matériau natif des fenêtres contextuelles. L’en-tête et les boutons Refresh et Dashboard restent visibles pendant le défilement des longues listes de comptes. Vous pouvez aussi ouvrir le panneau par **View → Show Usage** (Command-Shift-U). Appuyez sur Échap ou cliquez hors du panneau pour le fermer.

Le menu de la zone de notification affiche le nombre de requêtes et de jetons du jour, ainsi que le coût estimé lorsqu’il est activé. Il utilise la même utilisation en jour local que le widget. Choisissez **Refresh now** pour actualiser immédiatement ; l’application actualise aussi les données toutes les 60 secondes. Les préférences d’affichage restent dans la section **Menu bar & widget** du tableau de bord. Désactiver **Today** masque le résumé, et désactiver **Cost** en retire le coût.

Une utilisation indisponible ou explicitement non mesurée est affichée sous la forme `—`, et non comme un zéro mesuré. Choisir un titre composé uniquement de l’icône efface l’ancien compteur. Les abréviations conservent les zéros des nombres entiers : dix millions de jetons s’affichent `10M`, et non `1M`.

## Mises à jour

Choisissez **Check for Updates…** dans le menu pour lancer immédiatement une recherche. Les versions publiées vérifient aussi automatiquement au démarrage, puis toutes les six heures. Les mises à jour sont vérifiées avec la clé publique signée de l’outil de mise à jour du projet avant installation. Sur macOS, les mises à jour intégrées téléchargent `OpenCodex-<version>-macos.app.tar.gz` ; le DMG sert à la première installation. Le manifeste de publication n’est généré que si le secret de la clé de mise à jour est configuré ; les quatre plateformes doivent alors être signées.

## Widget

L’application macOS comprend l’extension OpenCodex WidgetKit. Consultez le [guide de l’application de barre de menus macOS](/fr/guides/macos-menu-bar/) pour installer le widget et comprendre les instantanés locaux.

## Désinstallation

Sur macOS, faites glisser `OpenCodex.app` d’Applications vers la Corbeille. Sous Windows, supprimez OpenCodex depuis **Installed apps**. Sous les systèmes Linux fondés sur Debian, exécutez :

```bash
sudo apt remove opencodex
```

Pour une AppImage, supprimez le fichier téléchargé.

Si les réglages enregistrés de la barre de menus sont illisibles, les modifications partielles sont refusées afin de préserver le fichier. Restaurez-le ou réinitialisez explicitement les réglages du composant associé avant de les modifier à nouveau.
