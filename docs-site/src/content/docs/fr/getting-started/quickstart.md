---
title: Démarrage rapide
description: Configurez votre premier fournisseur et acheminez OpenAI Codex via opencodex en trois commandes.
---

Ce guide part d’une installation neuve et vous conduit jusqu’à l’exécution de Codex sur un modèle autre qu’OpenAI.

## 1. Exécutez l'assistant de configuration

```bash
ocx init
```

`ocx init` vous accompagne dans les étapes suivantes :

1. **Choix d’un fournisseur** — sélectionnez l’un des 79 préréglages intégrés au registre, ou `custom` pour saisir une
   URL de base et un adaptateur.
2. **Clé API** — collez une clé ou référencez une variable d’environnement telle que `${ANTHROPIC_API_KEY}`.
3. **Modèle par défaut** — pour les fournisseurs clés, locaux et personnalisés, acceptez le préréglage ou saisissez un identifiant de modèle.
4. **Port proxy** — la valeur par défaut est `10100`.
5. **Injecter dans Codex ?** — avec une configuration de bouclage normale, opencodex ajoute une valeur racine `openai_base_url` à
   `$CODEX_HOME/config.toml` (`~/.codex/config.toml` par défaut) donc le fournisseur `openai` intégré de Codex
   cible le proxy. Les liaisons distantes ou LAN utilisent à la place une entrée de fournisseur dédiée avec un en-tête d’authentification API.
6. **Installer le shim de démarrage automatique ?** — lorsqu’il est activé, le lancement de `codex` exécute d’abord `ocx ensure`.

Le résultat est enregistré dans `$OPENCODEX_HOME/config.json` (par défaut `~/.opencodex/config.json`).

:::note[Entrées de déploiement GPT-5.6]
La version stable actuelle contient des entrées initiales GPT-5.6 Sol/Terra/Luna pour le transfert direct
ChatGPT, les clés API OpenAI, OpenRouter et l’adaptateur expérimental Cursor. Elles ne fonctionnent que si
le compte en amont dispose de l’accès correspondant. Les préréglages de clé API OpenAI et OpenRouter
annoncent une fenêtre de contexte utilisable de 372 000 jetons ; Cursor conserve les métadonnées de son adaptateur.
:::

## 2. Démarrez le proxy

```bash
ocx start            # utilise le port 10100 par défaut
ocx start --port 8080
```

Au démarrage, opencodex :

- écrit son PID à `~/.opencodex/ocx.pid` (et refuse de démarrer deux fois),
- découvre les modèles en direct lorsque le fournisseur le permet et **synchronise les entrées natives et routées dans
  le catalogue de modèles de Codex**,
- écoute sur `http://localhost:<port>/v1`.

Si le port demandé est occupé, `ocx start` sélectionne un port libre, l'enregistre dans `runtime-port.json`,
et met à jour Codex pour utiliser l'écouteur en direct.

Vérifiez-le :

```bash
ocx status
ocx gui       # ouvre le tableau de bord sur le port actif
```

## 3. Utiliser Codex

Codex parle maintenant à opencodex de manière transparente :

```bash
codex "Refactor this function for readability"
```

Pour cibler un modèle routé précis, utilisez dans le sélecteur de Codex la forme `provider/model`, telle qu’elle y apparaît :

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## Choisissez des modèles de sous-agents (facultatif)

Une nouvelle configuration propose cinq modèles natifs dans le sélecteur de sous-agents de Codex : `gpt-5.5`,
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` et `gpt-5.4-mini`. Ouvrez `ocx gui` pour remplacer ou
réorganiser jusqu’à cinq modèles natifs ou routés. Le tableau de bord peut également définir un modèle de sous-agent
préféré et un effort de raisonnement. Consultez [Interface des sous-agents](/fr/guides/sub-agent-surface/)
pour choisir v1, base ou v2 et comprendre quand s’appliquent les instructions, les valeurs natives par défaut et les replis.

## Se connecter au lieu de coller une clé

Certains fournisseurs prennent en charge la connexion à un compte réel (OAuth, actualisation automatique) :

```bash
ocx login xai          # ou : anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

OpenAI lui-même ne nécessite **aucune clé** : le fournisseur par défaut transfère directement les informations
d’identification de votre `codex login` existant (consultez [Fournisseurs](/fr/guides/providers/)).

## Arrêt et restauration

```bash
ocx stop          # arrête le proxy et restaure Codex natif
ocx restore       # restaure Codex natif sans arrêter le proxy (alias : ocx eject)
ocx restore back  # route de nouveau Codex par le proxy toujours actif
```

## Suivant

- [Fonctionnement](/fr/getting-started/how-it-works/) — ce qui arrive à chaque requête.
- [Fournisseurs](/fr/guides/providers/) — toutes les manières de s'authentifier.
- [Configuration](/fr/reference/configuration/) — la référence `config.json` complète.
