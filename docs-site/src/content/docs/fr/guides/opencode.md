---
title: opencode
description: Utilisez n’importe quel modèle routé depuis opencode — opencodex injecte un bloc de fournisseur à l’exécution sans modifier votre propre configuration opencode.
---

opencode lit ses fournisseurs dans des couches de configuration JSON fusionnées plutôt que dans des variables
d’environnement ; il n’existe donc aucun emplacement de type `ANTHROPIC_BASE_URL` dans lequel injecter une valeur. `ocx opencode`
comble cette lacune : il s’assure que le proxy fonctionne, crée un bloc fournisseur à partir du
catalogue visible, puis l’injecte au moyen de la couche d’exécution en ligne d’OpenCode
(`OPENCODE_CONFIG_CONTENT`).

## Démarrage rapide

```bash
ocx opencode
```

Cette commande s’assure que le proxy fonctionne et lance opencode en injectant les blocs
`provider.opencodex` et `providers.opencodex` générés pour ce processus. Les arguments supplémentaires sont transmis tels quels :
`ocx opencode run "hello"`.

Les modèles acheminés apparaissent dans le sélecteur sous le fournisseur `opencodex` :

```text
opencodex/kiro/glm-5
opencodex/gpt-5.6-sol      # native slugs stay unprefixed
```

## Votre propre configuration n'est jamais modifiée

Le lanceur ne copie ni ne réécrit `~/.config/opencode/opencode.json`,
les fichiers de projet `opencode.json` / `opencode.jsonc`, ni aucune autre couche de configuration sur disque. Il peut
lire la configuration globale ou celle du projet afin de détecter une redéfinition de `provider.opencodex` ou `providers.opencodex`, tandis que vos
fournisseurs, agents, raccourcis clavier, entrées MCP et références relatives `{file:…}` existants
continuent d’être résolus depuis leurs fichiers d’origine.

Pour ce lancement uniquement, opencodex ajoute les blocs `provider.opencodex` et `providers.opencodex` générés via
la couche d’exécution en ligne d’OpenCode. Cette couche est fusionnée après les configurations globale, personnalisée et de projet,
et ne remplace que les clés en conflit pour le processus enfant.

| Couche | Comportement avec `ocx opencode` |
| --- | --- |
| Configuration globale/personnalisée/de projet | Conservée sur disque exactement telle que vous l’avez écrite |
| Exécution en ligne (`OPENCODE_CONFIG_CONTENT`) | Reçoit les blocs `provider.opencodex` et `providers.opencodex` générés (fusionnés dans toute config en ligne héritée) |
| Chemins relatifs `{file:…}` | Toujours résolus par rapport au fichier de configuration qui les a définis à l’origine |

Si une configuration globale ou de projet définit également `provider.opencodex` ou `providers.opencodex`, le lanceur affiche une
note d’information : la couche d’exécution de `ocx opencode` la remplace pour ce lancement.

## Ajouter le bloc à votre propre configuration

`ocx opencode` injecte le bloc fournisseur pour un seul lancement, ce qui signifie simplement `opencode` toujours
ne sait rien du proxy. Lorsque vous souhaitez que les modèles acheminés soient disponibles à partir de `opencode` — ou
depuis une extension d'éditeur qui ne passe jamais par le lanceur — `ocx export` imprime la même chose
bloc fournisseur à fusionner dans votre propre configuration :

```bash
ocx export --client opencode
```

Le proxy doit être en cours d'exécution. La commande imprime la config, la destination canonique
(`~/.config/opencode/opencode.json`, ou sous `XDG_CONFIG_HOME` lorsque cela est défini), la fusion
avertissement et la ligne d'exportation env. Il ne touche jamais à ce fichier — la section ci-dessus reste vraie, et
déplacer le bloc dans votre configuration est votre acte explicite.

:::caution[Fusionnez, ne remplacez jamais]
Fusionnez les deux blocs — `provider.opencodex` et `providers.opencodex` — dans votre configuration existante. Remplacer tout le fichier par le
celui exporté détruit vos autres fournisseurs, agents, raccourcis clavier et entrées MCP. `ocx export --out`
refuse d'écraser un fichier existant exactement pour cette raison, alors pointez `--out` sur un chemin de travail
et copiez les blocs :

```bash
ocx export --client opencode --out ~/opencodex-opencode.json
```
:::

Contrairement au bloc d'exécution du lanceur, un bloc fusionné est un instantané statique : il ne suit pas votre
catalogue. Réexécutez `ocx export` après avoir ajouté un fournisseur ou modifié la visibilité du modèle.

Une fois fusionné, exportez la clé d'admission avant de lancer l'opencode — sauf si le proxy est en bouclage,
là où aucun n'est nécessaire :

```bash
export OPENCODEX_OPENCODE_API_KEY=<your key>
```

## La clé d’admission n’est pas écrite sur disque

La configuration enregistre la référence `{env:OPENCODEX_OPENCODE_API_KEY}`, jamais le secret lui-même.
Sur une liaison de bouclage, cette référence est utilisée comme valeur `apiKey`. Sur une liaison hors
bouclage, OpenCode résout la variable et n’envoie sa valeur que dans `x-opencodex-api-key`, afin que
l’admission au proxy reste distincte de tout en-tête `Authorization` destiné au fournisseur en amont.

Exemple de bouclage :

```json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}"
}
```

Exemple sans bouclage :

```json
"options": {
  "baseURL": "http://192.168.1.10:10100/v1",
  "headers": {
    "x-opencodex-api-key": "{env:OPENCODEX_OPENCODE_API_KEY}"
  }
}
```

La valeur réelle est transmise uniquement via l'environnement du processus enfant.
`OPENCODEX_API_AUTH_TOKEN` est prioritaire, puis le fichier de jeton de service renforcé, puis
une clé API configurée — ce qui est ce qu'exige une liaison sans bouclage.

Une liaison de bouclage (`127.0.0.1`, la valeur par défaut) n'authentifie rien, donc la référence `{env:…}` est
inerte et vous pouvez laisser la variable non définie. Cela n'a d'importance que lorsque `hostname` est défini au-delà du bouclage ;
voir [Accès à distance](/fr/reference/configuration/server/#accès-à-distance). Cette clé d'admission est celle de opencodex
propre et n'est pas lié aux clés du fournisseur en amont configurées sous
[Prestataires](/fr/guides/providers/).

## Rétablissement

Rien à annuler — aucun fichier de configuration généré n'est écrit sous `~/.opencodex`. Courez simplement
`opencode` et il lit votre propre configuration exactement comme avant.

## Limites du modèle

`limit.context` n’est écrit que lorsque le catalogue fournit une fenêtre de contexte faisant autorité. Dans le cas
contraire, le bloc `limit` entier est omis et opencode conserve ses propres valeurs par défaut.

Le schéma d’opencode rejette un bloc `limit` qui contient `context` sans `output`. Comme le catalogue ne fournit
aucune limite de sortie faisant autorité par modèle, opencodex émet également un budget `output` de `32000`, limité
à la fenêtre de contexte afin qu’un modèle à petit contexte ne reçoive jamais `output > context`. Cette valeur sert
uniquement à satisfaire le schéma ; elle ne prétend pas représenter la véritable limite d’un modèle particulier.

Le bloc fournisseur `opencodex` est régénéré à chaque lancement, donc des ajustements par modèle y sont apportés
ne survivra pas. Conservez plutôt les entrées personnalisées sous votre propre clé de fournisseur.

## Exigences

opencode doit être installé et sur `PATH` :

```bash
npm install -g opencode-ai
```
