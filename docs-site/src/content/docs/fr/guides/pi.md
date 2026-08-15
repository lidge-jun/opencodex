---
title: Pi
description: Utilisez n’importe quel modèle routé depuis Pi — ocx export produit un bloc de fournisseur personnalisé pour le fichier models.json de Pi, relié au proxy en cours d’exécution.
---

Pi lit ses fournisseurs dans un fichier JSON global unique plutôt que dans des variables d’environnement ;
opencodex ne lance donc pas Pi. À la place, `ocx export` sérialise le bloc du fournisseur `opencodex` —
URL de base, liste des modèles et référence de variable d’environnement interpolée par Pi — que vous fusionnez ensuite dans votre
propre configuration.

## Démarrage rapide

Démarrez le proxy, puis imprimez la configuration :

```bash
ocx start
ocx export --client pi
```

La sortie commence par le JSON, puis affiche le chemin de destination, l’avertissement de fusion, la ligne
d’exportation de la variable d’environnement et le nombre de modèles dotés de limites de contexte faisant autorité.

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "$OPENCODEX_API_KEY",
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

Les identifiants de modèle sont les sélecteurs canoniques du proxy : les modèles routés apparaissent donc sous la forme `provider/model`
(`anthropic/claude-opus-5`) et les slugs natifs OpenAI restent sans préfixe (`gpt-5.6-sol`). Le `name`
suffixe — `(anthropic)`, `(native)`, `(routed)` — permet de distinguer, dans le sélecteur de Pi, deux modèles de même nom
provenant de services en amont différents.

## Où ça va

La configuration globale du modèle Pi est :

```text
~/.pi/agent/models.json
```

:::caution[Fusionnez, ne remplacez jamais]
`ocx export` n’écrit jamais dans ce fichier. Fusionnez-y le bloc `providers.opencodex` : remplacer le
fichier supprimerait tous les autres fournisseurs que vous y avez configurés. L’option `--out` permet d’utiliser un chemin temporaire
et refuse d’écraser un fichier existant sans `--force` :

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # or redirect the byte-exact JSON
```
:::

Le bloc exporté est un instantané statique et non une vue en direct. Réexécutez `ocx export` après avoir ajouté un
fournisseur ou modification de la visibilité du modèle, et fusionnez le nouveau bloc sur l'ancien.

## La clé d'admission

Deux clés différentes sont ici faciles à confondre, et seule la première apparaît dans ce fichier :

| Clé | Qu'est-ce que c'est | Où il vit |
| --- | --- | --- |
| Clé d'admission proxy | Les propres informations d'identification de opencodex, générées dans l'onglet **API** du tableau de bord | référencé par `apiKey` comme `$OPENCODEX_API_KEY` ; la valeur reste dans votre environnement |
| Clé du fournisseur | votre touche Anthropic / OpenAI / OpenRouter | La propre configuration de opencodex, selon [Fournisseurs](/fr/guides/providers/) |

La configuration exportée ne contient que la référence, jamais le secret. Pi interpole une valeur simple de la forme `$NAME` ;
la variable est :

```bash
export OPENCODEX_API_KEY=<your key>
```

Ce nom est propre à Pi. opencode utilise une autre variable
(`OPENCODEX_OPENCODE_API_KEY`, sous la forme `{env:…}`) — voir le [guide opencode](/fr/guides/opencode/).

**Un proxy lié à l’interface de bouclage n’a besoin d’aucune clé.** Par défaut, opencodex se lie à `127.0.0.1` et n’y exige
aucune authentification ; la référence `$OPENCODEX_API_KEY` est donc inerte et la variable peut rester indéfinie.
Cela n'a d'importance que lorsque `hostname` est défini au-delà du bouclage, ce qui est également le cas lorsque le proxy
refuse de démarrer sans jeton — voir [Accès à distance](/fr/reference/configuration/server/#accès-à-distance).

## Métadonnées du modèle

`contextWindow` et `maxTokens` sont émis uniquement lorsque le catalogue fournit une fenêtre de contexte
faisant autorité. Dans le cas contraire, les deux champs sont omis pour ce modèle et Pi applique ses propres valeurs par défaut ;
`ocx export` affiche le nombre de lignes concernées.

`maxTokens` est un budget de `32000` destiné à satisfaire le schéma. Il est plafonné à la fenêtre de contexte, de sorte qu’un
modèle doté d’un petit contexte ne reçoive jamais davantage de sortie que de contexte. Cette valeur ne constitue pas une affirmation sur la
limite maximale réelle d’un modèle donné.

Deux champs sont volontairement absents. `cost` nécessite les quatre champs de prix et opencodex n'a pas
données de prix pour les modèles acheminés – émettre des zéros affirmerait que chaque modèle est gratuit. `reasoning` est
un booléen en Pi alors que le catalogue comporte une échelle d'effort, et mapper l'un sur l'autre serait
une supposition.

## Statut du schéma

:::note[Non vérifié sur une installation réelle]
La forme ci-dessus suit la documentation publiée par le fournisseur personnalisé de Pi. Il n'a **pas** été vérifié
sur un véritable fichier `~/.pi/agent/models.json`, sur une machine où Pi est installé. Si Pi rejette le bloc
exporté, l’incompatibilité vient de notre côté : veuillez
[ouvrir un ticket](https://github.com/lidge-jun/opencodex/issues) en indiquant le message renvoyé par Pi.
:::

## Exigences

Un proxy opencodex en cours d'exécution (`ocx start`) et Pi installés. `ocx export` lit le catalogue en direct
via la gestion du proxy API, donc une config ne peut jamais être émise avec une liste de modèles vide.
