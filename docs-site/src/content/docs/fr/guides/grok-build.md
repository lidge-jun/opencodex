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
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
extra_headers = { "x-opencodex-grok" = "1" }

[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
model_provider = "opencodex"
name = "OCX gpt-5.6-sol"
context_window = 272000
supports_reasoning_effort = true
reasoning_effort = "low"

[[model.ocx-gpt-5-6-sol.reasoning_efforts]]
id = "low"
value = "low"
label = "Low"
description = "Quick, fast implementations"
default = true
# ... autres niveaux de ce modèle, puis une table [model.ocx-*] par modèle visible, chacun référençant model_provider = "opencodex" ...
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
  uninstall` (les processus en mode service conservent intentionnellement le bloc lors des relancements).
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
`reasoning_efforts`. Une projection compatible avec Grok de cette échelle est également écrite dans chaque table
`[model.*]` gérée, avec `supports_reasoning_effort`, la valeur par défaut `reasoning_effort` et les lignes
`[[model.<alias>.reasoning_efforts]]`, afin que le menu soit présent lorsque Grok lit le modèle depuis
`config.toml`. Pour les entrées de modèles routés, opencodex reflète les niveaux configurés pour le fournisseur
(`reasoningEfforts` / `modelReasoningEfforts`, et la valeur par défaut de
`modelDefaultReasoningEfforts`). Ces métadonnées décrivent l’échelle des modèles routés configurée dans le proxy ;
elles ne prétendent pas que le fournisseur prend nativement en charge ces niveaux.
Les adaptateurs peuvent émuler le raisonnement ou mapper les niveaux sur des champs propres au fournisseur.
Les modèles routés qui possèdent une échelle configurée affichent le contrôle de l’effort dans Grok Build comme
dans Codex. Ceux dont la liste de niveaux est vide n’affichent aucun contrôle d’effort, conformément au comportement
de Codex. Les entrées GPT-5.6 natives sont distinctes : elles conservent et exposent leurs échelles de raisonnement
en amont fixes, et non les métadonnées configurées pour les modèles routés. Les niveaux Grok valides, notamment
`none` et `minimal`, sont conservés lorsqu’ils sont annoncés. Les niveaux non pris en charge ou en double,
notamment `ultra`, propre à Codex, sont omis du fichier afin que chaque option générée reste sélectionnable.

Grok Build communique avec opencodex au moyen de l’API Responses. Lorsque la route annonce une
échelle de raisonnement, le relais Responses transmet `reasoning.summary` tel que configuré, si bien
que les traces de raisonnement parviennent à Grok nativement sous forme d’éléments de raisonnement
Responses. Réglez `reasoning.summary: "none"` si un client souhaite que le modèle réfléchisse sans
renvoyer le tracé. Une valeur explicite de `reasoning.summary` prévaut sur la valeur par défaut de la
route.

## Note d'authentification

Grok Build exige une clé API non vide pour les modèles personnalisés, même sur l’interface de bouclage. Les entrées
injectées contiennent une valeur fictive (`opencodex-loopback`) ; opencodex ignore les clés d’admission pour les
connexions de bouclage, de sorte qu’aucun véritable secret n’est utilisé.

**L’enregistrement automatique est réservé au bouclage.** Lorsque opencodex écoute sur une adresse qui n’est pas
de bouclage — y compris les caractères génériques `0.0.0.0` et `::`, qui exposent toutes les interfaces — les
requêtes doivent présenter votre véritable jeton d’admission, qu’un bloc géré ne peut pas transporter en toute
sécurité. Inscrire ce jeton en clair stockerait votre secret dans `~/.grok/config.toml` et écraserait toute valeur
que vous y auriez définie lors du prochain `ocx start`/`ensure`/`restart`. Dans ce cas, opencodex n’écrit donc rien
(et supprime tout bloc laissé par une ancienne liaison de bouclage) ; vous configurez vous-même les modèles en
dehors des marqueurs gérés, où aucune opération opencodex ne peut les écraser. Consultez la
[recette manuelle](#recette-manuelle-sans-enregistrement-automatique) pour obtenir la table exacte, puis définissez
`base_url` (une adresse réellement accessible depuis l’endroit où vous exécutez `grok`) et `api_key` (votre
`OPENCODEX_API_AUTH_TOKEN`).

Ne remplacez pas `api_key` par `env_key` ici. Un `env_key` qui ne peut pas être
résolu n’interrompt pas la requête : Grok utilise alors votre jeton de session xAI et l’envoie à l’adresse
`base_url` indiquée par l’entrée. Pour un déploiement sur le réseau local, cette adresse est un point de terminaison
HTTP en clair qui n’appartient pas à xAI.

La valeur `api_key` injectée sur l’entrée du fournisseur se trouve en tête de la chaîne d’identifiants de Grok. Les requêtes
adressées à opencodex ne nécessitent donc aucune connexion Grok supplémentaire. Conservez votre configuration
habituelle `grok login` / `XAI_API_KEY` pour les modèles Grok natifs et les fonctions qui contactent directement xAI.

## Recette manuelle (sans enregistrement automatique)

Si vous gérez `~/.grok/config.toml` vous-même — ou si opencodex est sur une liaison sans bouclage — ajoutez un bloc
`[model_providers.opencodex]` et des tables par modèle qui le référencent via `model_provider`, en dehors des
marqueurs `# >>> opencodex managed block` :

```toml
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

Pour un proxy joignable sur le réseau, pointez `base_url` vers l’adresse que `grok` peut réellement
joindre et utilisez votre jeton d’entrée :

```toml
[model_providers.opencodex]
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

Le bloc géré utilise désormais l’héritage `[model_providers.<id>]`, ce qui nécessite Grok Build 0.2.109 ou ultérieur (publié le 2026-07-21). Sur les versions antérieures, le `base_url` hérité n’est pas appliqué au routage d’inférence — mettez à niveau, ou utilisez des champs directs par modèle (`base_url`/`api_backend`/`api_key` sur chaque table `[model.*]`).

Placez entre guillemets tout alias contenant un point : `[model.grok-4.5]` sans guillemets est un chemin de clé à trois segments, et non l'identifiant `grok-4.5`. Les alias générés évitent entièrement les points pour cette raison.

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
  exécutez `grok inspect` : il répertorie les sources de configuration chargées et signale les champs
  rejetés. Il n'affiche pas la liste des modèles résolus. La version actuelle de Grok Build signale et
  ignore les champs de modèle invalides tout en conservant le reste de l'entrée. Une erreur de syntaxe
  TOML empêche toujours le chargement du fichier. opencodex écrit de manière atomique, de sorte que
  Grok observe un document complet à chaque rechargement.
- **Mises à jour du catalogue :** le bloc délimité reflète le catalogue au moment de l’injection. Après
  l’ajout de fournisseurs ou de modèles, exécutez `ocx ensure` (ou redémarrez le proxy) pour l’actualiser.
