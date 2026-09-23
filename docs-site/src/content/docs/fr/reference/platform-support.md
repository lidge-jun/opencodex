---
title: Prise en charge des plateformes
description: Ce qu'OpenCodex peut faire sur macOS, Windows et Linux, et pourquoi certaines fonctions restent propres à une plateforme.
---

OpenCodex fonctionne sur macOS, Windows et Linux. La plupart de ses fonctions se
comportent de la même façon sur les trois systèmes ; certaines dépendent de ce
que fournit le système d'exploitation. Cette page précise lesquelles et pourquoi.

## Sur toutes les plateformes

| Fonction | Remarques |
| --- | --- |
| Proxy, routage, adaptateurs de fournisseurs | Le cœur de l'exécution est indépendant de la plateforme. |
| Service en arrière-plan | Trois mécanismes natifs : launchd sur macOS, Task Scheduler **ou** WinSW sur Windows, une unité systemd utilisateur sur Linux. |
| Connexion dans le navigateur | S'ouvre avec le gestionnaire propre à la plateforme. |
| Détection des clients | Les installations de Cursor, Claude Desktop, Kiro et Codex sont localisées selon la plateforme. |

### Clés fournisseur dans le magasin d'identifiants du système

Cette fonction est prise en charge sur les trois plateformes **si un service
d'identifiants système déverrouillé est disponible** : Keychain sur macOS,
Credential Manager sur Windows et libsecret sur Linux. Un trousseau verrouillé
ou une session sans interface n'offre aucun service déverrouillé ; OpenCodex
signale alors l'indisponibilité du magasin au lieu de basculer silencieusement
vers un autre mode. Consultez [Fournisseurs](/fr/reference/configuration/providers/)
pour les règles de stockage.

## macOS uniquement

### Connexion automatique de Claude Code

L'injection de `ANTHROPIC_BASE_URL` et des paramètres de Claude Code dans votre
session passe par le domaine utilisateur launchd, qui n'a pas d'équivalent unique
ailleurs.

Sous Linux, les trois mécanismes plausibles touchent chacun des processus
différents : `systemctl --user set-environment` n'atteint que les unités lancées
par systemd, `~/.profile` uniquement les shells de connexion, et `~/.bashrc`
uniquement les shells interactifs sans connexion. Aucun emplacement ne couvre
toute la session d'un utilisateur.

Sous Windows, l'équivalent est `HKCU\Environment`, qui persiste réellement
plutôt que de disparaître au redémarrage. C'est précisément le problème : cela
déplacerait un jeton porteur d'un domaine vidé au redémarrage vers une ruche du
registre qui ne l'est pas, modifiant la durée de présence de l'identifiant sur
le disque et les personnes qui peuvent le lire. Une telle décision exige une
revue de sécurité, pas une simple adaptation.

Tout le reste dont Claude Code a besoin fonctionne sur toutes les plateformes.
Vous pouvez définir les mêmes variables vous-même ou exécuter `ocx claude`,
qui les transmet directement au processus enfant.

## Importation ou collage

### Meta Muse Code

Sur macOS, OpenCodex importe la clé API déjà enregistrée par la CLI Muse Code
après `muse login` : vous n'avez pas à en fournir une seconde.

Ailleurs, OpenCodex vous demande de coller la clé. Meta ne distribue aucune CLI
Windows native ; sous Linux, la CLI existe, mais l'emplacement de ses
identifiants n'a pas été vérifié. OpenCodex évite donc de deviner le magasin.
La même clé figure dans la [console développeur de Meta](https://dev.meta.ai),
et une clé collée passe les mêmes contrôles de format et la même validation en
direct auprès de l'API Model qu'une clé importée.

## Remarques pour Windows

Le service Windows peut fonctionner via Task Scheduler ou comme service WinSW
natif ; ces deux modes s'excluent mutuellement. `ocx service repair` refuse de
continuer s'il trouve un état pour les deux, car deviner lequel vous vouliez
risquerait de laisser deux proxys se disputer un port.

Sur une installation Windows dans une autre langue que l'anglais, la sortie de
la console utilise la page de code du système plutôt que UTF-8. OpenCodex la
décode en conséquence, afin qu'un nom de compte comportant des caractères non
ASCII soit correctement reconnu.

## Lorsqu'une fonction est indisponible

OpenCodex indique la cause réelle au lieu de désactiver silencieusement un
contrôle. Si une fonction n'est pas disponible sur votre plateforme, l'erreur
ou le tableau de bord précise le mécanisme manquant et la solution prise en
charge. Si vous rencontrez un cas qui ne le fait pas, signalez ce bogue.
