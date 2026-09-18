---
title: Couches de prompt Codex
description: Découvrez ce que Codex envoie réellement, désactivez les éléments inutiles et ajoutez vos propres instructions sous forme de couches.
---

Codex assemble son prompt à partir de plusieurs couches : ses propres instructions de base,
la documentation de votre projet, le contexte des autorisations et de l’environnement, les
compétences installées, et davantage. **Codex Set → Prompt** affiche cette pile, indique le coût
de chaque couche et permet de désactiver celles dont vous ne voulez pas.

## Ce que montre la liste

Chaque ligne indique sa position dans l’ordre d’assemblage, la clé de configuration qui la régit
lorsqu’il en existe une, et la taille de ce qui a réellement été envoyé.

La numérotation des positions comporte des intervalles. C’est intentionnel : les nombres sont les
véritables indices d’assemblage, et deux d’entre eux figurent plus bas sous **Avis de transition**.
Renuméroter chaque groupe à partir de un afficherait un ordre que Codex n’utilise pas.

### Cinq types de couches

| Type | Ce que vous pouvez faire |
|---|---|
| Modifiable ici | Un véritable commutateur. Écrit une clé dans `config.toml`. |
| Contrôlé par une fonctionnalité | Réelle, mais modifiée dans les paramètres des fonctionnalités plutôt que sur cette page. |
| Toujours actif | Aucun commutateur de désactivation n’existe dans Codex. |
| Lors d'un changement | Annonce une transition et n’apparaît donc que lorsqu’un élément change. |
| Couche d’extension | Ne peut pas être répertoriée. Codex ne l’expose pas. |

Une couche sans commutateur de désactivation n’en affiche aucun, au lieu d’en montrer un qui serait
désactivé. Un contrôle grisé laisserait entendre que la possibilité existe, mais qu’elle est
temporairement indisponible, ce qui n’est pas le cas.

## Lire une couche

Cliquez sur le nom d’une couche pour afficher le texte qu’elle envoie. La boîte de dialogue le lit
depuis `codex debug prompt-input` : il s’agit donc du contenu réel, et non d’une description.

Il arrive qu’il n’y ait rien à afficher. La boîte de dialogue précise alors la raison :

- **Le fichier existe, mais il est vide.** Votre fichier `~/.codex/AGENTS.md` ne contient aucun
  octet ; la couche n’a donc rien à envoyer. La boîte de dialogue indique le chemin.
- **Elle n’a rien envoyé pendant le tour que nous avons lu.** Les couches ne sont renvoyées que
  lorsqu’elles changent ; une couche inchangée est donc absente d’un échantillon unique.
- **Le prompt de base provient du catalogue de modèles.** Codex l'envoie hors de la liste lisible :
  la boîte de dialogue le lit donc dans l'entrée de catalogue du modèle sélectionné, ou dans le
  fichier désigné par `model_instructions_file` si vous en avez défini un. Lorsque le catalogue ne
  publie qu'un gabarit non développé, la boîte de dialogue indique qu'il n'est pas affiché, car ce
  texte n'est pas celui que Codex envoie.
- **Le prompt n’a pas pu être lu.** La sonde a échoué sur cette machine.

La lecture est effectuée depuis votre répertoire Codex global (`~/.codex`), et non depuis le
répertoire dans lequel le tableau de bord se trouve être lancé.

## Couches personnalisées

**+ Add layer** ajoute vos propres instructions à la fin. Les couches personnalisées sont
assemblées dans `developer_instructions`, qui est additif : Codex conserve ses propres instructions
et y ajoute les vôtres.

:::note
Il ne s’agit délibérément pas de `model_instructions_file`. Cette clé REMPLACE le prompt de base au
lieu de le compléter ; relier **+** à cette clé supprimerait donc les propres instructions de Codex
dès le premier enregistrement d’une couche.
:::

Les couches personnalisées sont numérotées entre elles, car elles sont réunies dans une seule
section dans cet ordre ; elles ne s’intercalent pas avec les couches intégrées.

Réorganisez-les avec les flèches de la ligne, ou avec `Alt` + `Up` / `Alt` + `Down` depuis
n’importe quel emplacement de la ligne. L’ordre correspond à l’ordre de composition.

### Préréglages

**+ Add layer** propose cinq points de départ : sortie concise, planification avant modification,
explication du raisonnement, tests en premier et réponses en coréen. Chacun ouvre l’éditeur ordinaire
avec un contenu prérempli et entièrement modifiable : un préréglage est un point de départ, et ce que
vous enregistrez devient une couche personnalisée ordinaire.

Les préréglages sont notre propre texte, rédigé pour condenser une approche et non pour copier le
prompt de quelqu’un. Chacun indique sa source.

### Passer d’une couche à l’autre pendant la modification

L’éditeur dispose de commandes précédent/suivant et d’un indicateur de position. Les modifications
non enregistrées sont conservées pendant vos déplacements ; vous pouvez ainsi comparer deux couches
en cours de modification, puis revenir sans perdre ce que vous avez saisi.

### Avertissements de compatibilité

L’éditeur avertit lorsqu’une couche contient une instruction qui ne fonctionnera pas telle quelle :
revendiquer une autre identité, nommer un outil défini par le registre, utiliser des espaces réservés
de modèle que rien ne développe ou énoncer des informations sur l’environnement que Codex génère
ultérieurement.

Ces avertissements ne bloquent jamais l’enregistrement. Si vous souhaitez remplacer le comportement
de Codex, vous le pouvez ; l’avertissement permet simplement d’en faire une décision plutôt qu’un accident.

## Instructions écrites en dehors d’opencodex

Si `developer_instructions` existe déjà et n’a pas été écrit par opencodex, le panneau ne le
remplacera pas. Il propose à la place d’importer le texte comme une couche : vous voyez d’abord la
valeur existante, et rien n’est écrit avant votre confirmation.

## En cas de désynchronisation

Si les couches enregistrées et la valeur de `config.toml` divergent, le panneau le signale et
propose **Repair** au lieu de corriger le problème silencieusement. Deux des méthodes de réparation
réécrivent votre texte et restent donc intentionnelles. Lorsqu’un fichier de couche a disparu, la
réparation crée une sauvegarde avant toute modification.

## Quand les modifications prennent effet

Les modifications s’appliquent aux nouvelles sessions. Une session déjà en cours conserve les
paramètres de prompt avec lesquels elle a démarré.

## Ce que cette page lit, et ce qu’elle ne lit pas

opencodex lit un seul fichier de configuration : votre `config.toml`. Codex résout ses paramètres à
partir de plusieurs couches ; une valeur affichée ici correspond donc à ce que dit VOTRE fichier,
et pas nécessairement à ce que Codex calcule finalement.

## Les clés que cette page écrit

Elles se trouvent dans le `config.toml` de Codex, pas dans la configuration propre à opencodex.

| Clé | Par défaut | Couche |
|---|---|---|
| `include_permissions_instructions` | `true` | Autorisations |
| `include_collaboration_mode_instructions` | `true` | Mode collaboration |
| `include_environment_context` | `true` | Contexte d'environnement |
| `include_apps_instructions` | `true` | Applications |
| `skills.include_instructions` | `true` | Compétences |
| `developer_instructions` | non défini | Vos couches personnalisées, jointes dans l'ordre |

L'écriture se fait ligne par ligne : vos commentaires et votre mise en forme sont conservés, et une clé qu'opencodex ne connaît pas est laissée telle quelle plutôt que supprimée.

Une clé absente est lue comme sa valeur par défaut, et non comme `false`. Le panneau affiche la valeur réellement présente dans votre fichier et indique lorsqu'une clé n'est pas définie.
