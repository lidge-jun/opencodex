---
title: Contribuer
description: Développez opencodex — installation, structure, conventions et ajout d’un fournisseur ou d’un adaptateur.
---

## Configuration

Le développement depuis les sources exige la CLI `bun` dans votre `PATH`. Le paquet npm publié fournit son propre
runtime Bun aux utilisateurs, mais les scripts de ce dépôt utilisent votre installation locale de Bun.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy    # proxy API in dev mode
bun run dev:gui      # dashboard dev server (another terminal)
bun run typecheck    # bun x tsc --noEmit
bun run test         # bun test ./tests/
```

`bun run dev` reste un alias pour `bun run dev:proxy`. Le serveur de développement du tableau de bord est `bun run dev:gui` ;
le tableau de bord packagé en `GET /` est produit par `bun run build:gui` (`gui/dist`).

## Commandes de construction et de test

Le paquet racine est écrit en TypeScript natif pour Bun ; le serveur ne possède aucune étape de compilation
distincte. Utilisez les scripts enregistrés afin que les commandes locales correspondent à la CI :

```bash
bun run typecheck                 # strict TypeScript check
bun run test                      # complete tests/ suite
bun test tests/router.test.ts     # focused test file
bun run build:gui                 # Vite GUI build + package preparation
bun run privacy:scan              # credential/privacy scan used by CI
bun run prepare:package           # refresh package launchers/assets
```

La plupart des tests Bun sont des fichiers plats `tests/*.test.ts`. `tests/helpers/` contient les fixtures
partagées et `tests/e2e-style/` des scénarios plus larges de parité native. Placez une régression ciblée près
des tests existants du sous-système modifié. Exécutez la suite complète pour le routage partagé, les adaptateurs,
la configuration ou le comportement du serveur.

Le site de documentation que vous lisez se trouve dans `docs-site/` (Astro + Starlight) :

```bash
cd docs-site && bun install && bun dev
```

## Publication de la documentation

La documentation publique est publiée sur GitHub Pages à l’adresse <https://opencodex.me/>. Le workflow
`.github/workflows/deploy-docs.yml` s’exécute lors des push sur `main` qui modifient `docs-site/**` ou le
workflow lui-même. Il construit `docs-site` et déploie le site généré. Avant de pousser une modification,
exécutez :

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## CI et versions

Les workflows GitHub Actions restent volontairement limités :

- **CI multiplateforme** (`.github/workflows/ci.yml`) s’exécute sur toutes les pull requests et sur les push vers
  `dev`, `preview` et `main`. Un filtre interne limite les tâches coûteuses aux changements qui touchent le runtime,
  les tests, les paquets, les scripts, TypeScript ou les workflows, tout en produisant un contrôle agrégé explicite
  pour les PR documentaires. La suite principale est répartie sur Linux et exécutée intégralement sur macOS ; sa
  voie Windows, actuellement non bloquante, ne s’exécute que sur lancement manuel avec `workflow_dispatch`. Des
  tests ciblés du trousseau système et, lorsque le paquet change, de l’installation npm globale couvrent néanmoins
  les trois systèmes. Cette dernière voie vérifie l’installation sans Bun préinstallé grâce au runtime fourni.
- **Version** (`.github/workflows/release.yml`) est un workflow manuel. Il ne remplace pas une seconde CI complète :
  avant une simulation ou une publication, il exige qu’une CI multiplateforme ait déjà réussi pour le commit
  exact de la version (`GITHUB_SHA`).
- **Expiration des demandes d’informations** (`.github/workflows/stale-needs-info.yml`) s’exécute chaque jour
  sur la branche par défaut. Une issue ouverte portant `needs-info` sans activité depuis 14 jours reçoit un
  avertissement, puis est fermée après 7 jours supplémentaires d’inactivité. Toute mise à jour efface
  l’avertissement. Pour conserver un travail de longue durée, retirez `needs-info`, par exemple lors du passage à `roadmap`.
- **Qualité des issues** (`.github/workflows/enforce-issue-quality.yml`) valide la structure du modèle des
  issues nouvelles ou modifiées, applique les labels de type (`bug`, `enhancement`, `provider-compatibility`,
  `documentation`) et ajoute des labels orthogonaux de **zone** à partir du champ Zone, complété par de légères
  heuristiques sur le titre et le résumé : `provider`, `account-pool`, `catalog`, `gui`, `cli`, `proxy`,
  `platform`, `streaming`, `tools`, `install` et `service`. Les labels de type et de processus restent séparés ;
  vous pouvez ainsi filtrer `bug` et `account-pool` sans confondre ces axes. Préférez le menu Zone à la création
  de labels par fournisseur. La zone Documentation n’ajoute pas un second label, car le formulaire fournit déjà
  `documentation`. Après promotion du workflow vers la branche par défaut, les responsables peuvent réappliquer
  les zones à toutes les issues ouvertes avec le workflow_dispatch `backfill_open_areas`.

Utilisez l'assistant pour les versions :

```bash
bun run release <version>           # commits/pushes the bump; publish workflow is dry-run by default
bun run release <version> --publish # publish after the CI-gated dry run is understood
bun run release:watch               # watch the newest Release workflow run
```

## Branches

- `dev` — l’unique branche d’intégration. Ciblez-la avec votre pull request.
- `main` — réservée aux versions. Elle avance par promotion de `dev`, sous le contrôle des responsables ;
  n’y ouvrez aucune pull request de fonctionnalité.
- `preview` — la branche des préversions.

La branche `dev2-go`, qui portait l’ancien runtime natif Go, a été retirée, tout comme la politique à deux
lignes d’exécution. Son historique est publié en lecture seule sur
[lidge-jun/opencodex-go-archive](https://github.com/lidge-jun/opencodex-go-archive).
Le TypeScript natif pour Bun sur `dev` est désormais l’unique ligne d’exécution.

Les pull requests de rebase sont les bienvenues. Rebaser une branche ancienne sur la tête actuelle constitue
une contribution normale ; indiquez les commits sources dans la description.

## Demandes d'extraction

- Ciblez **`dev`**. N’ouvrez aucune pull request de fonctionnalité ou de correctif contre **`main`**.
- Partez de la tête actuelle de **`dev`**, pas de **`main`**. Le contrôle obligatoire **`enforce-target`**
  rejette les branches dont la base de fusion se trouve sur la tête de **`main`** alors qu’elles sont très en
  retard sur la branche cible, le mode d’échec observé dans #644.
- Rédigez une vraie description : un **Résumé** de la modification et de sa raison, ainsi qu’un **Plan de test**
  ou un contenu équivalent. Les corps vides, les textes composés seulement d’espaces réservés et les descriptions
  contenant des `\n` échappés au lieu de véritables sauts de ligne échouent au contrôle.
- Si le titre ou la description mentionne `gui`, incluez dans la description une capture d’écran de la modification
  de l’interface. `enforce-target` est réexécuté après chaque modification de la description jusqu’à sa présence.
- Les workflows de ce dépôt utilisent **`pull_request_target`**. Une nouvelle logique d’application ne prend effet
  qu’après la promotion du workflow vers la branche par défaut, conformément à l’avertissement opérationnel de #631.

## Responsables du projet

Les responsables actuels, leurs attributions et les règles de revue et de fusion sont décrits dans
[`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md). La propriété GitHub
du dépôt et des chemins sensibles du point de vue de la sécurité est déclarée dans `.github/CODEOWNERS`.

## Conventions

- **Modules ES uniquement** (`import`/`export`), TypeScript, mode `strict`. Gardez `bun x tsc --noEmit` propre.
- **Environ 500 lignes au maximum par fichier** — répartissez le code par responsabilité. Les services auxiliaires `web-search/` et `vision/` sont
  bons exemples de petits modules ciblés derrière un seul `index.ts`).
- **Gérer les erreurs asynchrones aux frontières** — les services auxiliaires ne propagent jamais d’exception dans le
  chemin de requête ; ils se dégradent en un marqueur explicite.
- **Structure, source de vérité** — les invariants actuels des responsables résident dans `structure/`. Conservez
  les parcours utilisateurs publics dans `docs-site/` et les notes d’enquête historiques dans `docs/`.
- **Préserver les exportations** — d'autres modules peuvent en dépendre.

## Ajout d'un fournisseur au catalogue

Tous les sélecteurs de fournisseurs et les graines proviennent du registre canonique (`src/providers/registry.ts`) :

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
},
```

`src/providers/derive.ts` alimente cette entrée dans `ocx init`, `ocx provider`, les préréglages du tableau de bord,
les connexions par clé API et les configurations OAuth initiales. `enrichProviderFromCatalog()` copie les métadonnées
de modèle et les classifications de capacités dans la configuration enregistrée du fournisseur. Les implémentations
des protocoles OAuth résident toujours dans `src/oauth/` ; les seules métadonnées du registre ne créent pas un flux OAuth.

### Preuve requise pour un préréglage canonique

Une entrée du registre est une promesse entretenue : opencodex fournit la destination à laquelle sera envoyée
la clé API d’un utilisateur. Un préréglage exige donc des preuves de source primaire, pas seulement un chemin
de code fonctionnel. Toute pull request qui ajoute ou promeut un fournisseur doit fournir dans sa description :

- **Les points de terminaison compatibles avec OpenAI.** Liez la documentation primaire du fournisseur pour le
  point de terminaison de chat et, lorsque l’entrée définit `liveModels: true`, pour la découverte authentifiée
  des modèles, généralement `GET /v1/models`. La réussite d’un test avec une fixture ne remplace pas cette preuve :
  elle valide la forme de notre code, pas le contrat en amont.
- **Les conditions d’utilisation et l’entité juridique exploitante.** Une page juridique vide ou provisoire
  n’indique ni qui exploite le point de terminaison ni à quelles conditions le trafic est traité.
- **L’autorisation de revente ou de routage pour les agrégateurs.** Une passerelle qui revend l’accès à Claude,
  GPT, Gemini ou d’autres modèles tiers doit démontrer qu’elle est autorisée à les acheminer. Les utilisateurs
  interprètent un préréglage intégré comme une route entretenue, pas comme un revendeur non vérifié.
- **Un responsable de maintenance nommé.** Indiquez qui mettra à jour le préréglage si l’URL de base,
  l’authentification ou le contrat du catalogue change, et comment une rupture sera signalée.
- **Une date de vérification justifiable.** Enregistrez la source primaire et sa date de vérification, comme le
  fait `lastVerified` dans `src/providers/free-directory.ts`. Une date sur une ligne non vérifiée affirme une
  provenance que personne n’a établie.

Les contributeurs ajoutant leur propre service sont les bienvenus, et plusieurs préréglages actuels sont arrivés de cette façon.
Déclarez votre affiliation dans la description de la pull request afin que les évaluateurs puissent la prendre
en compte. Une affiliation n’est pas un motif de rejet et ne réduit pas non plus le niveau de preuve exigé.

Lorsque les preuves sont incomplètes, l’emplacement honnête est une entrée de référence dans
`src/providers/free-directory.ts`, et non le registre canonique. Les entrées du répertoire portent un niveau
`verification` explicite (`official`, `primary`, `unverified`) et restent inertes : les utilisateurs peuvent
toujours accéder au service par le flux personnalisé compatible avec OpenAI, sans qu’opencodex annonce un
préréglage qu’il ne peut garantir. Promouvez l’entrée dans le registre lorsque toutes les preuves ci-dessus existent.

## Ajout d'un adaptateur

Implémentez `ProviderAdapter` (voir [Adaptateurs](/fr/reference/adapters/)) dans `src/adapters/`,
enregistrez sa fabrique dans `src/adapters/registry.ts` et reliez sa sortie au flux interne `AdapterEvent`.
`src/server/adapter-resolve.ts` reste chargé de choisir le protocole effectif avant de déléguer au registre.
Réutilisez `image.ts` pour la gestion des images et suivez `openai-chat.ts` pour la diffusion et les appels
d’outils ; utilisez `fetchResponse` uniquement lorsque l’adaptateur gère ses propres nouvelles tentatives de transport, ou `runTurn`
pour un transport véritablement bidirectionnel tel que Cursor. Ajoutez des tests ciblés sous `tests/` et exportez
la fabrique depuis `src/index.ts` lorsqu’elle appartient à l’API publique du paquet.

## Vérifiez avant de déclarer que c'est fait

Exécutez la commande la plus étroite qui prouve votre changement — `bun run typecheck` pour les types, un
`bun test tests/<name>.test.ts` ou une sonde d'exécution pour le comportement, puis les portes plus larges appropriées à
la surface affectée. opencodex privilégie les petits commits vérifiables plutôt que les gros lots.
