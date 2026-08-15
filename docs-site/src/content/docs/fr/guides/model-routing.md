---
title: Routage des modèles
description: Comment opencodex détermine quel fournisseur sert un identifiant de modèle donné.
---

Lorsque Codex demande un modèle, `router.ts` le résout vers un unique fournisseur configuré. Les règles
sont évaluées **dans l'ordre** : la première correspondance l'emporte.

Pour OpenAI, un identifiant `<selector>/gpt-*` configuré est associé, par l'intermédiaire de
`codexAccountNamespaces`, à un unique compte Codex enregistré avant l'examen des espaces de noms de
combinaisons ou de fournisseurs. Les identifiants `gpt-*` non qualifiés sélectionnent plutôt le fournisseur
canonique `openai`. Son paramètre `codexAccountMode` choisit le mode Pool (par défaut, compte principal et
comptes ajoutés) ou Direct (jeton du compte appelant/principal actuel), sans modifier l'identifiant du modèle.
`openai-apikey/<model>` sélectionne explicitement le transport par clé API. Ces routes d'identification ne se
rabattent jamais les unes sur les autres.

## Ordre de priorité

1. **Sélecteur exact de compte Codex** — si l'identifiant est
   `<selector>/<native-openai-model>` et que le sélecteur figure dans `codexAccountNamespaces`,
   la requête utilise exclusivement le compte enregistré correspondant et envoie en amont l'identifiant
   non qualifié du modèle natif. Si la cible exacte n'est pas disponible, la requête échoue sans tenter le
   mode Pool, le mode Direct ni le routage par fournisseur.

   ```text
   side/gpt-5.6-sol → provider "openai", model "gpt-5.6-sol", account selector "side"
   ```

2. **Identifiant ou alias de combinaison** — tant qu'au moins une combinaison est configurée, un identifiant
   canonique `combo/<id>` ou un alias de combinaison configuré sélectionne sa cible concrète avant l'examen
   des espaces de noms de fournisseurs. En l'absence de combinaison configurée, un ancien fournisseur physique
   nommé littéralement `combo` reste un espace de noms de fournisseur ordinaire. Consultez
   [Combinaisons](/fr/guides/combos/) pour le choix de la cible et le comportement de basculement.

3. **`provider/model` explicite** — si l'identifiant contient `/` et que sa partie antérieure correspond au
   nom d'un fournisseur configuré, ce fournisseur est utilisé et l'identifiant est réduit à la partie située
   après la barre oblique.

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   Il s'agit de la forme explicite pour un fournisseur routé, celle qu'emploie le sélecteur de modèles de
   Codex. Si le même identifiant public est un alias de combinaison configuré, la règle 2 l'emporte. Si le
   fournisseur nommé est désactivé, cette forme explicite provoque une erreur au lieu d'être redirigée.

4. **Identifiant non qualifié de la famille OpenAI native** — un identifiant tel que `gpt-*`, `o1-*`, `o3-*`
   ou `o4-*` utilise le fournisseur canonique `openai` activé et son mode de compte Pool ou Direct configuré.

5. **`defaultModel` d'un fournisseur** — si le champ `defaultModel` d'un fournisseur correspond à
   l'identifiant, ce fournisseur est utilisé (l'identifiant lui est transmis sans modification).

6. **Motifs de préfixes intégrés** — l'identifiant est comparé aux préfixes connus des familles de modèles,
   puis acheminé vers un fournisseur configuré portant ce nom (ou ce préfixe de nom) :

   | Préfixes | Fournisseur |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

   Cette correspondance repose sur le nom et, contrairement aux recherches dans `defaultModel` et `models[]`,
   ne filtre actuellement pas un fournisseur correspondant dont l'indicateur `disabled` vaut true.

7. **`models[]` d'un fournisseur** — si aucune règle de préfixe ne s'est appliquée et qu'un fournisseur actif
   répertorie l'identifiant dans son tableau `models[]`, ce fournisseur est utilisé. La règle 4 a déjà acheminé
   tout identifiant `gpt-*` non qualifié vers le fournisseur canonique `openai` activé avant qu'il puisse
   correspondre au tableau `models[]` d'un autre fournisseur.

8. **Fournisseur par défaut** — si aucune règle ne correspond, l'identifiant est transmis sans modification à
   `config.defaultProvider`. (Si aucun fournisseur par défaut n'est configuré, ou s'il est désactivé, le routage
   provoque une erreur.)

## Clés API et variables d'environnement

Quelle que soit la route choisie, la valeur `apiKey` du fournisseur est résolue par `resolveEnvValue()` : une
valeur `${OPENAI_API_KEY}` ou `$OPENAI_API_KEY` est développée depuis l'environnement au moment de la requête,
de sorte que les secrets n'ont jamais besoin d'être enregistrés dans `config.json`.

## Visibilité dans le catalogue et plafonds de contexte

Le routage et la visibilité dans le catalogue sont deux mécanismes distincts :

- `disabledModels` masque les identifiants routés avec espace de noms dans le catalogue Codex et
  `/v1/models` ; l'identifiant non qualifié d'un modèle GPT natif reste dans le catalogue avec
  `visibility: "hide"`. Ce réglage ne rejette **pas** une requête directe adressée à ce modèle.
- Une liste `selectedModels` non vide sur un fournisseur constitue une autre liste d'autorisation du catalogue.
  La découverte dynamique et le routage direct continuent de fonctionner ; seules les publications dans le
  catalogue et `/v1/models` sont restreintes.
- `provider.disabled: true` retire ce fournisseur de la découverte du catalogue. Les requêtes explicites
  `provider/model` échouent, et les recherches dans `defaultModel` et `models[]` l'ignorent.
- `providerContextCaps` applique des plafonds de contexte visibles par Codex, fournisseur par fournisseur.
  `contextCapValue` est la valeur par défaut du tableau de bord (350 000 par défaut), mais n'a aucun effet à
  lui seul tant qu'un fournisseur ne figure pas dans `providerContextCaps`. La modification de la valeur dans
  le tableau de bord réaffecte tous les fournisseurs activés uniquement lorsque l'option « appliquer à tous les
  fournisseurs routés » est activée ; sinon, chaque fournisseur conserve son propre plafond. Un plafond peut
  seulement réduire une fenêtre de contexte connue : il ne peut ni l'augmenter ni modifier la limite réelle du
  modèle en amont.

```json
{
  "contextCapValue": 350000,
  "providerContextCaps": {
    "anthropic": 350000,
    "cursor": 350000
  }
}
```

## Conseils

- **Ciblez explicitement un compte Codex** avec `<selector>/<native-openai-model>` (règle 1). Cette route est
  exacte et échoue de façon fermée ; elle ne bascule jamais silencieusement vers un autre compte.
- **Soyez explicite pour les modèles routés.** Préférez `provider/model` (règle 3) lorsque cet identifiant public
  exact n'est pas un alias de combinaison. Il nomme directement le fournisseur et correspond à ce que Codex
  affiche dans son sélecteur après la synchronisation du catalogue.
- **Renseignez `models[]` ou `defaultModel`** sur un fournisseur afin que les identifiants courts (règles 5 et 7)
  soient résolus sans le préfixe `provider/`.
- **Les motifs de préfixes sont pratiques, mais ne constituent pas une garantie** : ils ne sont résolus que si
  un fournisseur portant ce nom (par exemple `anthropic` ou `groq`) est effectivement configuré.

Consultez [Configuration](/fr/reference/configuration/) pour connaître les champs de fournisseur lus par ces règles.
