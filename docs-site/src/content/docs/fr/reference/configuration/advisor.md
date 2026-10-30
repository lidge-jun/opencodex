---
title: Conseiller
description: Consultation indépendante avec les politiques manual, preflight et adaptive fondée sur des preuves.
---

Le conseiller est un modèle expert indépendant qui examine la tâche du worker et renvoie des
conseils. La consultation appartient à OpenCodex de bout en bout : le proxy injecte un outil
synthétique `advisor` dans le tour du worker, exécute lui-même la consultation via l'autorité de
routage normale, et réinjecte les conseils pour que le worker d'origine continue. Le worker n'a
rien à déléguer, ne spawn rien et ne porte aucun identifiant de fournisseur.

Cela se distingue de la surface des sous-agents (voir
[Configuration des agents](/fr/reference/configuration/agents/)) : les sous-agents sont une
délégation initiée par le worker via les outils de collaboration de Codex. Le conseiller est un
sidecar côté proxy invisible du client — même un worker qui ne spawn jamais peut être conseillé.

## Configuration

Sur la page **Advisor**, choisissez le modèle dans le catalogue. Le sélecteur conserve exactement les identifiants natifs, de fournisseur, de compte, personnalisés et de combo. Les modèles désactivés ou en attente de sélection initiale ne sont pas proposés. Un identifiant enregistré absent du catalogue reste visible avec un avertissement, jusqu’à son remplacement ou sa suppression. Un échec de chargement conserve la sélection et propose de réessayer. Choisissez un modèle capable de fournir des conseils textuels : le catalogue ne garantit pas la compatibilité des consultations. La CLI et l’API acceptent toujours les chaînes de modèle prises en charge par le routeur.

```json
{
  "advisor": {
    "enabled": true,
    "model": "gpt-6-astra",
    "effort": "max",
    "policy": "preflight",
    "contextSharingConsent": "v1"
  }
}
```

| Champ | Type | Défaut | Signification |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Interrupteur principal. Désactivé : aucun comportement conseiller sur le chemin de requête. |
| `model?` | `string` | — | Le modèle expert. Toute chaîne de modèle acceptée par le routeur : modèle natif seul (`gpt-6-astra`), `provider/model` explicite (`anthropic/claude-sonnet-4-6`, `xai/grok-...`) ou modèle natif qualifié par compte. Inter-fournisseurs entièrement pris en charge. |
| `effort?` | `string` | `"max"` | Intensité de raisonnement de l'appel conseiller (`low`–`ultra`). |
| `policy?` | `"manual" \| "preflight" \| "adaptive"` | `"manual"` | Quand consulter le conseiller. |
| `maxConsultationsPerTask?` | `integer` | `3` | Budget adaptatif par tâche (1 à 3 tentatives, appels manuels compris). |
| `timeoutMs?` | `number` | `120000` | Délai de la consultation en boucle locale. |
| `contextSharingConsent?` | `"v1"` | absent | Consentement de l'opérateur pour envoyer le contexte de la tâche au fournisseur conseiller configuré. Seul `"v1"` est courant. Une valeur absente, périmée ou autre n'autorise aucun envoi. `enabled: true` n'est pas ce consentement. |

Gérez-le via la page **Advisor** du tableau de bord ou
`ocx advisor status|on|off|set --model <model> --effort <effort> --policy <manual|preflight|adaptive>`.

Sans consentement courant, `ocx advisor on` n'active pas le partage inter-fournisseurs : il affiche cette divulgation et s'arrête. `ocx advisor on --ack-context-sharing` et `ocx advisor consent` enregistrent `v1`. `ocx advisor consent --revoke` retire le consentement et arrête immédiatement l'envoi. `ocx advisor set` n'accorde pas le consentement. La case du tableau de bord n'est pas précochée.

## Politiques

- **`manual`** — consultation uniquement sur un appel explicite de l'outil synthétique `advisor`
  par le worker. L'appel est intercepté par le proxy, jamais montré au client, et jamais exécuté
  comme un outil local.
- **`preflight`** — OpenCodex tente en plus une consultation par tâche automatiquement. Quand le
  worker a produit sa première preuve d'orientation (un appel d'outil de l'assistant OU un
  résultat d'outil après le dernier message utilisateur), le proxy consulte l'expert et injecte
  les conseils avant le prochain tour du worker — même si le worker n'appelle jamais l'outil. Le
  déclencheur est une approximation déterministe et documentée, pas un détecteur sémantique de
  « modèle bloqué ». Une consultation tentée qui ÉCHOUE n'est pas traitée silencieusement comme
  un conseil : la tâche réessaie après l'expiration de l'entrée d'échec du registre, afin qu'une
  panne temporaire du conseiller ne rende pas la politique muette pour toujours.

## Consentement

Le contexte de la tâche n'est pas envoyé tant que l'opérateur n'a pas enregistré le consentement de partage `v1`. Le consentement est versionné : un élargissement ultérieur de la divulgation pourra exiger `v2` au lieu de réutiliser cet accord. Le runtime l'applique. Une valeur absente ou périmée rend le conseiller non exécutable (`advisor_context_sharing_consent_required`) sans faire échouer la requête de codage. Ni le worker, ni le modèle conseiller, ni une chaîne dans la tâche ne peuvent accorder le consentement.

## Ce que voit le conseiller

Une consultation peut envoyer :

- la dernière demande de l'utilisateur
- le texte utilisateur, assistant et développeur visible dans la conversation analysée
- les appels d'outils et leurs arguments
- les résultats d'outils
- le catalogue d'outils du worker et leurs descriptions
- l'identité du worker et le modèle conseiller configuré
- une question de focus facultative lorsque le worker appelle `advisor()`

Le fournisseur conseiller configuré peut différer de celui du worker.

Les consultations respectent à la fois la portée de modèles capturée de la clé d'API de l'appelant, son consentement aux combos payants et ses limites de repli par appareil, et les limites d'hôte de la propre clé d'admission d'Advisor : `OPENCODEX_API_AUTH_TOKEN` ou le fichier de jeton du service s'il est défini et accepté par ce proxy, sinon la première clé d'API configurée. L'ordre des clés ne compte que dans ce dernier cas : placez en premier une clé qui peut atteindre le modèle Advisor, sinon chaque consultation est indisponible. Lorsqu'un jeton d'environnement ou de service est défini, c'est lui qui contrôle la consultation. Ces règles s'appliquent aussi aux choix de combo, aux modèles de décision imbriqués et aux nouvelles tentatives. Une consultation qui ne peut pas les satisfaire renvoie au worker un avis d'indisponibilité.

Par exemple, une clé `laptop` avec `allowMeteredComboTargets: false` ne peut pas dépenser sur des cibles de combo facturées via Advisor, et `fallback.devices.laptop.provider: false` bloque aussi les sauts de repli de fournisseur d'Advisor. Un appelant loopback sans clé a toujours besoin de l'option `allowMeteredTargets: true` du combo. Lorsque les deux clés définissent `allowMeteredComboTargets: true` et que le combo définit `allowMeteredTargets: true`, Advisor peut utiliser ses cibles facturées, y compris via l'écouteur loopback d'une liaison publique. Le serveur capture la politique de l'appelant lorsqu'il authentifie la requête, avant d'attendre de la capacité pour le corps ou de le lire ; des modifications ultérieures des clés ou du repli ne peuvent pas élargir cette consultation. Cela couvre aussi les assistants de vision routés, les requêtes compact et leurs modèles de décision, ainsi que chaque nouvelle tentative de candidat dans un tour WebSocket. Chaque nouveau tour WebSocket capture sa propre politique.

OpenCodex n'insère pas dans ce prompt de clés d'API de fournisseur, d'en-têtes Authorization, de jetons OAuth, de secrets de configuration réservés au backend, d'environnement de processus, ni de chaîne de pensée cachée. Il ne déchiffre pas et ne transmet pas un raisonnement privé chiffré du fournisseur. **Le contenu de la tâche n'est pas expurgé de secrets.** Une clé collée dans la tâche, un secret dans un fichier lu par les outils, ou un jeton imprimé par un outil ou un journal peut être envoyé. OpenCodex n'exécute pas de DLP général.

## Autorité

Le conseil manuel est le résultat d'outil de l'appel `advisor` que le worker a lui-même émis. Ce résultat est un objet JSON. Le champ `advice` est le texte du modèle conseiller. Le champ `status` est écrit par le runtime.

Le conseil automatique est un objet JSON cité dans un message consultatif de rôle user distinct. Seule l’instruction fixe du runtime reste dans le message developer ; le texte généré par le conseiller ne passe jamais dans developer/system. Cela fonctionne avec OpenAI Chat et Anthropic sans inventer un appel d’outil. Les guillemets empêchent la rupture structurelle et les champs falsifiés, pas toute injection en langage naturel. Un protocole dédié pourrait mieux distinguer le conseil d’une demande utilisateur. Chaque requête permet au plus trois consultations et quatre continuations du worker. À la limite, l’outil advisor est retiré ; un nouvel appel reçoit une dernière continuation avec un résultat de limite, puis un autre appel termine avec 502 advisor_continuation_limit sans nouvel envoi. La limite est partagée avec les reprises de complétion vide.

La suppression ne lit pas les chaînes du conseiller. Le dédoublonnage automatique appartient au registre du serveur. Un message developer, même s'il recopie le texte de transport, ne supprime pas le preflight.

## Coût et comptabilité

Chaque consultation est un véritable appel de modèle supplémentaire. Elle apparaît dans
l'utilisation sous le **modèle conseiller** — jamais fusionnée avec les tokens du worker — et
chaque consultation écrit une ligne de journal `[advisor]` avec déclencheur, durée, statut et
utilisation : un appel conseiller est toujours prouvable depuis les journaux.

## Comportement en cas d'échec

Le conseiller échoue ouvertement : une consultation déjà envoyée qui échoue (modèle indisponible, configuration erronée, délai
dépassé) donne au worker un court avis « conseiller indisponible », non trompeur (un message
`<opencodex_advisor_unavailable>` pour preflight, un résultat d'outil en erreur pour manual), et
la tâche continue ; rien n'est injecté uniquement quand la consultation est annulée, et un plan
qui ne démarre aucune consultation (désactivé, sans modèle, ou activé sans consentement de partage courant) n'envoie aucun avis preflight. Un appel manuel `advisor()` sans consentement courant renvoie un résultat d'outil consent-required et n'envoie rien. Un échec de consultation ne fait jamais échouer la requête de
codage, et une consultation ne change jamais le modèle principal de la session.

## Limitations PR1

- Les tours natifs OpenAI en passthrough (workers du pool ChatGPT) ne reçoivent pas l'outil
  synthétique ; le conseiller couvre les fournisseurs routés (traduits). La consultation
  preflight s'applique aux adaptateurs run-turn ; l'outil non.
- Pas de détection sémantique de blocage, de revue finale, de niveaux d’escalade, de conseillers multiples ou de vote.
- Le registre de déduplication preflight vit dans le processus ; après un redémarrage du proxy,
  une tâche en cours peut recevoir une tentative preflight de plus.

## Consultation adaptative et activité

`adaptive` ajoute à la consultation initiale une consultation lorsque la même vérification, dans le même répertoire, échoue, qu’une modification de fichier ultérieure réussit, puis qu’une nouvelle exécution échoue encore. Une réussite efface l’échec ; une vérification démarrée avant la modification ne compte pas comme une nouvelle tentative après réparation. Les étapes initiale et réparation ont des revendications distinctes. Une identité de conversation stable est requise pour l’automatisation. Les appels/résultats doivent être appariés avec un code de sortie explicite. Scripts complexes, lots, modifications shell et sorties ambiguës ne déclenchent rien.

Configurez `ocx advisor set --policy adaptive --max-consultations 2`. Les tentatives manuelles et automatiques partagent un budget de 1 à 3 par tâche, réservé avant envoi dans `OPENCODEX_HOME/advisor-budget.sqlite`. Un redémarrage ou un changement de worker ne le remet pas à zéro. Seuls les condensats, compteurs et expirations sont conservés, pendant 24 heures après la première tentative (512 tâches au maximum). Si le budget est inaccessible ou épuisé, le worker continue. Les appels envoyés puis échoués ou annulés restent réservés car ils peuvent coûter. Sans identité stable, seuls les appels manuels limités par requête restent disponibles.

La page Advisor et `ocx advisor activity --json` (`GET /api/advisor/activity`) montrent jusqu’à 100 entrées de métadonnées du processus sur 24 heures ; la page visible s’actualise toutes les cinq secondes. Elles incluent motif, état, modèles, durée, tokens d’entrée/sortie signalés et efforts demandé et traduit par l’adaptateur. Aucun texte, commande, conseil ou identifiant de conversation n’est conservé ; un redémarrage efface ces entrées. La traduction décrit les paramètres envoyés et ne garantit pas le raisonnement interne. Les données absentes restent inconnues ; adoption et coût exact ne sont pas déduits.
