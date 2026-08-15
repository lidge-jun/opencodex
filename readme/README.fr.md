# opencodex

<h3 align="center">make codex open!</h3>
<p align="center"><b>Proxy universel de fournisseurs pour OpenAI Codex, Claude Code, Claude Desktop et Grok Build</b><br>
Deux commandes suffisent pour que chacun d'eux exécute le LLM de votre choix.</p>

<p align="center">
  <a href="https://x.com/claudeebum"><img src="https://img.shields.io/badge/%40claudeebum-000000?logo=x&logoColor=white" alt="Suivre @claudeebum sur X"></a>
  <a href="https://www.npmjs.com/package/@bitkyc08/opencodex"><img src="https://img.shields.io/npm/v/@bitkyc08/opencodex?color=cb3837&label=npm&logo=npm" alt="version npm"></a>
  <a href="https://github.com/lidge-jun/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@bitkyc08/opencodex?color=blue" alt="licence"></a>
  <img src="https://img.shields.io/node/v/@bitkyc08/opencodex?logo=node.js&label=node" alt="version de Node">
</p>

```bash
npm install -g @bitkyc08/opencodex
ocx start        # proxy et tableau de bord sur le port par défaut localhost:10100
```

<table align="center">
  <tr>
    <td width="50%" align="center">
      <img src="../assets/claude-code-models.gif" alt="Claude Code exécutant un modèle routé par opencodex — la barre d'état affiche gpt-5.6-luna-medium comme modèle actif" width="410"><br>
      <sub><b>Claude Code, exécutant n'importe quel modèle.</b><br>Le sélecteur est celui d'origine de Claude Code. Le moteur qui l'anime ne l'est pas.</sub>
    </td>
    <td width="50%" align="center">
      <img src="../assets/demo.gif" alt="démonstration d'opencodex — exécution d'une tâche dans l'application Codex avec un modèle routé non-OpenAI" width="410"><br>
      <sub><b>Codex, exécutant n'importe quel modèle.</b><br>Choisissez un fournisseur et lancez-vous — même flux de travail, autre moteur.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="../assets/claude-desktop-subagent.gif" alt="Claude Desktop répondant avec Claude Opus 4.8, puis déléguant à un sous-agent GPT-5.6 Sol par l'intermédiaire d'opencodex" width="410"><br>
      <sub><b>Claude Desktop, exécutant n'importe quel modèle.</b><br>Opus répond, puis confie la tâche à un sous-agent GPT-5.6 Sol.</sub>
    </td>
    <td width="50%" align="center">
      <img src="../assets/grok-build-subagent.gif" alt="Grok Build exécutant GPT-5.6 Sol par l'intermédiaire d'opencodex et appelant un sous-agent Kimi K3" width="410"><br>
      <sub><b>Grok Build, exécutant n'importe quel modèle.</b><br>Sol pilote la session et appelle un sous-agent Kimi K3.</sub>
    </td>
  </tr>
</table>

<p align="center">
  <a href="../README.md">English</a> · <b>Français</b> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ru.md">Русский</a> · <a href="README.ja.md">日本語</a> · <a href="README.tr.md">Türkçe</a> · 📖 <a href="https://opencodex.me/fr/"><b>Documentation complète →</b></a>
</p>

opencodex est un proxy local léger qui traduit l'API Responses de Codex vers le protocole utilisé
par votre fournisseur — streaming, appels d'outils, jetons de raisonnement et images, dans les deux
sens. Utilisez Claude, Gemini, Grok, GLM, DeepSeek, Kimi, Qwen, Ollama ou tout autre LLM avec Codex,
Claude Code, Claude Desktop et Grok Build. Il peut également gérer un **groupe de comptes ChatGPT**
pour l'authentification Codex : ajoutez des comptes, actualisez leurs quotas dans le tableau de bord
et laissez les nouvelles sessions être automatiquement routées vers le compte opérationnel le moins utilisé,
tandis que les fils existants restent associés au compte qui les a démarrés.

## Démarrage rapide

### Pour les humains

```bash
npm install -g @bitkyc08/opencodex   # Node 18+ ; le runtime Bun est inclus automatiquement
ocx start                            # ou `ocx service` pour l’exécuter en arrière-plan
```

<details>
<summary>Installer depuis les sources (dernière version de développement, Bun canary)</summary>

**macOS / Linux :**

```bash
curl -fsSL https://bun.sh/install | bash && ~/.bun/bin/bun upgrade --canary
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex && ~/.bun/bin/bun install
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell) :**

```powershell
irm bun.sh/install.ps1 | iex; bun upgrade --canary
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex; bun install
bun run src/cli/index.ts start
```

L'installation depuis les sources exécute la dernière version de la branche `dev` avec Bun canary.
Les correctifs de gestion de la mémoire, les améliorations du ramasse-miettes de l'environnement
d'exécution et les correctifs non publiés y sont disponibles avant leur arrivée dans le paquet npm.

</details>

Ouvrez **http://localhost:10100** et configurez tout dans le tableau de bord web — ajoutez des
fournisseurs (plus de 40 intégrés, ou n'importe quel point de terminaison compatible OpenAI),
choisissez les modèles et gérez les comptes. `ocx gui` permet de rouvrir le tableau de bord à tout moment.
Il peut également gérer un **groupe de comptes ChatGPT** pour l'authentification Codex. Ajoutez plusieurs
comptes ChatGPT / Codex et actualisez leurs quotas sur 5 h / hebdomadaires / 30 j dans le tableau de bord.
Avec le routage par quota, les nouvelles sessions peuvent utiliser le compte opérationnel le moins sollicité ;
les modes round-robin et fill-first appliquent leurs propres politiques. Les fils Codex existants restent
normalement associés au compte qui les a démarrés, afin que les longues sessions SSH, tmux ou connectées
depuis un appareil mobile ne changent pas de compte en cours de conversation — mais la réévaluation des
quotas, le basculement, l'exclusion d'un compte, l'expiration de l'association ou la récupération après
une erreur 401/403 ou 429 peuvent les réassocier. Attribuez un ordre de sélection aux comptes lorsque
l'un d'eux — généralement votre connexion Codex Desktop — ne doit être utilisé qu'une fois les autres épuisés.

### Pour les agents

```bash
npm install -g @bitkyc08/opencodex
ocx start     # ou `ocx service`
ocx init      # configuration interactive : écrit ~/.opencodex/config.json et relie Codex
```

`ocx init` ne démarre jamais le proxy ; démarrez-le d'abord (ou après — les deux ordres fonctionnent,
mais les commandes sans interface comme `ocx provider add` et `ocx combo set` communiquent avec le proxy
**actif** et se terminent avec un code différent de zéro s'il est inaccessible). `ocx status` / `ocx doctor` /
`ocx health` indiquent l'état d'exécution.

> **Agents qui installent ou exécutent opencodex :** lisez
> [`AGENTS_INSTALL.md`](../AGENTS_INSTALL.md). Une exécution interactive de `ocx start` peut demander une
> fois s'il faut ajouter une étoile à ce dépôt — cette décision appartient à l'utilisateur, jamais à un agent.
> La CLI masque cette invite lors des exécutions pilotées par un agent et l'API les refuse avec
> `403 agent_consent_required`.

## Plateformes prises en charge

| Système d'exploitation | État | Gestionnaire de services |
|---|---|---|
| macOS (arm64 / x64) | Entièrement pris en charge | launchd |
| Linux (x64 / arm64) | Entièrement pris en charge | systemd (unité utilisateur) |
| Windows (x64) | Entièrement pris en charge | Planificateur de tâches (masqué) / service natif en option (`--native`, WinSW) |

Nécessite [Node](https://nodejs.org) 18 ou version ultérieure. L'environnement d'exécution Bun est inclus
lors de `npm install` — aucune installation séparée de Bun n'est nécessaire, ni WSL sous Windows. Si npm a
bloqué les scripts d'installation de l'environnement inclus, consultez la
[documentation d'installation](https://opencodex.me/fr/getting-started/installation/).

## Points forts

- **Utilisez n'importe quel LLM avec Codex, Claude Code, Claude Desktop et Grok Build** — plus de 40
  fournisseurs prêts à l'emploi, chacun conservant sa propre interface native.
- **Regroupez les comptes ChatGPT en toute sécurité** — association aux fils, basculement automatique
  tenant compte des quotas, période de récupération et gestion de l'authentification en mode fail-closed.
- **Combos** — un identifiant de modèle virtuel avec basculement ou round-robin pondéré entre fournisseurs.
  Consultez le [guide des combos](https://opencodex.me/fr/guides/combos/).
- **Des sous-agents sur n'importe quel modèle** — affichez les modèles routés dans le sélecteur de sous-agents
  de Codex, avec contrôle des surfaces v1/v2 et chaînes de repli. Consultez le
  [guide des sous-agents](https://opencodex.me/fr/guides/sub-agent-surface/).
- **Connectez-vous une fois, oubliez la clé API** — OAuth pour xAI, Anthropic et Kimi ; ou transmettez
  `codex login`, collez une clé ou utilisez des références `${ENV_VAR}`.
- **Modules complémentaires de recherche web et de vision** — les modèles non-OpenAI bénéficient d'une
  véritable recherche web et de la compréhension d'images grâce à un module complémentaire utilisant
  votre connexion ChatGPT.
- **Voyez ce qui se passe** — le tableau de bord affiche les fournisseurs, l'état OAuth, la sélection des
  modèles et un journal des requêtes en direct avec le nombre de jetons de cache.
- **Arrêt propre, aucun résidu** — `ocx stop` restaure la configuration d'origine de Codex.
- **Gestion bornée de la mémoire** — chaque cache, tampon circulaire et stockage de traduction de protocole
  à longue durée de vie possède une limite finie, un budget en octets ou une réconciliation active. Aucun
  `Map` ou `Set` non borné ne subsiste après le rechargement de la configuration.

<details>
<summary>Détails de la gestion de la mémoire</summary>

OpenCodex suit 36 catégories d'état conservé par le processus. Chacune possède une limite documentée :

- **12 stockages conservés** (journal des requêtes, tampons circulaires de débogage, cache d'images,
  cache de modèles, descriptions visuelles, blobs de curseurs, continuation des réponses, etc.) sont
  comptabilisés en octets et évincés selon le budget mémoire géré par l'application (256 Mio par défaut).
- **4 tampons observés** (accumulateurs de traduction, segments finaux d'images/OAuth/Grok) sont surveillés
  pour détecter la pression des octets en cours de traitement, sans éviction.
- **24 enregistrements de stockages d'état** gèrent les balayages d'expiration (intervalle de 60 s) et la
  réconciliation des générations de configuration afin de supprimer les clés obsolètes des fournisseurs
  et des comptes.
- **Les mémos de chemins et d'empreintes** (métadonnées de l'espace de travail, identités renforcées, sels
  d'installation, capacités indiquées par le mode) utilisent des limites LRU selon l'ordre d'insertion
  (8 à 128 entrées).
- **Les marqueurs de suppression des générations du cache de modèles** sont supprimés après réconciliation ;
  l'incrémentation globale de la génération empêche les découvertes obsolètes en cours de repeupler les
  fournisseurs supprimés.
- **La déduplication des identifiants d'événements du Lab** s'exécute sous un verrou de registre sur disque,
  sans index en mémoire vive au niveau du processus.

Exécutez `GET /api/system/memory` (avec le jeton d'administration) pour consulter en direct les octets
conservés, les compteurs d'éviction et les échantillons du watchdog.

</details>

## Routage des modèles

Ciblez n'importe quel fournisseur et modèle configuré avec la syntaxe `provider/model` :

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "google/gemini-3-pro" "Write unit tests for auth.ts"
codex -m "ollama/llama3" "Refactor this function"
```

Omettez le préfixe `provider/` pour utiliser le fournisseur par défaut ou établir automatiquement la
correspondance selon le motif du nom du modèle. Les identifiants de modèles du fournisseur contenant `/`
sont présentés avec leurs barres obliques internes remplacées par `-` ; la forme brute comportant toutes
les barres obliques continue également de fonctionner. Détails :
[documentation sur le routage des modèles](https://opencodex.me/fr/guides/model-routing/).

## Fournisseurs et adaptateurs

OpenAI (connexion ChatGPT ou clé API), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama
(local + Cloud), Cursor (expérimental) et tous les points de terminaison compatibles OpenAI — ainsi que
DeepSeek, Groq, OpenRouter, Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax,
Qwen Cloud, SiliconFlow et bien d'autres. Liste complète : `ocx init` ou la
[documentation des fournisseurs](https://opencodex.me/fr/guides/providers/).

## CLI

```bash
ocx init                       # configuration interactive (écrit la configuration, relie Codex, propose le shim)
ocx start [--port 10100]       # démarre le proxy au premier plan
ocx stop                       # arrête le proxy et restaure Codex natif
ocx service [install|start|stop|status|uninstall|remove]  # service en arrière-plan
ocx codex-shim install         # démarre le proxy à la demande lors du lancement de `codex`
ocx health [--json]            # vérifie immédiatement que le proxy répond
ocx ready [--json] [--wait [--timeout <seconds>]]  # vérifie l’état après synchronisation
ocx status                     # indique si le proxy est actif
ocx gui                        # ouvre le tableau de bord web
ocx provider <...>             # gère les fournisseurs (list/add/edit/test/remove)
ocx account <...>              # gère les comptes ChatGPT et les groupes de clés API
ocx combo <...>                # gère les combos de basculement ou de rotation
ocx v2 <...>                   # contrôle les surfaces multi-agents v1/v2
ocx update [--tag preview]     # met à jour opencodex
```

Les démarrages sans port imposé peuvent choisir un autre port libre si celui qui est préféré est occupé ;
un `--port` explicite ne change jamais de port. Référence complète :
[documentation de la CLI](https://opencodex.me/fr/reference/cli/).

### État de fonctionnement et disponibilité

`GET /healthz` indique immédiatement l'état de fonctionnement du proxy. Le point de terminaison non
authentifié `GET /readyz` indique la disponibilité après synchronisation avec l'identité JSON assainie
`{service, version, uptime, pid, port, status}`. Il renvoie `200` lorsque `status` vaut `ready` ; les états
`pending` et l'état terminal `failed` renvoient `503` avec `Retry-After: 1`.

`ocx ready [--json] [--wait [--timeout <seconds>]]` effectue une seule sonde par défaut. `--wait` interroge
pendant 45 secondes au maximum par défaut, mais s'arrête immédiatement s'il observe l'état terminal `failed` ;
`--timeout <seconds>` définit une limite de 1 à 300 secondes, nécessite `--wait` et n'accepte que les entiers
positifs. La sortie `--json` de la CLI est `{ready, status, pid, port}`, où `status` vaut `ready`, `pending`,
`failed` ou `unreachable`.

| Sortie | Résultat |
| --- | --- |
| `0` | Prêt |
| `1` | Non prêt : en attente, échec, expiration du délai ou inaccessible |
| `64` | Arguments non valides |

Un proxy plus ancien dépourvu de `/readyz` adopte par sécurité l'état `unreachable` avec le code de sortie 1,
tandis que `ocx health` reste compatible.

### Démarrage automatique : service ou shim

Utilisez le **service** (`ocx service`) pour un proxy toujours actif qui redémarre après un plantage. Utilisez
le **shim** (`ocx codex-shim install`) pour un démarrage léger à la demande sans démon en arrière-plan.
Supprimez-les avec `ocx service uninstall` / `ocx codex-shim uninstall`.

### Désinstallation

```bash
ocx uninstall                  # arrête, supprime le service ou shim, restaure Codex natif et nettoie l’état
npm uninstall -g @bitkyc08/opencodex
```

## Accès distant

Par défaut, opencodex se lie à `127.0.0.1` et ne nécessite aucune authentification supplémentaire. Une liaison
au-delà de l'adresse de bouclage (`"hostname": "0.0.0.0"`) **nécessite** un jeton bearer — le proxy refuse de
démarrer sans `OPENCODEX_API_AUTH_TOKEN`, et chaque requête cliente doit le fournir dans
`x-opencodex-api-key`. Détails :
[référence de configuration](https://opencodex.me/fr/reference/configuration/).

## Documentation

La documentation publique — installation, fournisseurs, routage, combos, sous-agents, modules complémentaires,
intégrations et références de la CLI, de la configuration et de l'API de gestion — est générée depuis
[`docs-site/`](../docs-site) et publiée sur **[opencodex.me](https://opencodex.me/fr/)**.

Les notes de référence des mainteneurs se trouvent dans [`structure/`](../structure), la configuration pour
les contributeurs dans [`CONTRIBUTING.md`](../CONTRIBUTING.md) et le signalement de problèmes de sécurité dans
[`SECURITY.md`](../SECURITY.md). Signalez les vulnérabilités non divulguées en privé grâce au
[signalement privé de vulnérabilités de GitHub](https://github.com/lidge-jun/opencodex/security/advisories/new),
et non dans une issue publique.

## Développement

Le développement depuis les sources nécessite la CLI `bun` dans votre `PATH`. Elle est distincte de
l'environnement d'exécution Bun inclus dans le paquet npm publié, lequel est uniquement utilisé par les
commandes `ocx` installées.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run typecheck
bun run test
```

Consultez le guide **[Contribuer](../CONTRIBUTING.md)**.

## Avis de non-responsabilité

opencodex est un projet indépendant maintenu par la communauté et **n'est affilié ni à OpenAI, ni à Anthropic,
ni à aucun autre fournisseur, et n'est approuvé par aucun d'eux**.

Certains fournisseurs — notamment Anthropic (Claude) — peuvent suspendre ou restreindre les comptes qui
acheminent le trafic API par des proxys tiers. **Utilisation à vos propres risques (UAYOR).** Avant de connecter
un fournisseur, consultez ses conditions d'utilisation pour vérifier que l'accès par proxy est autorisé. Les
mainteneurs d'opencodex ne sont pas responsables des mesures prises sur les comptes par les fournisseurs en amont.

## Licence

MIT
