---
title: Cursor Private Inference
description: Utilisez les modèles routés par opencodex dans la version de Cursor à agent local, sur macOS, Windows ou Linux, sans tunnel public.
---

Cursor classique ne peut pas communiquer avec un proxy sur votre propre machine. Lorsque vous définissez « Override OpenAI Base URL », le backend de Cursor construit la requête et appelle cette URL depuis les serveurs de Cursor, qui rejettent les adresses loopback, de réseau local et privées. C’est pourquoi les recettes communautaires pour Cursor avec des modèles locaux se terminent par ngrok, Cloudflare Tunnel ou un VPS.

Cursor distribue également une seconde version de bureau, **Cursor Private Inference**, dont la boucle d’agent s’exécute localement et appelle une passerelle compatible OpenAI que vous configurez. Dirigée vers opencodex, elle utilise vos modèles routés sans tunnel, sans modifier l’application et sans TLS. Cette page décrit cette version.

## Avant de commencer

Lisez d’abord cette section : c’est celle qui est souvent négligée.

- **opencodex ne distribue pas cette version.** Cursor ne la documente pas non plus. Elle n’est pas liée depuis cursor.com, peut changer sans préavis et peut cesser d’être disponible. Si vous ne l’avez pas déjà, ce guide ne s’applique pas ; utilisez plutôt le pont communautaire [`ocx-cursor`](https://www.npmjs.com/package/ocx-cursor) avec un point de terminaison HTTPS public.
- **La connexion à Cursor reste obligatoire.** L’écran de connexion apparaît avant la boîte de dialogue de la passerelle.
- **Les modèles propres à Cursor ne sont pas disponibles.** En mode local, le sélecteur ne répertorie que les modèles renvoyés par votre passerelle. La complétion Tab, le catalogue Cursor (Composer, Auto) et Cloud Agents sont désactivés. Vous pouvez toujours accéder aux modèles du fournisseur Cursor par les routes `cursor/*` d’opencodex si vous avez configuré ce fournisseur.
- **Chaque tour contient la consigne système locale de Cursor**, d’environ 23 000 jetons à partir du deuxième tour. Tenez-en compte lors du choix du modèle.
- **Cette version partage son identité avec Cursor classique.** Même identifiant de paquet, même `~/.cursor`, même `Application Support/Cursor` (macOS), `%APPDATA%\Cursor` (Windows) ou `~/.config/Cursor` (Linux). Lancez-la avec `--user-data-dir <dir>` pour séparer les deux versions et laissez « Import data from existing Cursor installation » décoché au premier lancement, sauf si vous voulez copier vos réglages.

## Identifier la version installée

Les deux versions s’appellent « Cursor » dans le Dock et partagent un identifiant de paquet ; vérifiez donc `product.json` :

| Plateforme | product.json |
|---|---|
| macOS | `/Applications/Cursor Private Inference.app/Contents/Resources/app/product.json` |
| Windows | `%LOCALAPPDATA%\\Programs\\cursor-private-inference\\resources\\app\\product.json` |
| Linux | `<install root>/resources/app/product.json` (une AppImage doit d’abord être extraite) |

`nameLong` vaut `"Cursor Private Inference"` pour la version à agent local et `"Cursor"` pour la version classique ; `version` indique la version (3.18.25 au moment de la rédaction). La carte Cursor sous Integrations dans le tableau de bord effectue le même contrôle et affiche ce qu’elle a trouvé. Le mode local est activé dans le paquet de l’espace de travail, pas dans `product.json` ; aucun indicateur ne permet donc de le basculer. Si `nameLong` indique Cursor classique, cette installation ne peut pas joindre une passerelle loopback.

La boucle d’agent qui communique avec la passerelle réside dans un fichier sous le même répertoire d’installation, `extensions/cursor-agent-exec/dist/main.js`. opencodex le lit en mode lecture seule, avec une limite de taille, pour connaître la table des efforts de raisonnement de Cursor ; voir « Modèles et effort de raisonnement ».

## Configurer la passerelle

opencodex doit être en cours d’exécution (`ocx service status`). Les deux méthodes suivantes aboutissent au même réglage.

**Dans l’application.** Settings → Models → Gateway → Configure gateway :

| Champ | Valeur |
|---|---|
| Base URL | `http://127.0.0.1:10100/v1` (incluez `/v1` ; le loopback en `http://` est accepté) |
| API Key | la valeur de `OPENCODEX_API_AUTH_TOKEN` si votre service utilise l’authentification API ; sinon, n’importe quelle valeur fictive comme `opencodex-loopback` |

Cliquez sur **Refresh model list**. Le sélecteur se remplit avec la liste `/v1/models` d’opencodex ; activez les lignes souhaitées.

**Avec des variables d’environnement.** L’application les lit au démarrage :

```text
CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1
CURSOR_LOCAL_AGENT_API_KEY=opencodex-loopback
CURSOR_LOCAL_AGENT_HEADERS=            # optional, newline-separated "Header-Name: value" lines
```

`CURSOR_LOCAL_AGENT_HEADERS` rejette `User-Agent` et les espaces réservés `{...}` non résolus ; `{gitOrgRepo}` et `{gitBranch}` sont développés.

Ordre de priorité, du plus élevé au plus faible : identifiants propres au modèle → passerelle enregistrée dans Settings → `CURSOR_LOCAL_AGENT_*` → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` (solution de compatibilité). L’environnement ne remplace pas une passerelle enregistrée ; effacez d’abord celle-ci dans Settings si vous souhaitez utiliser les variables d’environnement.

Cursor Private Inference est une application graphique : un profil de shell interactif ne suffit donc pas à lui seul. La variable doit se trouver dans l’environnement du processus qui lance l’application.

| Système | Où la définir |
|---|---|
| macOS | `launchctl setenv CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1` pour la session de connexion courante, ou un LaunchAgent avec `EnvironmentVariables` pour la rendre persistante. Lancer l’application depuis un terminal fonctionne aussi. |
| Windows | `setx CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1` (portée utilisateur ; concerne les nouveaux processus) ou System Properties → Environment Variables. Redémarrez ensuite l’application. |
| Linux | `~/.profile` ou `~/.pam_environment` pour une session de gestionnaire d’affichage, ou `systemctl --user set-environment CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1` lorsque le bureau utilise une session systemd utilisateur. Une AppImage lancée depuis un terminal hérite de l’environnement de ce shell. |

Cette version existe pour macOS (arm64, x64, universel), Windows (x64, arm64) et Linux (x64, arm64). Sa configuration est identique sur ces plateformes.

## Depuis le tableau de bord

Le tableau de bord opencodex comporte un onglet **Cursor** sous Integrations (`/#integrations/cursor`). Il n’écrit rien dans Cursor : ni base de réglages, ni entrée du trousseau, ni paquet de l’application. Il n’y a donc aucun commutateur à actionner. L’onglet vous fournit les valeurs et indique si elles ont fonctionné.

- **Versions installées.** Il indique si Cursor Private Inference est présent, avec son chemin et sa version, ainsi que Cursor classique, avec son chemin. Si seul Cursor classique est trouvé, l’onglet demande au canal de mise à jour de Cursor quel programme d’installation local-mode il annonce pour cette plateforme et ce processeur (le canal `cursor-local` sur `api2.cursor.sh`), puis affiche cette version avec un lien vers l’installateur `downloads.cursor.com/local-mode/` et renvoie ici. opencodex se contente d’afficher le lien : il ne télécharge, ne lance et n’installe jamais rien. Si le canal est injoignable ou répond de façon inexploitable, l’onglet indique que l’installateur n’a pas pu être déterminé pour l’instant ; les valeurs de passerelle ci-dessous restent valables dans tous les cas. Cursor classique fait toujours passer les points de terminaison personnalisés par les serveurs Cursor et ne peut donc pas joindre un proxy loopback.
- **Valeurs de la passerelle.** L’URL de base utilise le port d’écoute propre au proxy, lu dans son enregistrement d’exécution. Ainsi, même si le tableau de bord passe par un proxy inverse, l’URL affichée indique le port joignable par Cursor sur cette machine. Un bouton Copy permet de la copier. La ligne API Key dépend de l’adresse d’écoute : sans besoin d’identifiant, elle affiche `opencodex-loopback` avec Copy ; si l’authentification API est active ou qu’une clé API opencodex est configurée, elle vous demande d’utiliser l’une de vos clés et renvoie à l’onglet API Keys. Toute clé configurée convient, pas seulement `OPENCODEX_API_AUTH_TOKEN`.
- **Connexion.** L’onglet affiche la dernière requête `/v1/models` dont le User-Agent est exactement `Cursor/<version>`, l’en-tête envoyé par l’environnement d’agent local de Cursor, avec l’heure et la version. Il affiche « never seen » jusqu’à ce que Cursor appelle le proxy ; appuyer sur **Refresh model list** dans Cursor fait changer cet état. La carte s’actualise toutes les 15 secondes tant que l’onglet est ouvert.
- **Ce que Cursor affichera.** Un tableau Model / Reasoning / Context pour les modèles annoncés par opencodex, avec les mêmes exclusions de modèles désactivés et de listes d’autorisation des fournisseurs que la liste brute, selon les règles de la section suivante. C’est une prévision : Cursor choisit les niveaux de Reasoning dans sa propre table.

## Modèles et effort de raisonnement

Le sélecteur utilise la liste brute `/v1/models` d’opencodex. Deux conditions déterminent si une ligne de modèle reçoit un contrôle **Reasoning** :

1. opencodex doit annoncer les capacités de la ligne (`api_types` et un objet `capabilities`). C’est le cas à partir de la v2.41. Les proxys plus anciens montrent les modèles, mais sans contrôle d’effort.
2. L’identifiant du modèle, après suppression de tout ce qui précède le dernier `/` et de tout suffixe `@…`, doit correspondre à la table d’effort propre à Cursor. Cette table est intégrée à l’application (`extensions/cursor-agent-exec/dist/main.js`) ; opencodex la lit dans l’installation détectée pour que la prévision du tableau de bord suive les mises à jour de Cursor. La carte indique la version lue ou « static mirror » si aucune n’est trouvée. Cursor détermine les niveaux, pas opencodex, et aucun champ `/v1/models` ne peut ajouter un modèle à cette table. La matrice ci-dessous est l’instantané 3.18.25 contenu dans la copie statique :

| Identifiant du modèle (après le dernier `/`) | Niveaux affichés par Cursor | Champ transmis |
|---|---|---|
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | de Low à Extra High : Low, Medium, High, Extra High | `reasoning.effort` |
| `gpt-5`, `gpt-5.x` | de Low à Extra High : Low, Medium, High, Extra High | `reasoning.effort` |
| `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.7`, `claude-opus-4.8` | de Low à Max : Low, Medium, High, Extra High, Max | `output_config.effort` |
| `claude-opus-4.6`, `claude-opus-4.5`, `claude-sonnet-4.6` | de Low à Max : Low, Medium, High, Max | `output_config.effort` |
| `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-build-latest` | de Minimal à Extra High : Minimal, Low, Medium, High, Extra High | `reasoning_effort` |
| `gemini-*` (nécessite `supports_reasoning`) | Minimal, Low, Medium, High | `reasoning_effort` |
| tout autre modèle, y compris `claude-fable-5-1`, `kimi-k3` | aucun contrôle | — |

Ainsi, `anthropic/claude-opus-5` fonctionne, mais les niveaux `max`/`ultra` d’opencodex pour GPT-5.6 ne sont pas accessibles depuis ce sélecteur.

### Modèles sans contrôle

`anthropic/claude-fable-5-1`, `cursor/kimi-k3` et tous les autres modèles absents de la table n’ont pas de contrôle Reasoning. Quand la passerelle annonce `supports_reasoning`, Cursor enregistre pour chaque identifiant concerné une ligne : « Local provider advertises reasoning support for a model with no hardcoded Bottlerocket effort family ». Deux options permettent néanmoins de choisir un effort :

- **Lignes d’effort** (`cursorEffortRows: true` dans la configuration opencodex, désactivé par défaut) : la passerelle publie une entrée par effort dans le sélecteur pour les modèles absents de la table, comme `anthropic/claude-fable-5-1--high` ou `cursor/kimi-k3--max`, et route chacune vers le modèle de base avec l’effort correspondant. Les modèles pour lesquels Cursor affiche déjà un contrôle ne reçoivent pas de lignes supplémentaires, et un identifiant de modèle exact et connu prévaut toujours sur le suffixe `--<effort>`. Appuyez sur Refresh model list après l’activation. La carte du tableau de bord compte les lignes publiées par modèle. Choisir une ligne constitue un choix explicite : son effort prévaut donc aussi sur une directive `ocx-effort` dans la requête.
- **Une valeur par défaut fixe** (`modelDefaultReasoningEfforts` sur le fournisseur) : elle s’applique lorsque Cursor n’envoie aucun effort.

### « Max » a deux sens différents

Cursor classique affiche un commutateur **Max** à côté de certains modèles. C’est Max Mode, une fenêtre de contexte plus grande, et non un niveau de raisonnement. Dans la version à agent local, cette possibilité apparaît comme une entrée **Context** dans le menu du modèle. opencodex l’active pour la famille GPT-5.6 native : **272K** par défaut ou **922K** pour l’option 1M, signalée comme plus coûteuse. La valeur choisie plafonne le contexte de ce tour. Les modèles routés affichent une seule fenêtre et aucune entrée Context ; un plafond de contexte fournisseur inférieur à 922K retire aussi cette entrée des lignes natives.

L’effort de raisonnement **Max** (les niveaux `max`/`ultra` d’opencodex) est l’autre sens, et celui-ci n’est pas accessible : Cursor prend ses niveaux d’effort dans sa propre table plutôt que dans la passerelle, et l’entrée GPT-5.6 s’arrête à Extra High.

Comme opencodex annonce `responses` dans `api_types`, cette version envoie les tours de l’agent à `/v1/responses` avec `reasoning.effort`, et non à `/v1/chat/completions`.

Ce choix de protocole a un effet secondaire pour les lignes Claude : Cursor n’envoie l’effort Claude que sous la forme `output_config.effort` sur le protocole Anthropic Messages. Avec une URL de base `/v1`, une ligne Claude qui affiche un contrôle utilise donc quand même la valeur par défaut du fournisseur. Une URL de base se terminant par `/messages` inverse la situation : l’effort Claude est envoyé et celui des modèles de la famille OpenAI est perdu. Une seule entrée de passerelle ne peut pas servir les deux familles ; les lignes d’effort ci-dessus contournent cette limite, car opencodex applique lui-même l’effort.

## Vérification

`ocx observe logs` affiche les tours avec `inboundProtocol: responses` et `admissionKind: loopback`.

| Symptôme | Vérification |
|---|---|
| Réponse 401 de la passerelle | l’API Key envoyée n’est pas acceptée par la configuration d’authentification API active ; pour une adresse loopback sans authentification API, toute valeur convient |
| sélecteur vide | opencodex n’est pas en cours d’exécution ou il manque `/v1` dans la Base URL ; appuyez sur Refresh model list après correction |
| modèles présents, mais sans contrôle Reasoning | opencodex est antérieur à la v2.41, ou l’identifiant est absent de la table Cursor (le tableau de bord affiche —) ; activez `cursorEffortRows` ou définissez une valeur par défaut sur le fournisseur |
| un changement de schéma n’est pas pris en compte | Cursor met en cache `/models` pour chaque chaîne Base URL sans expiration ; Refresh model list relit la liste. Sinon, redémarrez l’application ou enregistrez temporairement une autre forme de l’URL (`localhost` au lieu de `127.0.0.1`) |
| premier tour de 23 000 jetons | comportement attendu : il s’agit de la consigne système locale de Cursor |
