---
title: Pi
description: Utilisez n’importe quel modèle routé depuis Pi — ocx export produit un bloc de fournisseur personnalisé pour le fichier models.json de Pi, relié au proxy en cours d’exécution.
---

Pi lit ses fournisseurs dans un fichier JSON global unique. opencodex ne lance pas Pi : `ocx export` sérialise le bloc du fournisseur `opencodex`, avec l’URL de base, les modèles et une valeur de clé locale non secrète, puis vous le fusionnez dans votre configuration.

## Démarrage rapide

Démarrez le proxy, puis imprimez la configuration :

```bash
ocx start
```

Laissez ce processus en cours. Dans un second terminal, affichez la configuration :

```bash
ocx export --client pi
```

La sortie commence par le JSON, puis affiche le chemin de destination, l’avertissement de fusion, une indication d’utilisation locale et le nombre de modèles dont les limites de contexte sont connues. Cet export prend uniquement en charge un proxy de bouclage sans authentification ; il ne configure pas l’accès distant.

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "compat": {
        "sendSessionAffinityHeaders": true,
        "supportsDeveloperRole": false
      },
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

Les fournisseurs Pi générés activent `compat.sendSessionAffinityHeaders`. Conservez ce réglage lors de la fusion ou de la modification manuelle du fournisseur : Pi transmet un identifiant de session stable, dont OpenCodex dérive l’affinité pour la destination canonique OpenCode Go. Pi peut omettre cet identifiant lorsque `cacheRetention` vaut `none`.

Les fournisseurs Pi générés définissent aussi `compat.supportsDeveloperRole` à `false` : Pi envoie alors son prompt système avec le rôle `system` au lieu de `developer`. OpenCodex transmet les rôles Chat Completions tels quels, et plusieurs amonts compatibles OpenAI refusent `developer` avec une erreur 400 ; tous acceptent `system`.

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

La valeur `apiKey` exportée est `opencodex-loopback`, un marqueur non secret. Aucune variable de clé n’est à exporter. L’exportateur accepte uniquement un proxy de bouclage sans authentification et refuse les proxys distants ou protégés par jeton. Les identifiants des fournisseurs restent dans la configuration d’opencodex, comme décrit dans [Fournisseurs](/fr/guides/providers/) ; ne placez jamais de clé du fournisseur dans ce bloc Pi. Pour un accès distant, utilisez une intégration qui prend en charge les identifiants d’accès au proxy. Modifier le marqueur n’active pas l’export Pi distant.

## Métadonnées du modèle

`contextWindow` et `maxTokens` sont émis uniquement lorsque le catalogue fournit une fenêtre de contexte
faisant autorité. Dans le cas contraire, les deux champs sont omis pour ce modèle et Pi applique ses propres valeurs par défaut ;
`ocx export` affiche le nombre de lignes concernées.

La limite de sortie utilise le maximum connu du modèle dans le catalogue ou les métadonnées générées. La valeur `32000` ne sert que de repli si cette limite est inconnue. La limite est toujours plafonnée à la fenêtre de contexte, et les limites connues inférieures à `32000` sont conservées.

Le champ `cost` est volontairement absent. Il exige les quatre champs de prix, alors qu’OpenCodex ne possède
aucune donnée tarifaire pour les modèles routés ; émettre des zéros reviendrait à affirmer que tous les
modèles sont gratuits.

`reasoning`, autrefois absent, est désormais émis. Pi stocke un booléen tandis que le catalogue possède une
échelle d’effort ; cette correspondance était auparavant trop incertaine. Puisque l’échelle du catalogue
indique maintenant si le proxy accepte les paramètres de raisonnement — les adaptateurs respectent
`reasoning_effort` — une ligne exportée avec une échelle **non vide** reçoit `"reasoning": true`. Une ligne
sans échelle, ou avec une échelle explicitement vide, reste dépourvue de raisonnement. Pi propose ainsi son
contrôle de l’effort exactement pour les modèles auxquels OpenCodex permet de l’envoyer. L’export produit
aussi un `thinkingLevelMap` qui masque avec `null` chaque niveau Pi sans cible déclarée : Pi ne propose ni
n’envoie donc aucun effort absent de l’échelle. Un repli maintient le modèle utilisable : lorsque `ultra`
est déclaré sans `max`, le niveau `max` de Pi est associé à `ultra`, qui appartient bien à l’échelle.
Modifiez ensuite `thinkingLevelMap` manuellement si vous souhaitez une autre correspondance, comme le
documente Pi.

Considérez `reasoning` comme une métadonnée de l’interface Pi : elle découle de l’échelle du catalogue et ne
prouve pas que le service en amont accepte nativement un paramètre de raisonnement. Ce que le proxy envoie
réellement pour une valeur `reasoning_effort` dépend de l’adaptateur et du modèle du fournisseur : il peut
transmettre la valeur, la traduire au moyen d’alias de protocole, la limiter à l’échelle configurée,
l’émuler ou l’omettre entièrement, notamment pour `noReasoningModels`. Le booléen détermine seulement si Pi
propose ce contrôle.

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
