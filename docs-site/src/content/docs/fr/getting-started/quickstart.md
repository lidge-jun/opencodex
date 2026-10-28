---
title: Démarrage rapide
description: "Installez opencodex, ajoutez votre premier fournisseur et connectez votre outil de programmation : Codex, Claude Code, Claude Desktop, Grok Build ou un autre outil pris en charge."
---

Ce guide vous mène d’une nouvelle installation à la première requête de votre outil de programmation. Les étapes 1 et 2 sont communes ; l’étape 3 propose une branche par outil. La [page des clients pris en charge](/fr/reference/client-support/) présente les outils et leurs connexions.

## 1. Exécutez l'assistant de configuration

```bash
ocx init
```

`ocx init` vous accompagne dans les étapes suivantes :

1. **Choix d’un fournisseur** — sélectionnez l’un des 106 préréglages intégrés au registre, ou `custom` pour saisir une
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

Si le port demandé est occupé, `ocx start` s’arrête et indique ce qui l’occupe : exécutez d’abord
`ocx stop` si un processus opencodex y répond, ou démarrez sur un port libre avec
`ocx start --port <port>`. La commande ne change jamais de port d’elle-même : auparavant, ce
comportement laissait deux proxys en cours d’exécution et redirigeait Codex vers le plus récent.

Vérifiez-le :

```bash
ocx status
ocx gui       # ouvre le tableau de bord sur le port actif
```

## 3. Connectez votre outil

Choisissez la branche correspondant à votre outil. Vous pouvez en connecter plusieurs : ils partagent les mêmes fournisseurs et modèles.

### Codex

Si vous avez accepté l’invite Codex à l’étape 1, Codex communique maintenant avec opencodex de manière transparente. Si vous avez refusé cette invite ou si la configuration s’est arrêtée parce qu’une configuration existait déjà, activez le commutateur Codex sur la page **Connect** du tableau de bord avant de lancer Codex ; [Intégration Codex](/fr/guides/codex-integration/) explique les modifications et leur restauration.

```bash
codex "Refactor this function for readability"
```

Pour cibler un modèle routé précis, utilisez dans le sélecteur de Codex la forme `provider/model`, telle qu’elle y apparaît :

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

### Claude Code

Avec le CLI `claude` installé :

```bash
ocx claude
```

`ocx claude` démarre le proxy s’il ne fonctionne pas et lance Claude Code avec un environnement dirigé vers opencodex. Les arguments supplémentaires sont transmis. Consultez [Claude Code](/fr/guides/claude-code/) pour les valeurs par défaut des niveaux, les autres lanceurs et la désactivation.

### Claude Desktop

```bash
ocx claude desktop
```

Lors d’une nouvelle installation, cette commande configure le profil de passerelle pour toute l’application. Une installation utilisant déjà le mode first-party le conserve ; exécutez `ocx claude desktop apply --gateway` pour changer explicitement. Le mode first-party conserve claude.ai pour Desktop et ne route que son onglet Code ; consultez la section sur les modes Claude Desktop dans [Claude Code](/fr/guides/claude-code/).

Quittez complètement puis rouvrez Claude Desktop après un changement de mode.

### Grok Build

Sur une écoute locale, si `~/.grok` existe, `ocx start` enregistre les modèles visibles dans `~/.grok/config.toml`. Choisissez un modèle `ocx-*` dans Grok Build. Les configurations distantes et le bloc géré sont décrits dans [Grok Build](/fr/guides/grok-build/).

Après avoir ajouté des fournisseurs ou des modèles, lancez `ocx ensure` ou redémarrez le proxy pour que Grok Build les voie.

### Autres outils

Les outils avec intégration gérée (OpenCode, Pi, Qoder, WorkBuddy, Kilo, Cline, T3 Code et d’autres) se connectent depuis la page **Connect** du tableau de bord ou avec :

```bash
ocx integration client enable --client <id>
```

Les fichiers de configuration et les délais de prise d’effet sont décrits dans [Intégrations](/fr/guides/integrations/). Tout autre outil acceptant un point de terminaison personnalisé peut utiliser l’URL de base compatible OpenAI `http://localhost:10100/v1` ou l’URL de base Anthropic `http://localhost:10100`.

## Choisissez des modèles de sous-agents (facultatif)

Une nouvelle configuration propose cinq modèles natifs dans le sélecteur de sous-agents de Codex : `gpt-5.5`,
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` et `gpt-6-astra`. Ouvrez `ocx gui` pour remplacer ou
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
