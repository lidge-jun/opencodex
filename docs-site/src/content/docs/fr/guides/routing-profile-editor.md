---
title: Éditeur de profils de routage
description: Créez, modifiez, validez, simulez et supprimez des profils de stratégie de routage depuis le tableau de bord OpenCodex.
---

L’onglet **Modèles → Routage** du tableau de bord OpenCodex permet de gérer `config.routingProfiles` sans modifier `config.json` manuellement.

## Créer un profil

1. Ouvrez **Routage** dans le tableau de bord.
2. Sélectionnez **Créer un profil**.
3. Saisissez un `id`. L’identifiant de modèle canonique est `policy/<id>`.
4. Ajoutez un ou plusieurs candidats fournisseur/modèle explicites.
5. Configurez, si nécessaire, les exigences, les pondérations de notation, les plafonds de coût (`maxEstimatedCostUsd` et, facultativement, `onUnknownCost`) ainsi que le traitement des preuves inconnues.
6. Enregistrez le profil.

Les identifiants de profil sont immuables après leur création. Pour utiliser un autre identifiant, créez un nouveau profil, mettez à jour les appelants, puis supprimez l’ancien profil.

## Validation et persistance

Le tableau de bord envoie à l’API de gestion le même objet de profil que celui utilisé par `config.routingProfiles`. Le serveur valide l’intégralité du profil proposé avant de l’enregistrer :

- les identifiants et les alias doivent respecter les règles de nommage et de collision des profils de routage ;
- chaque fournisseur candidat doit exister et être activé ;
- les candidats en double sont rejetés ;
- les limites et exigences numériques doivent rester dans les plages prises en charge ;
- au moins une pondération d’optimisation doit être positive.

Une sauvegarde réussie enregistre le profil au moyen du mécanisme habituel d’écriture de la configuration, réconcilie l’état actif et actualise le catalogue de modèles. En cas d’échec de validation, la configuration précédente reste inchangée et l’erreur s’affiche dans l’éditeur.

Lorsque `limits.maxEstimatedCostUsd` est configuré, `limits.onUnknownCost` vaut `"allow"` par défaut : une estimation de coût inconnue n’entraîne aucune exclusion propre au plafond, et les traces de décision de routage, en simulation comme en production, portent
`cost.capOutcome: "unknown-allowed"` afin d’indiquer aux opérateurs que le respect du plafond n’a pas été démontré. Définissez `"exclude"`
si le plafond doit être appliqué en mode fermé (`cost-limit-unknown`, avec
`cost.capOutcome: "unknown-excluded"`). Configurer uniquement `onUnknownCost` est sans effet et ne produit aucun résultat de plafond. Ce réglage est distinct de
`unknownEvidence.cost`, qui peut toujours exclure ou pénaliser les coûts inconnus indépendamment du
résultat du plafond.

## Simuler un profil enregistré

Sélectionnez un profil enregistré et utilisez **Évaluation à sec** pour ajouter des éléments propres à la requête, tels que la taille de la fenêtre de contexte, l’utilisation d’outils, l’entrée d’images ou la sortie structurée. La simulation évalue l’admissibilité et la notation, mais n’envoie jamais de requête à un modèle en amont.

Les modifications non enregistrées ne sont pas prises en compte par la simulation. Enregistrez d’abord le profil afin que la révision et l’évaluation affichées correspondent à la même configuration.

## API de gestion

L’éditeur utilise les points de terminaison suivants :

- `GET /api/routing-profiles` répertorie les profils normalisés et les révisions.
- `PUT /api/routing-profiles` crée ou met à jour un profil. Envoyez `mode: "create"` ou `mode: "update"` ; le mode création refuse d’écraser un identifiant existant.
- `DELETE /api/routing-profiles?id=<id>` supprime un profil.
- `POST /api/routing-profiles/dry-run` évalue un profil enregistré sans envoyer de requête en amont.

Exemple de charge utile de sauvegarde :

```json
{
  "id": "fast",
  "mode": "create",
  "profile": {
    "alias": "ocx/fast",
    "candidates": [
      { "provider": "anthropic", "model": "claude-sonnet-5" },
      { "provider": "openai", "model": "gpt-5.6" }
    ],
    "require": { "tools": true, "minContextWindow": 128000 },
    "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.1, "quota": 0.1 },
    "limits": { "maxEstimatedCostUsd": 0.5, "onUnknownCost": "allow" },
    "unknownEvidence": {
      "capability": "exclude",
      "health": "penalize",
      "quota": "penalize",
      "cost": "penalize"
    }
  }
}
```
