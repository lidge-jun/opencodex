---
title: Grok Build
description: Utilisez n’importe quel modèle routé par opencodex depuis la CLI Grok Build de xAI — les modèles sont automatiquement enregistrés dans ~/.grok/config.toml pendant l’exécution du proxy.
---

opencodex expose un point de terminaison compatible OpenAI `POST /v1/chat/completions` (ainsi que `/v1/responses`) sur son
port local, tandis que Grok Build prend en charge les modèles personnalisés hébergés sur des serveurs compatibles OpenAI. Avec
cette intégration, opencodex enregistre automatiquement l’intégralité de son catalogue visible dans Grok Build :
aucune modification manuelle de la configuration n’est nécessaire.

## Enregistrement automatique

Lorsque `~/.grok` existe, `ocx start` (et `ocx ensure` / `ocx restart`) écrit un bloc géré
en `~/.grok/config.toml` :

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
name = "OCX gpt-5.6-sol"
# ... one [model.ocx-*] table per visible model ...
# <<< opencodex managed block <<<
```

- **Additif :** votre propre configuration, en dehors des délimiteurs, n’est jamais modifiée. Avant la première
  injection dans un fichier existant, une sauvegarde unique est créée dans
  `~/.grok/config.toml.bak-opencodex`.
- **Idempotent :** chaque exécution de `ocx start` (ainsi que de `ocx ensure` lorsque le démarrage automatique est activé) remplace
  le bloc délimité par le catalogue actuel.
- **Supprimé à l’arrêt :** `ocx stop`, `ocx eject`, `ocx uninstall` et l’arrêt normal
  du démon hors service suppriment le bloc délimité et restaurent votre fichier
  octet pour octet. Sous un gestionnaire de service, le démontage passe par `ocx stop`/`ocx
  uninstall` (les processus en mode service maintiennent intentionnellement le blocage lors des réapparitions).
- **Les alias en conflit** déjà définis dans vos propres tables `[model.*]` sont respectés
  (opencodex ajoute un suffixe à ses propres entrées) ; un bloc délimité endommagé (marqueur de début sans marqueur de fin)
  refuse tout changement automatique et demande une réparation manuelle.

Choisissez ensuite un modèle dans Grok Build :

```bash
grok models          # lists ocx-* entries alongside native grok models
grok -m ocx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ocx-anthropic-claude-opus-4-8
```

## Effort de raisonnement

Les commandes `/effort` et `--effort` de Grok Build ne fonctionnent que pour les modèles dont l’entrée de catalogue
annonce une échelle d’effort : la récupération de la liste des modèles lit la réponse brute de `GET /v1/models`, et
les entrées doivent contenir `supports_reasoning_effort` ainsi que les choix du menu
`reasoning_efforts`. Pour les entrées de modèles routés, opencodex reflète les niveaux configurés pour le fournisseur
(`reasoningEfforts` / `modelReasoningEfforts`, et la valeur par défaut de
`modelDefaultReasoningEfforts`) dans cette réponse. Ces métadonnées décrivent l’échelle des modèles routés
configurée dans le proxy ; elles ne prétendent pas que le fournisseur prend nativement en charge ces niveaux.
Les adaptateurs peuvent émuler le raisonnement ou mapper les niveaux sur des champs propres au fournisseur.
Les modèles routés qui possèdent une échelle configurée affichent le contrôle de l’effort dans Grok Build comme
dans Codex. Ceux dont la liste de niveaux est vide n’affichent aucun contrôle d’effort, conformément au comportement
de Codex. Les entrées GPT-5.6 natives sont distinctes : elles conservent et exposent leurs échelles de raisonnement
en amont fixes, et non les métadonnées configurées pour les modèles routés.

Grok Build communique avec opencodex au moyen de Chat Completions et envoie `reasoning_effort` lorsque
l’échelle est annoncée. Dans ce cas, le traducteur Chat Completions entrant définit par défaut le champ Responses
`reasoning.summary` sur `auto` ; les traces de raisonnement parviennent donc à Grok sous la forme
`delta.reasoning_content` au lieu d’être masquées. Réglez `include_reasoning: false` (ou
`reasoning.summary: "none"`) si un client souhaite que le modèle réfléchisse sans renvoyer le
tracé. Une valeur explicite de `reasoning.summary` prévaut lorsque les deux options sont présentes.

## Note d'authentification

Grok Build exige une clé API non vide pour les modèles personnalisés, même sur l’interface de bouclage. Les entrées
injectées contiennent une valeur fictive (`opencodex-loopback`) ; opencodex ignore les clés d’admission pour les
connexions de bouclage, de sorte qu’aucun véritable secret n’est utilisé.

**L’enregistrement automatique est réservé au bouclage.** Lorsque opencodex se lie à un hôte hors bouclage, y compris
les caractères génériques `0.0.0.0` et `::`, qui exposent chaque interface — les requêtes ont besoin de votre réel
jeton d’admission, et un bloc géré ne peut pas en transporter un en toute sécurité. Écrire le jeton littéral
mettez votre secret dans `~/.grok/config.toml` et écrasez tout ce que vous y avez défini lors du prochain
`ocx start`/`ensure`/`restart`. Donc opencodex n’écrit rien du tout dans ce cas (et supprime
tout bloc restant d'une liaison de bouclage précédente), et vous configurez les modèles vous-même
en dehors des marqueurs gérés, où rien de ce que opencodex fait ne peut les écraser. Voir
[Recette manuelle](#recette-manuelle-sans-enregistrement-automatique) pour le tableau exact et réglez les deux
`base_url` (un hôte réellement accessible à partir de l'endroit où vous exécutez `grok`) et `api_key`
(votre `OPENCODEX_API_AUTH_TOKEN`).

Ne remplacez pas `api_key` par `env_key` ici. Sans `model_provider` défini, un `env_key`
qui ne parvient pas à résoudre n'arrête pas la demande — Grok passe à votre xAI session
et l'envoie à n'importe quel `base_url` nom d'entrée, ce qui pour un LAN déploiement est un
texte en clair HTTP point de terminaison qui n'est pas xAI.

Le modèle injecté `api_key` se trouve en premier dans la chaîne d'informations d'identification de Grok pour ces modèles,
donc les tours contre opencodex n'ont pas besoin de connexion Grok supplémentaire. Gardez votre `grok login` /
`XAI_API_KEY` configuration pour les modèles Grok natifs et toutes les fonctionnalités de harnais qui contactent xAI
directement.

## Recette manuelle (sans enregistrement automatique)

Si vous gérez `~/.grok/config.toml` vous-même — ou si opencodex est sur une liaison sans bouclage — ajoutez
tables par modèle avec **champs directs**, en dehors des marqueurs `# >>> opencodex managed block` :

```toml
[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
```

Pour un proxy joignable sur le réseau, pointer `base_url` à l'adresse `grok` peut effectivement
composez et utilisez votre jeton d'entrée :

```toml
[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"
```

Ne comptez pas sur l'héritage `[model_providers.<id>]` pour le point de terminaison : à partir de Grok Build
0.2.101 le `base_url` hérité n'est pas appliqué au routage d'inférence (les requêtes tombent
jusqu'au proxy xAI par défaut et échoue avec 401). Itinéraire direct des champs par modèle
correctement.

Placez entre guillemets tout alias contenant un point : `[model.grok-4.5]` sans guillemets est un chemin de clé à trois segments, et non
l'identifiant `grok-4.5`. Les alias générés évitent entièrement les points pour cette raison.

## Limitations connues

- **Installé par le service `ocx restart` :** le proxy en cours d'exécution possède l'autorisation de redémarrage et la vidange
  coordination, tandis que le gestionnaire de service installé lance le remplacement après l'ancien processus
  sorties. La supervision du service reste installée. Lors de l'enregistrement automatique en boucle, le bloc géré
  reste également en place tout au long du transfert ; les déploiements sans bouclage utilisent une gestion manuelle Grok
  configuration à la place. La commande ne réussit qu'après qu'un processus différent, avec vérification d'identité, ait été effectué.
  sain sur le même port.
- **Moment de lecture de la configuration :** démarrez d’abord opencodex, puis lancez `grok` pour obtenir les résultats les plus
  prévisibles. Grok Build surveille `~/.grok/config.toml` et recharge la configuration lorsque la table
  `[model]` change réellement (temporisation d’environ une seconde, avec comparaison du contenu) ;
  un bloc actualisé atteint une session ouverte sans redémarrage. Pour confirmer ce que Grok a analysé,
  run `grok inspect` : il répertorie les sources de configuration qu'il a chargées et avertit de tout champ qu'il a chargé
  rejeté. Il n'imprime pas la liste des modèles résolus. Notez qu’une seule erreur TOML
  invalide *l'intégralité* de la couche de configuration utilisateur, c'est pourquoi opencodex écrit le fichier
  atomiquement - Grok ne voit jamais une configuration à moitié écrite.
- **Mises à jour du catalogue :** le bloc délimité reflète le catalogue au moment de l’injection. Après
  l’ajout de fournisseurs ou de modèles, exécutez `ocx ensure` (ou redémarrez le proxy) pour l’actualiser.
