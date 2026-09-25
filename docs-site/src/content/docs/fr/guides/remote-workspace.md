---
title: Espace de travail distant
description: Conservez Codex, Claude Code, Pi et leurs connexions sur un même OCX Hub, tandis que des ordinateurs équipés seulement d'OCX fournissent l'espace de travail et l'environnement de compilation.
---

Pour les liaisons SSH entre machines, consultez [Liaison distante](/fr/guides/remote-link/).

Remote Workspace permet à un OpenCodex Hub d'exécuter vos agents de programmation tandis qu'un
autre ordinateur fournit les fichiers du projet, les commandes, les tests et la puissance de
calcul. Un téléphone ou un troisième ordinateur peut piloter la session depuis le tableau de
bord du Hub.

```text
Phone browser -> Computer 1 OCX Hub -> encrypted channel -> Computer 2 OCX Executor
                 Codex / Claude / Pi                       project and commands
                 logins and sessions                      no coding CLI login
```

L'Executor n'a besoin que d'OpenCodex. Il n'a besoin ni de Codex, ni de Claude Code, ni de Pi,
ni d'une connexion ChatGPT, ni d'une clé API de fournisseur. Il ouvre une connexion WebSocket
sortante vers le Hub : aucun port public ni transfert de port du routeur n'est nécessaire.

:::caution[Base expérimentale]
Remote Workspace est facultatif et n'est pas déployé en production. Linux offre les outils de
fichiers et, sous conditions, l'exécution de commandes avec bubblewrap. Windows et macOS
n'offrent que les outils de fichiers : leurs assistants natifs officiels rejettent les requêtes
de sonde et de commande. Les commandes Windows restent non prises en charge jusqu'à ce qu'un
responsable vérifié du cycle de vie puisse conserver la capacité de nettoyage pendant une
annulation. L'absence de prise en charge des commandes ne provoque jamais leur exécution sur le
Hub.
:::

## Configurer le Hub

L'ordinateur 1 détient toutes les connexions aux agents de programmation et toutes les sessions
de modèle. Installez et connectez-y les agents voulus, puis démarrez OpenCodex comme Hub :

```bash
ocx config set runtimeRole hub
OCX_REMOTE_WORKSPACE_ENABLED=1 ocx start
ocx gui
```

Définissez `OCX_REMOTE_WORKSPACE_ENABLED=1` sur le processus du Hub lui-même. Le définir
seulement pour une commande du tableau de bord n'active pas un service déjà en cours. Sans
activation explicite, le Hub renvoie un état désactivé, sans créer de clés d'espace de travail
ni sonder les environnements d'agents de programmation.

Utilisez un déploiement HTTPS authentifié si vous ouvrez le tableau de bord depuis un téléphone
ou un autre ordinateur. Consultez [Déploiement Remote Hub](/fr/guides/remote-hub/) pour le modèle
pris en charge d'entrée de gestion et de Tailscale. Ne publiez pas un port de tableau de bord
local sans authentification.

Remote Workspace avec Codex utilise les profils d'autorisation actuels d'App Server. Si la
configuration Codex sélectionnée sur le Hub définit encore `sandbox_mode` ou
`sandbox_workspace_write`, le tableau de bord signale Codex comme indisponible plutôt que de
le lancer avec une frontière affaiblie. Migrez ce profil Codex avant d'utiliser la fonction ;
ne configurez pas simultanément l'ancien bac à sable et un profil d'autorisation.

## Associer un Executor

1. Ouvrez **Remote Workspace** dans le tableau de bord du Hub.
2. Sélectionnez **Create pairing code**.
3. Sur l'ordinateur 2, placez-vous dans le répertoire du projet à exposer.
4. Copiez la commande **Linux / macOS terminal** ou **Windows PowerShell** générée pour cet
   ordinateur. Elle associe le répertoire actuel et maintient
   `ocx remote-workspace agent` connecté dans ce terminal.

Le parcours manuel équivalent est :

```bash
cd /path/to/project
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD"
ocx remote-workspace agent
```

Sous Windows PowerShell, utilisez la commande affichée dans le tableau de bord. Sa forme
manuelle équivalente est :

```powershell
$pairingCode = 'ONE-TIME-CODE'
$pairingCode | ocx remote-workspace pair 'https://your-hub.example' `
  --pairing-code-stdin --root (Get-Location).Path
if ($LASTEXITCODE -eq 0) { ocx remote-workspace agent }
```

L'exécutable OCX Bun actuel est ajouté automatiquement comme fichier unique en lecture seule
au bac à sable Linux. Si le projet a besoin d'une chaîne d'outils installée par l'utilisateur
hors des chemins système, associez-la explicitement sans exposer le reste du répertoire
personnel :

```bash
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD" \
  --toolchain-root "$HOME/.nvm/versions/node/v24/bin"
```

Le code source de l'assistant natif est fourni pour examen. Le compiler n'active pas les
commandes Windows ou macOS dans cette version. `--executor-helper` reste un sélecteur
d'assistant examiné ; la présence d'un binaire ou d'un chemin configuré ne prouve pas la prise
en charge des commandes.

Le code à usage unique est lu depuis l'entrée standard, pas depuis les arguments de ligne de
commande. L'association crée une clé locale de signature d'appareil et un jeton porteur propre
à cet appareil. Le Hub ne conserve que son empreinte et ne reçoit jamais le chemin réel de
l'Executor. Arrêtez l'agent au premier plan avec Ctrl+C ; un nouveau lancement reconnecte le
même appareil.

Vérifiez l'inscription locale sans afficher de secrets :

```bash
ocx remote-workspace status
```

## Démarrer une session de programmation distante

Dans le tableau de bord, choisissez :

1. l'ordinateur connecté ;
2. un dossier d'espace de travail approuvé localement ;
3. Codex, Claude Code ou Pi depuis le Hub ; et
4. un mode d'accès.

**Read only** est le mode par défaut ; il permet de lister les répertoires et de lire les
fichiers. L'option d'écriture apparaît sous le nom **Edit files and run commands** uniquement
si l'Executor a réussi la sonde du bac à sable de commandes ; sinon, elle s'appelle
**Edit files only**. Le tableau de bord montre deux emplacements distincts pour indiquer que
le modèle et la connexion restent sur le Hub, tandis que les opérations sur l'espace de travail
s'exécutent sur l'ordinateur sélectionné.

Envoyez des invites depuis le tableau de bord du Hub sur l'ordinateur 1, l'ordinateur 3 ou un
téléphone. La session ne peut pas changer silencieusement d'ordinateur ou de dossier. Si
l'Executor se déconnecte, elle passe à l'état **Executor offline** et n'utilise jamais le
système de fichiers du Hub en repli.

L'envoi d'une invite reçoit aussitôt un accusé d'acceptation ; le tableau de bord interroge la
session pour suivre sa progression et son achèvement. Si l'accusé se perd, le brouillon reste
visible avec un avis indiquant que l'envoi est incertain. Vérifiez la progression de la session
avant de renvoyer l'invite : le tableau de bord ne réessaie jamais automatiquement.

**Stop** reste disponible pendant l'exécution d'une invite. Il interrompt le tour de l'agent
sur le Hub, annule une commande Executor active et empêche une réponse tardive de rouvrir la
session arrêtée.

## Redémarrage et reconnexion

Le Hub conserve des métadonnées de session limitées et un petit instantané des événements
récents. Après son redémarrage, une session inachevée attend son Executor d'origine. Une fois
cet appareil reconnecté, l'invite suivante reprend le fil Codex, la session Claude Code ou
l'identifiant de session Pi d'origine.

Claude Code crée son historique durable après la première invite terminée. Si le Hub s'arrête
avant qu'une nouvelle session Claude ait terminé une invite, aucune conversation ne peut être
reprise : démarrez plutôt une nouvelle session.

Une modification du manifeste de capacités n'affaiblit pas silencieusement une session
existante. Démarrez une nouvelle session si l'Executor perd le confinement des commandes ou si
ses outils disponibles changent. La révocation d'un ordinateur ferme sa connexion et arrête les
sessions qui y sont liées.

## Frontières de sécurité

- Les identifiants fournisseur et l'historique des agents de programmation restent sur le Hub.
- Les clés privées de l'Executor, son jeton d'appareil et ses vrais chemins racine restent dans
  son état OCX accessible uniquement au propriétaire.
- Les échecs de code d'association sont limités par pair observé par le noyau sur chaque
  écouteur. Dix codes erronés en dix minutes renvoient un `429` générique avec
  `Retry-After` ; le Hub ne conserve que des empreintes limitées et expirantes de ces
  identités source. Les utilisateurs de Tailscale Serve partagent la limite de boucle locale
  de l'écouteur de gestion, car un appelant local direct pourrait usurper son en-tête
  d'identité.
- Chaque session de travail utilise une négociation ECDH P-256 éphémère signée avec Ed25519
  et des messages AES-256-GCM ordonnés.
- Une connexion n'apparaît comme active qu'après l'accord des deux parties sur son manifeste
  actuel de capacités.
- Une reconnexion peut retirer une capacité si le bac à sable local est indisponible, mais
  n'ajoute jamais de capacité hors de l'autorisation enregistrée lors de l'association.
- Chaque requête est liée à un fil de modèle, un appareil, une racine, un mode d'accès et un
  ensemble de capacités.
- Les chemins sont relatifs, canonisés et limités ; les sorties par lien symbolique,
  jonction ou répertoire parent sont refusées. Les noms d'appareil Windows, les flux de
  données alternatifs et les alias terminés par un point ou un espace sont interdits.
- Les opérations de l'Executor sont sérialisées ; les identités des fichiers ouverts sont
  revérifiées et les empreintes d'écriture contrôlées juste avant le remplacement atomique.
  Remplacer une racine approuvée impose de la réassocier, et les racines des chaînes d'outils
  sont revalidées avant chaque commande.
- Les lectures et écritures refusent les fichiers liés par liens physiques. Avant toute
  exécution de commande, OCX examine au plus 250 000 entrées de l'espace de travail et
  désactive les commandes si une entrée autre qu'un répertoire possède plusieurs liens : un
  bac à sable de chemins ne peut pas prouver que l'autre nom de cet inode se trouve dans la
  racine approuvée.
- Sous Linux, les commandes passent par bubblewrap avec un seul espace de travail inscriptible,
  un environnement effacé, des espaces de noms de processus privés, l'exécutable OCX Bun actuel
  comme fichier unique en lecture seule, une sortie et une durée limitées, et un réseau
  désactivé par défaut. Les tests de confinement dédiés exigent un environnement hébergé
  explicitement configuré ; une suite générique verte ne prouve pas leur exécution.
- macOS n'annonce que les outils de fichiers. Un groupe de processus ne peut retenir un
  descendant après un appel à `setsid()`, et importer un profil système Apple Seatbelt étendu
  seulement pour lancer une commande exposerait une autorité sans rapport sur les services de
  l'hôte. L'assistant natif rejette donc sa sonde et les commandes directes tant qu'OCX ne
  dispose pas d'un responsable de confinement des descendants précis et révocable.
- Les requêtes de commandes natives Windows et macOS échouent de façon sûre. Les tests de
  refus direct par l'assistant ne doivent pas être confondus avec des preuves de confinement
  fonctionnel des commandes ; leur acceptation sous Windows reste à réaliser.
- L'assistant natif épinglé doit se trouver hors de tout espace de travail inscriptible
  approuvé. OCX le vérifie avant d'annoncer la prise en charge des commandes et juste avant
  chacune, afin que le code du projet ne puisse pas remplacer le binaire chargé d'appliquer
  le bac à sable suivant.
- Arrêter une session annule une commande Executor active et nettoie le processus de modèle
  du Hub ainsi que le pont d'outils en boucle locale. Windows arrête l'arborescence du
  processus wrapper npm possédé, sans laisser son enfant Node actif ; Linux et macOS forcent
  l'arrêt d'une CLI seulement si elle ignore la période d'arrêt gracieux.

Le Hub voit volontairement les invites et les réponses du modèle, puisqu'il exécute l'agent.
Le chiffrement de bout en bout protège les charges RPC de l'Executor. Le Hub associé est
autorisé à choisir des racines approuvées via WSS authentifié ; il peut lire sa propre
conversation avec le modèle.

## Périmètre actuel

Remote Workspace ne copie ni ne synchronise les identifiants vers d'autres ordinateurs. Cette
fonction est distincte du routage des fournisseurs de Remote Hub et de tout futur produit de
calcul hébergé ou Super Sync. Une sortie en production exige encore un empaquetage signé de
l'assistant Windows, des preuves CI natives sur les binaires exacts, une revue indépendante
d'un mainteneur et un essai réel sur trois ordinateurs.

## API d'acceptation des invites

`POST /api/remote-workspace/sessions/:id/prompt` renvoie HTTP 202 avec l'instantané de session
acceptée. Son identifiant de session et sa séquence d'événements monotone identifient cet
instantané ; 202 ne signifie pas que le tour du modèle est terminé. Interrogez
`GET /api/remote-workspace/sessions` pour les événements ultérieurs et l'état final. La
reconnexion et la reprise de l'environnement restent occupées pendant ce tour. Si l'accusé
de réception se perd, l'acceptation reste incertaine : les clients doivent interroger la
session avant de décider d'envoyer de nouveau l'invite.
