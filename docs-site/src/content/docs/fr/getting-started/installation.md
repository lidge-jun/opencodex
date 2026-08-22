---
title: Installation
description: Installez le proxy opencodex (ocx), ses prérequis et vérifiez qu'il fonctionne.
---

opencodex installe deux commandes équivalentes, `ocx` et `opencodex`. Toutes deux lancent le même petit
serveur HTTP local, fondé sur Bun. Les requêtes de modèles sont envoyées au fournisseur choisi par le
routage. Les services auxiliaires facultatifs de vision et de recherche web peuvent également utiliser votre connexion
ChatGPT lorsqu’un modèle routé en a besoin.

## Prérequis

| Exigence | Pourquoi |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` s’exécute avec Bun, mais ce runtime est fourni automatiquement lors de `npm install` : vous n’avez **pas** à installer Bun vous-même. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App ou SDK) | Le client derrière lequel s’intercale opencodex. opencodex écrit dans `$CODEX_HOME/config.toml` (par défaut `~/.codex/config.toml`). |
| Un compte fournisseur ou une clé API | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, un point de terminaison compatible avec OpenAI ou votre connexion ChatGPT. |

## Installer

```bash
npm install -g @bitkyc08/opencodex
```

:::note[npm a-t-il bloqué le script postinstall de bun ?]
Les versions récentes de npm peuvent bloquer le script postinstall de bun (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`),
ce qui empêche la préparation du runtime Bun fourni. Réinstallez le paquet en autorisant le script de
bun et indiquez toujours le nom du paquet. La suggestion abrégée de npm l’omet et réinstallerait sinon
le répertoire courant :

```bash
npm install -g --allow-scripts=bun @bitkyc08/opencodex

# si l’installation initiale utilisait sudo, continuez à l’utiliser :
sudo npm install -g --allow-scripts=bun @bitkyc08/opencodex
```
:::

Vérifiez que les deux alias de commande sont sur votre `PATH` :

```bash
ocx --version
opencodex --version
```

### Canaux de diffusion

Le canal stable `latest` inclut déjà la prise en charge du catalogue GPT-5.6 Sol/Terra/Luna pour ChatGPT,
les clés API OpenAI, OpenRouter et les routes expérimentales de Cursor. L’accès en amont reste soumis aux droits du compte ;
les entrées du catalogue n’accordent aucun accès par elles-mêmes. N’utilisez le canal de préversion que pour
tester des versions opencodex non encore publiées :

```bash
npm install -g @bitkyc08/opencodex@preview
ocx update --tag preview
```

## Exécuter à partir des sources

Pour développer opencodex lui-même :

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # démarre l’API du proxy en mode développement (src/cli/index.ts start)
bun run dev:gui     # démarre le serveur de développement du tableau de bord (dans un autre terminal)
```

`bun run dev` reste un alias de `bun run dev:proxy`. L’API du proxy expose `/healthz`,
`/v1/responses` et `/api/*`. `GET /` ne sert le tableau de bord empaqueté qu’après que `bun run build:gui`
a produit `gui/dist`. Pendant le développement du tableau de bord, exécutez le frontend séparément avec
`bun run dev:gui`.

## Ce qui est créé

L’état d’opencodex se trouve sous `$OPENCODEX_HOME` (par défaut `~/.opencodex`). Les fichiers d’intégration
Codex actifs se trouvent sous `$CODEX_HOME` (par défaut `~/.codex`).

| Chemin | Objectif |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Vos fournisseurs, fournisseur par défaut, port et options. |
| `$OPENCODEX_HOME/ocx.pid` | PID du proxy en cours d'exécution (garde à instance unique). |
| `$OPENCODEX_HOME/runtime-port.json` | Le PID en direct, le nom d'hôte et le port, y compris un port de secours sélectionné automatiquement. |
| `$OPENCODEX_HOME/auth.json` | Informations d’identification OAuth enregistrées après `ocx login`. |
| `$OPENCODEX_HOME/catalog-backup*.json` | Sauvegardes du catalogue de modèles Codex créées avant toute modification par opencodex. |
| `$CODEX_HOME/config.toml` | Avec une liaison de bouclage, opencodex ajoute une valeur racine `openai_base_url` délimitée par ses marqueurs. Les liaisons hors bouclage utilisent `model_provider = "opencodex"` avec `[model_providers.opencodex]` afin que Codex puisse envoyer l’en-tête d’authentification API. |
| `$CODEX_HOME/opencodex.config.toml` | Profil de secours et de référence écrit à côté de la configuration Codex principale. |
| `$CODEX_HOME/opencodex-catalog.json` | Catalogue de modèles natifs et routés synchronisés utilisé par Codex. |

:::note
opencodex ne supprime jamais votre configuration Codex. Chaque injection est réversible : `ocx stop`,
`ocx restore` ou `ocx eject` supprime exactement les lignes ajoutées par opencodex et restaure Codex natif.
:::

## Suivant

Passez au [démarrage rapide](/fr/getting-started/quickstart/) pour configurer votre premier fournisseur,
ou consultez [Fonctionnement](/fr/getting-started/how-it-works/) pour comprendre l’architecture.
