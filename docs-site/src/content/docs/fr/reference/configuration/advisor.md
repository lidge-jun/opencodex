---
title: Conseiller
description: Le sidecar de consultation experte d'OpenCodex — un modèle expert configuré conseille les workers routés, avec les politiques manual et preflight.
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
| `policy?` | `"manual" \| "preflight"` | `"manual"` | Quand consulter le conseiller. |
| `timeoutMs?` | `number` | `120000` | Délai de la consultation en boucle locale. |
| `contextSharingConsent?` | `"v1"` | absent | Consentement de l'opérateur pour envoyer le contexte de la tâche au fournisseur conseiller configuré. Seul `"v1"` est courant. Une valeur absente, périmée ou autre n'autorise aucun envoi. `enabled: true` n'est pas ce consentement. |

Gérez-le via la page **Advisor** du tableau de bord ou
`ocx advisor status|on|off|set --model <model> --effort <effort> --policy <manual|preflight>`.

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

OpenCodex n'insère pas dans ce prompt de clés d'API de fournisseur, d'en-têtes Authorization, de jetons OAuth, de secrets de configuration réservés au backend, d'environnement de processus, ni de chaîne de pensée cachée. Il ne déchiffre pas et ne transmet pas un raisonnement privé chiffré du fournisseur. **Le contenu de la tâche n'est pas expurgé de secrets.** Une clé collée dans la tâche, un secret dans un fichier lu par les outils, ou un jeton imprimé par un outil ou un journal peut être envoyé. OpenCodex n'exécute pas de DLP général.

## Autorité

Le conseil manuel est le résultat d'outil de l'appel `advisor` que le worker a lui-même émis. Ce résultat est un objet JSON. Le champ `advice` est le texte du modèle conseiller. Le champ `status` est écrit par le runtime.

Le conseil automatique reste un message `developer`, parce que les continuations neutres vis-à-vis du fournisseur n'ont pas de résultat de consultation à faible confiance non apparié. Fabriquer un appel d'outil que le worker n'a pas émis casserait la légalité des messages Anthropic et l'appariement de continuation. L'instruction fixe de ce message est la politique de transport possédée par le runtime. L'objet JSON qui suit est une donnée de conseil non fiable, entre guillemets. Les guillemets empêchent le texte du conseiller de fermer l'enveloppe ou de réécrire la provenance. Cela ne fait pas du transport au rôle developer une isolation parfaite. Un protocole dédié de résultat de consultation serait une frontière plus forte.

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
- Pas de déclencheur adaptatif : pas de détection de blocage, d'analyse d'échecs répétés, de
  niveaux d'escalade, de conseillers multiples ni de vote. `manual` et `preflight` seulement.
- Le registre de déduplication preflight vit dans le processus ; après un redémarrage du proxy,
  une tâche en cours peut recevoir une tentative preflight de plus.
