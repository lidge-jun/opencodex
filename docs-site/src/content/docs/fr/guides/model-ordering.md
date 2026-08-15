---
title: Ordre des modèles
description: Découvrez comment opencodex détermine l’ordre des modèles dans le sélecteur Codex et les substitutions de modèle de spawn_agent.
---

Le sélecteur de modèles Codex ne conserve ni l’ordre de déclaration des fournisseurs ni celui des tableaux de modèles dans la
configuration opencodex. L’ordre final découle des priorités du catalogue ; les modèles routés qui partagent la même priorité
sont classés selon un ordre alphabétique déterministe.

## La règle Codex s'applique

Le gestionnaire de modèles de Codex trie les entrées de catalogue visibles dans le sélecteur par `priority`, dans l’ordre croissant. Il
ignore l’ordre du tableau du catalogue : avancer une entrée dans un tableau JSON généré ne la fait donc pas remonter
dans le sélecteur. L’implémentation consigne cette contrainte directement dans
`src/codex/catalog/sync.ts`.

opencodex contrôle donc la mise en avant en attribuant des priorités plus faibles, et non en s’appuyant sur la
position dans le tableau. Sauf indication contraire, les priorités fixes et l’exemple détaillé ci-dessous décrivent un
catalogue sans sélecteur de compte Codex admissible. Avec `N` sélecteurs admissibles, les priorités mises en avant
utilisent `N` comme pas : un choix natif non qualifié de rang configuré `i` se décline en lignes de sélecteur aux
priorités `i * N + j`, où `j` est la position du sélecteur en base zéro ; un choix routé utilise
`i * N` ; un choix exact qualifié par un sélecteur utilise `i * N + j` pour ce sélecteur. Les lignes routées non sélectionnées
sont déplacées hors de ces groupes de sélecteurs. Codex continue de n’annoncer que les cinq premières
lignes visibles dans le sélecteur.

Les priorités sans sélecteur pertinentes sont :

| Entrée du catalogue | Priorité | Source |
| --- | --- : | --- |
| `subagentModels[i]` | `i` (`0` à `4`) | La carte de classement présentée dans `src/codex/catalog/sync.ts` |
| Autres modèles acheminés | `5` | Création d'une entrée routé dans `src/codex/catalog/sync.ts` |
| Modèles routés non mis en avant et présents dans `modelPickerOrder` | `1000 + i` | Rang d’affichage du sélecteur dans `src/codex/catalog/sync.ts` |
| Slugs GPT natifs par défaut | `9` | Création d'entrées natives dans `src/codex/catalog/sync.ts` |
| Modèles natifs non sélectionnés alors qu'une liste sélectionnée existe | Au moins `featured.length + 100` | Fusion du catalogue natif dans `src/codex/catalog/sync.ts` |

La direction API limite `subagentModels` à cinq entrées avec `slice(0, 5)` en
`src/server/management/agent-settings-routes.ts`. Cela correspond à la surface Codex `spawn_agent`, qui
annonce uniquement les cinq premiers remplacements de modèle. Les modèles en dehors de ces cinq peuvent toujours rester visibles
dans le sélecteur principal et appelables par leur identifiant exact.

## Départage des priorités identiques

Tous les modèles routés ordinaires ont la priorité `5` ; il faut donc les départager. Avant la création des entrées du catalogue,
`gatherRoutedModels()` trie la liste des modèles routés par nom de fournisseur, puis par identifiant de modèle, dans les deux cas
par ordre alphabétique (`src/codex/catalog/provider-fetch.ts`).

Cela signifie qu'aucun de ces détails de configuration ne modifie l'ordre final :

- l'ordre de déclaration des clés dans l'objet `providers` ;
- l'ordre des identifiants dans le tableau `models` d'un fournisseur.

`orderForSubagents()` utilise ensuite un tri stable pour placer les choix mis en avant au début de la liste, dans le
même ordre que `subagentModels`. Les modèles non mis en avant conservent l’ordre relatif alphabétique fournisseur/identifiant
établi précédemment (`src/codex/catalog/sync.ts`). Le classement présenté est également converti en
priorités `0` à `4` lorsque les entrées sont construites, donc le tri prioritaire de Codex préserve ce premier
séquence.

## La visibilité est distincte de l’ordre

`selectedModels` et `disabledModels` déterminent quels modèles routés sont exposés ; ils ne contrôlent pas
leur ordre. `filterCatalogVisibleModels()` convertit les deux sélections en recherches dans des `Set` et filtre la
liste recueillie sans utiliser les tableaux comme rangs (`src/codex/catalog/provider-fetch.ts`).

Par conséquent, la réorganisation de `selectedModels` ou `disabledModels` n’a aucun effet sur la position du sélecteur. Cela peut
change uniquement si un modèle est inclus.

## Ordre effectif du sélecteur

Sans sélecteur de compte éligible et sans liste de sélection non vide, l'ordre résultant est le suivant :

1. Modèles dans l'ordre `subagentModels` configuré exactement, avec des priorités `0` à `4`.
2. Tous les modèles acheminés restants, classés par ordre alphabétique par fournisseur, puis par identifiant de modèle, en priorité `5`.
3. Modèles natifs non sélectionnés, poussés sous le bloc sélectionné lors de la fusion du catalogue.

Sans `subagentModels`, les modèles routés restent en priorité `5`, les entrées natives GPT utilisent leur
priorité (normalement `9` pour les entrées construites par opencodex), et le groupe routé reste provider/id
alphabétique.

## Exemple

Supposons que `subagentModels` contienne ces cinq identifiants dans cet ordre exact :

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

Le sélecteur commence ainsi :

| Position dans le sélecteur | Modèle | Priorité | Motif de cette position |
| --- : | --- | --- : | --- |
| 1 | `gpt-5.5` | `0` | Première sélection `subagentModels` |
| 2 | `opencode-go/glm-5.2` | `1` | Deuxième sélection, même si son fournisseur trie après `anthropic` |
| 3 | `anthropic/claude-opus-4-6` | `2` | Troisième sélection |
| 4 | `gpt-5.6-sol` | `3` | Quatrième sélection |
| 5 | `gpt-5.6-terra` | `4` | Cinquième sélection |
| 6 | `anthropic/claude-fable-5` | `5` | Premier identifiant routé restant dans l’ordre alphabétique fournisseur/identifiant |
| 7 en avant | Modèles acheminés restants | `5` | Fournisseur par ordre alphabétique, puis identifiant du modèle par ordre alphabétique |
| Après les modèles routés | Modèles natifs restants | `featured.length + 100` ou supérieur | Les modèles natifs non sélectionnés sont déplacés sous le bloc mis en avant |

Les cinq premières entrées sont les substitutions annoncées à `spawn_agent` ; les autres suivent l’ordre
normal du sélecteur. Avec des sélecteurs de compte, la limite de cinq entrées s’applique après que les choix natifs non qualifiés
ont été déclinés en groupes qualifiés par sélecteur.

## Modification de l'ordre

Utilisez `subagentModels` pour choisir et ordonner les premiers modèles que Codex annonce également à
`spawn_agent`. La page **Sous-agents** du tableau de bord peut réorganiser les identifiants natifs non
qualifiés et les identifiants routés. Utilisez `ocx agent subagents set` ou modifiez la configuration
OpenCodex pour définir des choix exacts de la forme `<selector>/<native-openai-model>` ; le tableau de bord
ne les répertorie pas et les omet s’il enregistre la liste. Configurez au maximum cinq identifiants. Avec
des sélecteurs de compte, un choix natif non qualifié peut se décliner en plusieurs lignes de catalogue
qualifiées par sélecteur ; les choix configurés et les lignes annoncées ne correspondent donc pas
nécessairement un à un.

Utilisez `modelPickerOrder` pour ordonner uniquement l’affichage des lignes routées `<provider>/<model>`
au-delà de ce bloc mis en avant :

```json
{
  "modelPickerOrder": [
    "tyler/deepseek-v4-pro",
    "jd-chat/kimi-k3",
    "jd-chat/glm-5.2"
  ]
}
```

Les lignes routées indiquées apparaissent dans l’ordre configuré. Une ligne absente du tableau conserve sa
priorité normale et reste donc devant la bande d’affichage de `modelPickerOrder` ; indiquez toutes les
lignes routées dont vous souhaitez contrôler l’ordre relatif. Une ligne également présente dans
`subagentModels` conserve sa priorité de mise en avant. `modelPickerOrder` ne réorganise ni les lignes
natives non qualifiées ni celles qualifiées par un compte ; utilisez `subagentModels` pour celles-ci.

`modelPickerOrder` ne modifie jamais l’ensemble des candidats de `spawn_agent`. Il change uniquement la
priorité visible par Codex dans le sélecteur, tandis qu’OpenCodex conserve la priorité naturelle de chaque
ligne déplacée pour la sélection des sous-agents. `disabledModels` et `selectedModels` de chaque fournisseur
restent des champs de visibilité, pas des contrôles d’ordre. Il n’existe aucun paramètre distinct
`modelOrder`, `providerOrder` ou de carte de priorité.
