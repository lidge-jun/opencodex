---
title: Configuration du routage
description: Sélection du fournisseur par défaut, ordre de résolution des modèles, alias de combinaisons, ordre des cibles et niveaux d’effort par défaut.
---

Le routage transforme l’identifiant de modèle envoyé par un client en un fournisseur concret et un modèle en amont.

## Champs de routage de premier niveau

| Champ | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- |
| `defaultProvider` | `string` | `"openai"` | Fournisseur utilisé en dernier recours lorsqu’aucune règle de modèle précédente ne correspond. Il doit désigner un fournisseur configuré et activé. |
| `combos?` | `Record<string, OcxComboConfig>` | `{}` | Modèles virtuels `combo/<id>` construits à partir d’une liste ordonnée de cibles fournisseur/modèle. |
| `routingProfiles?` | `Record<string, OcxRoutingProfileConfig>` | `{}` | Modèles virtuels `policy/<id>` qui choisissent parmi une liste d’autorisation explicite de candidats selon des exigences strictes de capacité et une notation déterministe. |

## Ordre de résolution des modèles

opencodex résout le modèle demandé dans l’ordre suivant :

1. Un `policy/<id>` configuré ou l’alias d’un profil de routage : l’évaluateur de politique est exécuté et le candidat retenu est routé. Si `policy/<id>` n’est pas résolu, les règles suivantes sont examinées.
2. Un espace de noms `<account-selector>/<native-openai-model>` configuré : la requête utilise exactement le compte Codex enregistré qui lui est associé. Une cible exacte invalide ou indisponible échoue de manière sûre.
3. Un `combo/<id>` canonique ou l’alias d’une combinaison configurée. Les identifiants canoniques sont examinés avant les alias.
4. Un espace de noms explicite `<provider>/<model>` dont le préfixe désigne un fournisseur configuré.
5. Un identifiant natif non qualifié de la famille OpenAI, tel que `gpt-*`, `o1-*`, `o3-*` ou `o4-*`, routé par le fournisseur canonique `openai` activé.
6. Une correspondance exacte avec le `defaultModel` d’un fournisseur.
7. Un préfixe de modèle appartenant à une famille de fournisseurs connue.
8. Un modèle exact figurant dans la liste `models` configurée d’un fournisseur.
9. `defaultProvider`, en conservant l’identifiant de modèle demandé.

Les fournisseurs désactivés sont exclus. Un espace de noms explicite qui désigne un fournisseur désactivé échoue au lieu de passer aux règles suivantes. Pour les règles susceptibles de correspondre à plusieurs fournisseurs, les entrées sont examinées dans leur ordre d’insertion JSON. Utilisez donc un espace de noms explicite lorsqu’un modèle non qualifié peut être ambigu.

### Redirections des modèles bloqués

`blockedModelRedirects` est un `Record<string, string>` facultatif de premier niveau associant des remplacements exacts d’identifiants de modèle résolus ; il est non défini par défaut. Il s’applique après l’ordre de résolution ci-dessus : une correspondance conserve la route du fournisseur et du compte déjà sélectionnée, ne remplace que l’identifiant du modèle en amont et enregistre le motif de routage `blocked-model-redirect`. L’omission de la clé ne modifie pas le routage.

```json
{
  "blockedModelRedirects": { "gpt-5.6-terra": "gpt-5.6-luna" }
}
```

## Sélecteurs exacts de comptes Codex

`codexAccountNamespaces` associe un sélecteur public, par exemple `side`, à un compte Codex enregistré. Une requête pour `side/gpt-5.6-sol` utilise uniquement ce compte, même lorsque le fournisseur canonique `openai` fonctionne en mode Direct, et envoie en amont l’identifiant non qualifié `gpt-5.6-sol`. Seuls les identifiants natifs non qualifiés de la famille OpenAI sont valides après le sélecteur.

Les identifiants propres à un compte observés dans le catalogue actuel de Codex peuvent également être conservés tels quels lorsqu’ils ne figurent pas encore dans l’ensemble statique d’opencodex. L’observation doit avoir la structure de champs d’une véritable ligne de catalogue, rester qualifiée par le sélecteur du compte correspondant et ne jamais être promue dans la liste globale des modèles non qualifiés. Ce contrôle de structure élimine les lignes mal formées ou minimales ; il ne constitue pas un contrôle de confiance, car le cache des modèles appartient à l’utilisateur et une ligne complète écrite à la main est impossible à distinguer d’une observation en amont. Il ne rend aucun nouveau modèle routable : sous un sélecteur de compte, le routeur accepte déjà un identifiant `gpt-*` non qualifié indépendamment du catalogue.

La sélection exacte contourne la stratégie d’attribution du pool et l’affinité ordinaire des fils. Si le compte associé est absent, suspendu, en période de temporisation, inutilisable ou doit être réauthentifié, la requête échoue de manière sûre au lieu de changer de compte ; elle ne modifie pas non plus le compte actif du pool. Lorsqu’au moins un sélecteur admissible est configuré, les catalogues Codex masquent les lignes natives non qualifiées du sélecteur et affichent une ligne `<selector>/<native-openai-model>` distincte pour chaque sélecteur. Les identifiants natifs non qualifiés conservent le routage Pool/Direct habituel et restent présents dans la découverte brute `/v1/models`, sauf désactivation explicite. Les sélecteurs dont le compte enregistré associé est absent ne sont pas annoncés. La validation des sélecteurs, les règles de collision et les recommandations de confidentialité sont décrites dans [Configuration des fournisseurs](/fr/reference/configuration/providers/).

La page Codex Auth propose ce comportement du sélecteur sous forme d’option. Sa désactivation masque les lignes générées qualifiées par un sélecteur et rétablit les lignes GPT ordinaires, sans supprimer les associations ni modifier le routage exact `<selector>/<model>`. Sa réactivation rétablit donc les mêmes libellés publics. Les modifications de comptes et de paramètres sont conservées avant une actualisation bornée du catalogue. Un avertissement de `ocx sync` signifie uniquement que le catalogue du sélecteur n’a pas encore convergé, et non que la modification du routage a été perdue.

## Combinaisons (`config.combos`)

Chaque clé de combinaison est un identifiant conforme à `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Elle est toujours directement accessible sous `combo/<id>` et peut également définir un `alias`. Les alias doivent être uniques, ne peuvent pas occuper l’espace de noms `combo/` et ne peuvent pas utiliser les familles natives non qualifiées réservées, telles que `gpt-*`, `o1-*`, `o3-*`, `o4-*` ou `codex-*`, sauf si `nativeAlias: true` active explicitement le contrat de compatibilité Desktop.

| Clé | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` | requis | Routes concrètes ordonnées. `weight` est compris entre 1 et 10000 et vaut `1` par défaut. |
| `strategy?` | `"failover" \| "round-robin" \| "random" \| "least-used" \| "reset-window"` | `"failover"` | Stratégie de sélection. L’ordre des cibles définit la priorité de `failover` ; les poids déterminent les sélections de `round-robin` et de `random` ; `least-used` suit les réussites enregistrées ; `reset-window` suit la réinitialisation de quota la plus proche. |
| `stickyLimit?` | `number` | `1` | Nombre de requêtes réussies conservées dans un même lot de rotation. Plage de 1 à 100. |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | non défini | Appliqué uniquement lorsque l’appelant ne précise aucun effort et que la cible sélectionnée annonce le niveau demandé. |
| `imageInput?` | `"auto" \| "disabled"` | `"auto"` | `"auto"` publie les images uniquement lorsque toutes les cibles les prennent en charge ; `"disabled"` impose le texte seul, retire les images des modalités publiées et rejette les requêtes qui en contiennent avant leur distribution. |
| `alias?` | `string` | — | Identifiant public facultatif du modèle, à la place du slug canonique du sélecteur. |
| `nativeAlias?` | `boolean` | `false` | Permet à un identifiant natif non qualifié actuellement pris en charge de prendre la priorité uniquement pour cet identifiant. Les identifiants non qualifiés `gpt-5.6-*` utilisent les identifiants Codex Pool/Direct. Les routes qualifiées par un compte restent distinctes. Les routes qualifiées par un fournisseur, telles que `openai-apikey/gpt-5.6-*`, utilisent la route configurée avec sa clé d’API et ne passent jamais par l’alias natif. |
| `displayName?` | `string` | — | Libellé d’affichage du catalogue, obligatoire et non vide pour un alias natif. |

```json
{
  "defaultProvider": "openai",
  "combos": {
    "coding": {
      "targets": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openrouter", "model": "qwen/qwen3-coder-plus" }
      ],
      "strategy": "failover",
      "defaultEffort": "high",
      "alias": "coding-primary"
    }
  }
}
```

Pour le comportement des stratégies, les échecs pouvant être relancés, les périodes de temporisation, les limites applicables aux tâches v2 chiffrées et les commandes de gestion, consultez [Combinaisons](/fr/guides/combos/).

## Profils de politique de routage (`config.routingProfiles`)

Les profils de politique de routage constituent la couche de sélection Router Intelligence. `policy/<id>`, ou son alias configuré, choisit parmi une liste d’autorisation fixe de candidats selon des exigences strictes de capacité et une notation déterministe et explicable. Une requête explicite `policy/<id>` exécute l’évaluateur, puis route le candidat retenu. Les identifiants de modèles existants ne sont **jamais** routés implicitement par un profil : l’espace de noms `policy/` et les alias de profils sont les seuls points d’entrée, et tous deux sont validés par rapport à l’ordre de résolution ci-dessus.

Chaque clé est un identifiant conforme à `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, toujours accessible sous `policy/<id>`, avec un `alias` facultatif. Les alias doivent être uniques et ne peuvent entrer en collision avec les fournisseurs configurés, l’espace de noms de routage `<provider>/<model>`, les combinaisons, les espaces de noms des comptes Codex, l’espace de noms `policy/` ou les familles natives non qualifiées réservées (`gpt-*`, `o1-*`, `o3-*`, `o4-*`, `codex-*`).

| Clé | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- |
| `candidates` | `{ provider: string; model: string }[]` | requis | Liste d’autorisation explicite de références `provider/model`. Aucune extension implicite. |
| `alias?` | `string` | — | Identifiant public facultatif du modèle, à la place de `policy/<id>`. |
| `require?` | objet | `{}` | Exigences strictes de capacité évaluées avant la notation ; voir ci-dessous. |
| `optimize?` | objet | latence 0.55, santé 0.25, coût 0.10, quota 0.10 | Poids de notation normalisés de manière déterministe. `health`, `quota` et `cost` disposent de dimensions de score. La part réservée à la priorité configurée vaut `1 - health - quota - cost`, soit 0.55 par défaut ; `latency` est intégrée à cette part de priorité au lieu d’être notée séparément. |
| `limits?` | objet | — | Limites strictes. `maxEstimatedCostUsd` exclut un candidat lorsque son coût estimé est connu et dépasse le plafond. Lorsque ce plafond est défini, `onUnknownCost` (`"allow"` par défaut ou `"exclude"`) régit les estimations inconnues : l’autorisation évite une exclusion propre au plafond et enregistre `cost.capOutcome: "unknown-allowed"` ; l’exclusion émet `cost-limit-unknown` et `capOutcome: "unknown-excluded"`. Utilisé seul, sans plafond, `onUnknownCost` est sans effet. Ce réglage est distinct de `unknownEvidence.cost`, qui peut encore exclure ou pénaliser un prix inconnu avec `unknown-price` ou la notation. |
| `unknownEvidence?` | objet | capacité `exclude`, health/quota/cost `penalize` | Traitement des preuves inconnues dans chaque dimension : `allow`, `penalize` ou `exclude`. Une valeur inconnue ne devient jamais zéro. |

`require` accepte `minContextWindow` (entier positif), `minQuotaHeadroom` (fraction de 0 à 1), les booléens `tools`, `imageInput`, `structuredOutput`, `localOnly`, `remoteAllowed` et `encryptedCodexTasks`, ainsi que les chaînes `reasoningEffort` et `serviceTier`.

Pour `unknownEvidence.capability`, `penalize` se comporte actuellement comme `allow`. Tant qu’aucune dimension de score de capacité n’est disponible — prévue avec RI-06+ — la notation ne comporte qu’une composante de priorité configurée ; `penalize` ne peut donc pas encore modifier le candidat sélectionné.

Les preuves de la requête sont évaluées avec les capacités des candidats et le bloc `require` du profil ; un candidat doit satisfaire les deux pour être admissible. Sur le chemin d’une requête réelle, le proxy déduit du corps de la requête les preuves relatives aux outils et aux images en entrée. La taille de la fenêtre de contexte et les autres dimensions restent inconnues au moment du routage. Utilisez l’API ou la CLI de simulation pour examiner toutes les preuves des profils sensibles au contexte.

La simulation de la CLI accepte des indicateurs de preuve propres à la requête, mais ne permet pas encore de fournir les capacités des candidats. Ces preuves sont transmises par l’API (`POST /api/routing-profiles/dry-run`).

```json
{
  "routingProfiles": {
    "fast": {
      "alias": "ocx/fast",
      "candidates": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openai", "model": "gpt-5.6-sol" }
      ],
      "require": { "tools": true, "minContextWindow": 128000 },
      "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.10, "quota": 0.10 },
      "limits": { "maxEstimatedCostUsd": 0.50, "onUnknownCost": "allow" },
      "unknownEvidence": {
        "capability": "exclude",
        "health": "penalize",
        "quota": "penalize",
        "cost": "penalize"
      }
    }
  }
}
```

CLI : `ocx route policy list [--json]`, `ocx route policy show <id> [--json]` et `ocx route policy dry-run <id> [--model-context <tokens>] [--tools] [--image] [--structured-output] [--json]`. La simulation évalue les candidats sans envoyer de requête en amont.

Les preuves de quota (`optimize.quota`, `require.minQuotaHeadroom`, `unknownEvidence.quota`) proviennent des caches de quota Codex et Anthropic indexés par compte. Un candidat à l’exécution ne reçoit un quota mis en cache que si les preuves identifient déjà le compte. Les candidats canoniques `openai` et Anthropic qui ne sont liés à aucun compte restent inconnus pendant l’évaluation de la politique, car la sélection du pool, l’identité de l’appelant Direct, la rotation du fournisseur et l’affinité du fil sont résolues après le choix d’un fournisseur/modèle par la politique. Le compte actif du processus n’est pas utilisé comme substitut.

Les preuves de quota ne modifient jamais la sélection du compte, l’affinité de session, les périodes de temporisation ou le comportement de basculement ; elles alimentent uniquement la notation de la politique. Pour observer un comportement tenant compte du quota dans une simulation d’API, fournissez des références de compte dans les preuves des candidats envoyées à `POST /api/routing-profiles/dry-run` : `candidates[].codexAccountId` pour le pool Codex du fournisseur `openai`, ou `candidates[].accountRef` pour Anthropic, permet de dériver le quota du compte correspondant dans le cache. Un objet `candidates[].quota` explicite est renvoyé tel quel. La simulation de la CLI ne permet pas de fournir ces champs propres aux candidats.

### Combinaisons et profils de politique

- Une **combinaison** applique un routage explicite des cibles avec une stratégie configurable (`failover` ordonné, répartition pondérée avec `round-robin`, répartition aléatoire avec `random`, `least-used` ou `reset-window`) : la stratégie configurée détermine la cible, et les échecs pouvant être relancés font avancer dans la liste.
- Un **profil de politique** sélectionne un candidat configuré selon les preuves disponibles : les exigences strictes de capacité filtrent d’abord les candidats, puis une notation déterministe classe ceux qui restent.

Les deux mécanismes sont des espaces de noms virtuels, avec des alias et une validation des collisions ; ils diffèrent par la méthode de sélection. La notation d’un profil combine la composante de priorité configurée avec les dimensions de santé (RI-06), de quota (RI-07) et de coût (RI-08) lorsque les preuves existent. Le poids `latency` est intégré à la part de priorité plutôt que noté séparément.

Le coût est également imposé par le plafond `limits.maxEstimatedCostUsd` : un candidat dont le coût estimé est connu et dépasse le plafond est exclu (`cost-limit`). Lorsqu’un plafond est configuré mais que l’estimation est inconnue, la valeur par défaut `limits.onUnknownCost: "allow"` enregistre `cost.capOutcome: "unknown-allowed"` dans la trace de décision sans exclure le candidat au titre du plafond. Définissez `onUnknownCost: "exclude"` pour un plafond fermé en cas d’incertitude (`cost-limit-unknown`). Le résultat du plafond ne détermine pas à lui seul l’admissibilité globale : `unknownEvidence.cost: "exclude"` peut encore ajouter `unknown-price` et rendre le candidat inadmissible. Une trace de décision est enregistrée pour chaque requête qui exécute un profil de politique.

### Admissibilité au catalogue

Une combinaison reste directement routable même si elle ne peut pas figurer dans le catalogue. `ocx sync`, `/v1/models` et le sélecteur Codex ne l’affichent que si toutes les cibles exposent des capacités dont l’intersection peut être calculée :

- une valeur positive de `contextWindow` provenant des métadonnées en direct, des indications du registre, de `modelContextWindows` / `contextWindow` du fournisseur, d’une valeur positive connue de `maxInputTokens` dans la ligne du membre, ou — lorsque le fournisseur est connu et activé mais qu’aucune source ne fournit de fenêtre — d’une valeur prudente de 128 000 jetons, limitée par `providerContextCaps` lorsque ce réglage est défini ;
- une intersection non vide de `inputModalities`, une valeur absente chez un membre étant interprétée comme `["text"]`.

Une cible appartenant à un fournisseur désactivé — même si sa ligne de découverte est complète —, une cible d’un fournisseur inconnu sans ligne de découverte ou des cibles aux modalités disjointes retirent la combinaison du catalogue. La synchronisation émet un avertissement récapitulatif et le tableau de bord indique **Needs attention**. Ajoutez des métadonnées de contexte, alignez les modalités ou choisissez des modèles dont les capacités compatibles peuvent être découvertes.

## Historique des requêtes et analyse du routage

- `GET /api/request-history` — historique complet paginé par curseur, issu de l’index dérivé (`routing-history.sqlite`), avec les filtres `provider`, `model`, `requestedModel`, `status`, `conversationId`, `surface`, `inboundProtocol`, `apiKeyId`, `profileId`, `fallback`, `from` et `to`, ainsi qu’une pagination par `cursor` opaque. `GET /api/request-history/:requestId` renvoie une ligne canonique.
- `GET /api/request-history/:requestId/route-decision` — explication du choix de la route : trace des candidats, exclusions, composantes du score, profil et révision, séquence des tentatives d’exécution et résultat final.
- `GET /api/routing-analytics` — taux de réussite, d’échec, d’annulation et de repli, durées p50/p95/p99 et TTFT, taux de flux incomplets, échecs qui déclenchent une temporisation, coût par requête réussie, couverture, confiance et indicateur explicite de troncature.
- `GET /api/routing-profiles`, `POST /api/routing-profiles/dry-run` — examen des profils et simulation sans envoi en amont.

L’historique et les charges utiles de décision renvoyés n’exposent que des métadonnées de requête masquées, par exemple des libellés opaques `apiKeyId`. Ils ne contiennent ni identifiants, ni corps de prompts bruts, ni secrets de fournisseurs.

CLI : `ocx logs explain <request-id>`, `ocx logs rebuild-index`, `ocx logs index-status`, `ocx route policy list | show | dry-run | evaluate`.

## Migration

`routingProfiles` est facultatif et uniquement additif : les fichiers de configuration existants continuent de se charger sans modification. Les anciennes lignes de `usage.jsonl` dépourvues de `routeDecision` continuent d’être analysées sans modification. L’index d’historique peut être supprimé : la suppression de `routing-history.sqlite` déclenche sa reconstruction automatique à partir de `usage.jsonl` lors de la requête suivante ; `ocx logs
rebuild-index` force cette reconstruction. Ce système n’ajuste automatiquement ni les poids, ni les budgets, ni les ensembles de candidats.
