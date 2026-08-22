---
title: API de gestion
description: Authentification, erreurs et référence des points de terminaison du plan de contrôle d'opencodex.
---

L'API de gestion constitue le plan de contrôle d'opencodex. Le tableau de bord accessible à
`http://localhost:10100` en est l'un des clients ; les commandes `ocx` sans interface graphique qui gèrent les fournisseurs, les modèles, les combinaisons, les comptes,
les paramètres, les diagnostics et le cycle de vie en sont également clientes. L'API n'est disponible que lorsque le
proxy est en cours d'exécution.

Utilisez le [tableau de bord web](/fr/guides/web-dashboard/) comme client interactif, ou cette référence pour
créer des automatisations. Les valeurs persistantes obéissent en dernier ressort à la [configuration](/fr/reference/configuration/).

## Modèle d'authentification

L'API de gestion possède son propre identifiant d'administrateur, indépendant des clés API du plan de données. Au démarrage,
opencodex le détermine dans l'ordre suivant :

1. `OPENCODEX_ADMIN_AUTH_TOKEN`, lorsqu'il est défini.
2. Un jeton `ocx_admin_*` généré dans un fichier secret renforcé.

Le jeton stocké dans un fichier n'est accepté qu'après le durcissement des autorisations ou des listes de contrôle d'accès (ACL)
du répertoire et du fichier. Si cette protection ne peut pas être garantie, l'authentification de gestion échoue de manière sûre et l'API renvoie
503 jusqu'à ce qu'un jeton soit fourni par l'environnement ou que l'état du fichier soit corrigé.

Envoyez le jeton d'administrateur sous l'une ou l'autre forme :

```http
X-OpenCodex-API-Key: <admin-token>
```

```http
Authorization: Bearer <admin-token>
```

:::caution
Le jeton d'administrateur doit différer de tout identifiant du plan de données. Au démarrage, opencodex rejette un
identifiant de gestion qui entre en conflit avec une clé d'admission du proxy. Ne transmettez pas le jeton d'administrateur à Codex,
Claude Code ou à un autre client de modèle : il autorise les modifications du plan de contrôle.
:::

### Sessions du tableau de bord sur l'interface de bouclage

Sur une liaison de bouclage, l'amorçage du tableau de bord peut recevoir un identifiant `ocx_session_*` de courte durée.
Chaque session dure cinq minutes et est liée à l'origine exacte du tableau de bord. Les requêtes sûres doivent
correspondre à cette origine. Les méthodes non sûres exigent également l'en-tête `Origin` du navigateur et le jeton CSRF de la session.

L'émission de sessions est désactivée dès que l'authentification du plan de données est requise, notamment pour les liaisons
distantes. Un opérateur distant doit s'authentifier avec le jeton d'administrateur brut ; aucune session d'interface graphique propre au bouclage
n'est créée.

## Erreurs courantes

Toutes les lignes de points de terminaison ci-dessous héritent de ces erreurs de périmètre. La colonne « Erreurs notables » répertorie les
résultats propres à chaque route, sans répéter ce tableau.

| Statut | Type ou code | Signification |
| --- | --- | --- |
| 401 | `opencodex admin token required` | Le jeton d'administrateur ou la session d'interface graphique est absent, invalide, expiré, associé à une autre origine, ou la preuve CSRF est manquante |
| 403 | `cross-origin request blocked` | L'origine de la demande se trouve en dehors de la liste autorisée de gestion |
| 404 | `not_found` | Aucune route de gestion ne correspond à la méthode et au chemin |
| 413 | `request body too large` | Un corps POST, PUT ou PATCH dépasse la limite de gestion de 2 MiB |
| 503 | `management API unavailable` | L'initialisation ou le renforcement des informations d'identification d'administrateur n'est pas disponible |
| 503 | `oauth_mutation_busy` | Une autre modification des identifiants OAuth détient le verrou d'écriture ; la réponse comprend `Retry-After: 1` |
| 503 | `catalog_busy` | La collecte du catalogue est déjà à pleine capacité ; la réponse comprend `Retry-After: 1` |

## Matrice des points de terminaison

### Paramètres des agents et des clients

| Méthode et chemin | Objectif | Erreurs notables |
| --- | --- | --- |
| `GET, PUT /api/v2` | Lire ou modifier le mode multi-agent v2 natif et les paramètres de tâche | 400 paramètres invalides ; 502 échec de transition ou de persistance |
| `GET, PUT /api/injection-model` | Lire ou définir les paramètres du modèle de sous-agent injecté, de l'effort, de l'invite et du guidage | 400 modèle, effort ou corps invalide |
| `GET, PUT /api/effort-caps` | Lire ou définir les plafonds d'effort de raisonnement globaux et sous-agents | 400 valeur d'échelle invalide |
| `GET, PUT /api/subagent-models` | Lire ou ordonner les modèles annoncés aux sous-agents | 400 liste invalide ou plus de cinq modèles |
| `GET, PUT /api/subagent-model-fallback` | Lire ou définir la chaîne de secours ordonnée et l'intervalle d'interrogation | 400 liste ou intervalle d'interrogation invalide |
| `GET /api/grok` | Lire l'état de la configuration Grok gérée et les modèles candidats | 400 échec de lecture de l'état |
| `PUT /api/grok/selection` | Persister les modèles Grok exclus | 400 sélection invalide ou surdimensionnée |
| `POST /api/grok/apply` | Appliquer la configuration Grok persistante par la synchronisation gérée | 409 `grok_apply_busy` ; 400/500 échec de l'application |
| `GET, PUT /api/claude-desktop` | Lire ou enregistrer le profil Claude Desktop routé ou natif | 400 affectation invalide ou indisponible |
| `POST /api/claude-desktop/apply` | Écrire le profil enregistré dans la configuration gérée de Claude Desktop | 400/500 échec d'écriture |
| `GET /api/claude-desktop/status` | Inspecter le profil enregistré par rapport à celui appliqué et l'état du bureau | 400 échec de lecture de l'état |
| `GET, PUT /api/claude-code` | Lire ou mettre à jour les paramètres de passerelle, de mode d'authentification, de correspondance des modèles, de contexte, d'agent et de service auxiliaire | 400 champ ou structure invalide |

Pour comprendre la liste de modèles et le comportement chiffré des tâches confiées aux agents d'exécution, voir
[Surface des sous-agents](/fr/guides/sub-agent-surface/).

### Combinaisons

| Méthode et chemin | Objectif | Erreurs notables |
| --- | --- | --- |
| `GET /api/combos` | Répertorier les combinaisons normalisées et leurs identifiants de modèle publics | Le traitement du catalogue peut renvoyer `catalog_busy` |
| `PUT /api/combos` | Créer, remplacer ou renommer un combo | 400 identifiant, cible, configuration, renommage ou collision ordinaire invalide ; 409 Collision d'espace de noms de compte Codex |
| `DELETE /api/combos?id=...` | Supprimer une combinaison et effacer son état de sélection et de temporisation | 400 identifiant manquant ; 404 combinaison inconnue |

Voir [Combos](/fr/guides/combos/) pour les stratégies cibles, les temps de recharge, les alias et les échecs de routage.

### Configuration, démarrage, synchronisation et mises à jour

| Méthode et chemin | Objectif | Erreurs notables |
| --- | --- | --- |
| `GET /api/config` | Renvoyer l'objet de transfert de configuration expurgé et sécurisé pour la gestion | — |
| `PUT /api/config` | Toujours refusé : le remplacement intégral de la configuration est désactivé | 405 ; utiliser les points de terminaison ciblés, notamment `POST /api/providers` pour les fournisseurs |
| `GET, PUT /api/settings` | Lire les paramètres d'exécution et de démarrage, ou mettre à jour le démarrage automatique, le mode de diffusion, le budget mémoire propre à l'application et `codexAccountPickerEnabled` | 400 mise à jour invalide, vide ou qui n'est pas un objet |
| `GET /api/startup-health` | Lire l'état de santé du service et du lanceur intermédiaire, mis en cache au démarrage | — |
| `POST /api/startup-action` | Installer ou réparer le service ou le lanceur intermédiaire Codex | 400 action invalide ; 500 échec de l'action |
| `GET, POST /api/windows-tray` | Lire l'état de l'icône de notification Windows, ou l'installer, la démarrer, l'arrêter ou la désinstaller | 400 plateforme ou action non prise en charge ; 500 échec de l'opération |
| `GET /api/diagnostics/project-config` | Lire les avertissements de configuration du projet mis en cache | — |
| `POST /api/sync` | Synchroniser le catalogue de modèles actuel dans Codex | 500 échec de synchronisation |
| `GET /api/update/check` | Vérifier le canal de mise à jour `latest` ou `preview` | 400 balise invalide |
| `POST /api/update/run` | Démarrer une tâche de mise à jour, éventuellement suivie d'un redémarrage | 400 corps invalide ; état de conflit ou d'erreur propre à la tâche |
| `GET /api/update/status` | Interroger une tâche de mise à jour par identifiant | 404 tâche inconnue |
| `GET, PUT /api/sidecar-settings` | Lire ou mettre à jour les paramètres de modèle et de moteur des services auxiliaires de recherche Web et de vision | 400 structure, moteur ou limite invalide |
| `GET, PUT /api/shadow-call-settings` | Lire ou mettre à jour les paramètres d'interception d'appels fantômes | 400 forme ou valeur invalide |

### Journaux, utilisation et stockage

| Méthode et chemin | Objectif | Erreurs notables |
| --- | --- | --- |
| `GET /api/logs` | Requête filtrée dans les journaux de requêtes en mémoire | — |
| `GET, PUT /api/debug` | Lire les indicateurs de débogage ; définir, effacer ou réinitialiser les catégories de capture | 400 mise à jour invalide ou vide |
| `GET /api/debug/logs` | Lire un nombre limité d'entrées de journal des fournisseurs et du débogage | — |
| `GET /api/debug/usage-logs` | Lire un nombre limité d'entrées de débogage de l'utilisation | — |
| `GET /api/debug/injection-logs` | Lire un nombre limité d'entrées de débogage de l'injection du guidage | — |
| `GET /api/claude/inbound-debug` | Lire l'état et les entrées du débogage entrant | — |
| `GET /api/usage` | Résumer l'utilisation par période et par interface cliente ; les réponses Codex comprennent aussi une ventilation `accounts` indexée par des libellés de journalisation stables ne contenant aucune donnée personnelle | Renvoie un résumé `error: "read_failed"` si le stockage ne peut pas être lu |
| `GET /api/storage` | Analyser l'utilisation du stockage Codex par catégorie | Renvoie une charge utile `error: "scan_failed"` en cas d'échec de l'analyse |
| `POST /api/storage/cleanup/preview` | Prévisualiser le nettoyage des sessions archivées et renvoyer une empreinte contraignante | 400 `invalid_json` ou `invalid_percent` |
| `POST /api/storage/cleanup` | Mettre en quarantaine ou supprimer définitivement l'ensemble archivé prévisualisé | 400 saisie invalide ; 409 état obsolète, occupé ou référencé ; 500 échec du système de fichiers ou de la base de données |
| `GET /api/storage/trash` | Répertorier les entrées de nettoyage mises en quarantaine | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | Restaurer une entrée en quarantaine | 400 identifiant invalide ; 404 entrée absente de la corbeille ; 409 opération occupée ou conflit de destination ; 500 échec de la restauration |
| `GET /api/storage/trash/restore/test-stream` | Point d'ancrage du flux de restauration réservé aux tests | 404 `not_available` lorsque les points d'ancrage de test sont désactivés |
| `GET, PUT /api/storage/cleanup-policy` | Lire ou mettre à jour la stratégie de nettoyage planifié et l'état du travail | 400 politique invalide |
| `POST /api/storage/cleanup-policy/run` | Démarrer une exécution manuelle de la politique de nettoyage | 409 `already_running` ; 500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | Point d'ancrage du flux de stratégie réservé aux tests | 404 `not_found` en cas d'indisponibilité |

Pour `GET /api/usage?range=30d&surface=codex`, `accounts` contient une ligne par libellé de pool Codex
observé. Chaque ligne indique `accountLogLabel`, le total de jetons, `usageCoverageRatio` et une valeur facultative
`estimatedCostUsd` calculée selon les tarifs d'affichage actuellement configurés. Les substitutions `modelCosts` actives de l'utilisateur
sont prioritaires sur le catalogue vérifié fourni et sur les tarifs de repli ; l'utilisation historique est
réestimée d'après la tarification active au moment de la lecture du résumé. Il s'agit d'une estimation équivalente à un usage d'API,
et non de frais d'abonnement. Les nouvelles requêtes du pool principal utilisent le libellé réservé `main` ; les anciennes lignes
`openai` sans qualification restent dans une catégorie ambiguë au lieu d'être réaffectées d'après la configuration actuelle.

:::caution
Les points de terminaison de nettoyage du stockage peuvent déplacer ou supprimer définitivement les données de session archivées. Toujours prévisualiser
d’abord et soumettez le résumé renvoyé. Préférez la quarantaine lorsqu’une récupération peut être nécessaire.
:::

### Modèles et catalogue

| Méthode et chemin | Objectif | Erreurs notables |
| --- | --- | --- |
| `GET /api/catalog` | Renvoyer le document catalogue Codex installé | 404 catalogue introuvable |
| `GET /api/models` | Renvoyer les lignes de modèles destinées au tableau de bord et à l'interface en ligne de commande | `catalog_busy` lorsque la collecte est saturée |
| `GET /api/client-config?client=...` | Créez une configuration client en lecture seule pour toute intégration de fichiers prise en charge | 400 client non pris en charge ; 503 catalogue indisponible |
| `PUT /api/disabled-models` | Remplacer la liste partagée des modèles désactivés | 400 invalide JSON |
| `PUT /api/model-visibility` | Modifier atomiquement la visibilité au niveau du fournisseur ou du modèle | 400 fournisseur, portée, cible ou corps non valide |
| `GET, POST /api/custom-models` | Répertoriez les modèles personnalisés ou ajoutez-en un | 400 champs invalides ; 404 fournisseur manquant ; 409 dupliquer le modèle |
| `PUT, DELETE /api/custom-models/{id}` | Modifier ou supprimer un modèle personnalisé | 400 invalide id/fields ; 404 introuvable ; 409 modèle en double |
| `GET, PUT /api/selected-models` | Lire les listes autorisées et la disponibilité des fournisseurs, ou remplacer une liste autorisée | 400 fournisseur ou corps manquant ; 404 fournisseur inconnu |

### Comptes OAuth, clés de fournisseur et clés du plan de données

| Méthode et chemin | Objectif | Erreurs notables |
| --- | --- | --- |
| `GET /api/oauth/providers` | Répertorier les fournisseurs avec des flux de connexion publics OAuth | — |
| `GET /api/key-providers` | Répertorier les fournisseurs configurés par connexion avec une clé API | — |
| `POST /api/oauth/login` | Démarrez un processus de connexion OAuth ou d'ajout de compte | 400 unknown/invalid fournisseur ; `oauth_mutation_busy` |
| `POST /api/oauth/login/code` | Soumettre manuellement une URL de rappel ou un code d'autorisation | 400 fournisseur ou code invalide ; `oauth_mutation_busy` |
| `POST /api/oauth/login/cancel` | Annuler un flux OAuth public en cours | 400 fournisseur inconnu |
| `GET /api/oauth/status` | Sonder le flux OAuth d'un fournisseur | 400 fournisseur inconnu |
| `POST /api/oauth/logout` | Supprimer les informations d'identification du fournisseur sélectionné | 400 fournisseur inconnu ; `oauth_mutation_busy` |
| `GET, DELETE /api/oauth/accounts` | Répertorier les comptes masqués ou supprimer un compte | 400 invalide provider/id ; 404 compte manquant ; `oauth_mutation_busy` |
| `PUT /api/oauth/accounts/active` | Sélectionnez le compte OAuth actif | 400 invalide provider/account ; `oauth_mutation_busy` |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | Lire ou mettre à jour la stratégie du pool OAuth Anthropic | 400 fournisseur non Anthropic ou stratégie invalide |
| `POST /api/oauth/accounts/clear-cooldown` | Effacer le temps de recharge d'un compte OAuth | 400 invalide provider/account |
| `PUT /api/oauth/accounts/alias` | Définir ou supprimer un alias de compte OAuth | 400 invalide provider/account/alias |
| `GET, POST, DELETE /api/providers/keys` | Répertorier les clés de fournisseur masquées, en ajouter ou en activer une, ou en supprimer une | 400 saisie invalide ; 404 fournisseur ou clé manquante |
| `PUT /api/providers/keys/active` | Sélectionnez la clé active d'un fournisseur | 400 saisie invalide ; 404 provider/key manquant |
| `PUT /api/providers/keys/alias` | Définir ou supprimer un alias de clé de fournisseur | 400 saisie invalide ; 404 provider/key manquant |
| `GET, POST, PATCH, DELETE /api/keys` | Répertorier, créer, modifier ou supprimer les clés d'admission du plan de données | 400 corps ou identifiant invalide ; 404 clé manquante |

Les réponses qui répertorient les identifiants sont délibérément masquées. Les jetons d'accès OAuth et les clés API complètes des
fournisseurs ne sont pas renvoyés aux clients du tableau de bord.

### Fournisseurs

| Méthode et chemin | Objectif | Erreurs notables |
| --- | --- | --- |
| `GET /api/providers` | Répertorier la configuration du fournisseur expurgée et l'état de découverte | — |
| `POST /api/providers` | Ajouter ou remplacer un fournisseur validé et éventuellement le définir par défaut | 400 destination invalide ou dangereuse, ou configuration invalide ; 409 collision d'espace de noms |
| `PATCH /api/providers?name=...` | Mettre à jour les champs de fournisseur autorisés, notamment un bloc `headers` fusionné, l'état d'activation ou de fournisseur par défaut, ou le mode de compte OpenAI | 400 champ ou transition invalide ; 404 fournisseur inconnu |
| `DELETE /api/providers?name=...` | Supprimer un fournisseur, en réattribuant la valeur par défaut lorsque cela est possible | 404 fournisseur inconnu ; 409 `last_provider` ; 409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` | Effectuer une sonde en direct, limitée à la connectivité et à la découverte des modèles du fournisseur | 404 fournisseur inconnu ; les échecs sont normalement renvoyés sous forme de résultat `ok: false` |
| `GET /api/provider-quotas` | Lire les rapports de quotas des fournisseurs ; `refresh=1` force le rafraîchissement | — |
| `GET, PUT /api/provider-context-caps` | Lire ou mettre à jour les plafonds de contexte globaux, communs à tous les fournisseurs ou propres à un fournisseur | 400 requête invalide ; 404 fournisseur inconnu |
| `GET /api/provider-presets` | Renvoyer les préréglages de fournisseur de l'interface graphique dérivés du registre d'exécution | — |

`provider_has_dependent_combos` est une barrière de sécurité : supprimez ou modifiez les combinaisons dépendantes avant de
supprimer leur fournisseur.

### Barre latérale et actions liées au consentement

| Méthode et chemin | Objectif | Erreurs notables |
| --- | --- | --- |
| `GET /api/github/star` | Lire le statut de l'étoile du référentiel via la session `gh` de l'utilisateur | Codes de résultat fixes spécifiques au statut |
| `POST /api/github/star` | Ajouter une étoile au dépôt uniquement à la suite d'une action humaine authentifiée | 403 `agent_consent_required` pour les appelants pilotés par un agent sans preuve de session du tableau de bord |
| `GET /api/update/badge` | Lire l'état, peu coûteux à calculer, du badge de mise à jour de la barre latérale | — |

:::caution
L'authentification de gestion prouve l'accès au proxy, mais pas le consentement à engager
l'identité de l'utilisateur. Un agent ne doit pas contourner `agent_consent_required`. L'utilisateur doit choisir
lui-même s'il souhaite ajouter une étoile au dépôt.
:::

### Cycle de vie du système

| Méthode et chemin | Objectif | Erreurs notables |
| --- | --- | --- |
| `GET /api/system/memory` | Renvoyer les mesures scalaires du processus, du tas, des flux, de l'état des réponses, du mécanisme de surveillance et des tours actifs | — |
| `POST /api/system/restart` | Amorcer un redémarrage du processus qui attend l'évacuation des requêtes, sans retirer l'injection du client | Renvoie 202 ; les appels répétés signalent l'évacuation déjà en cours |
| `POST /api/stop` | Arrêter le service, restaurer Codex en mode natif, retirer l'injection Grok gérée et évacuer les requêtes du proxy | 409 conflit de propriété du service |
| `GET /api/system/codex-app-server` | Indiquer si les serveurs d'application Codex en cours d'exécution sont antérieurs au catalogue de modèles actuel | — |
| `POST /api/system/codex-restart` | Actualiser le catalogue, puis demander aux serveurs d'application Codex obsolètes de s'arrêter afin que le sélecteur de modèles se recharge | Renvoie 200 avec `code: partially_stopped` lorsqu'une cible ne s'arrête pas |

### Délégation de l'authentification Codex

`GET /api/settings` indique la valeur effective du booléen `codexAccountPickerEnabled`. Un `PUT` contenant
strictement ce booléen initialise des sélecteurs de compte respectueux de la confidentialité lorsqu'une table vide est activée, préserve
les libellés de sélection existants lors d'une désactivation ou d'une réactivation, enregistre d'abord les changements, puis demande une
convergence limitée du catalogue uniquement si la visibilité effective du sélecteur a changé. La réponse en cas de réussite comprend
`catalogRefreshPending` : `false` signifie que la validation du catalogue est terminée, ou qu'aucune actualisation n'était nécessaire ;
`true` signifie que le paramètre a été enregistré, mais que `POST /api/sync` doit être utilisé pour retenter l'actualisation du catalogue.
Un échec de l'enregistrement ou de l'attribution d'un sélecteur rétablit les paramètres en mémoire et n'exécute pas la
convergence.

Le répartiteur racine de l'API de gestion délègue chaque requête `/api/codex-auth/*` au gestionnaire de comptes
Codex. Ses routes sont les suivantes :

| Méthode et chemin | Objectif | Erreurs notables |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | Répertorier, actualiser ou supprimer des comptes Codex. POST est conservé comme point de terminaison de compatibilité désactivé ; les réponses DELETE réussies incluent `catalogRefreshPending`. | POST renvoie toujours 403 `manual_import_disabled` ; 400 entrée DELETE invalide |
| `PUT /api/codex-auth/accounts/alias` | Définir ou supprimer un alias de compte | 400 invalide account/alias |
| `PUT /api/codex-auth/accounts/pause` | Suspendre ou reprendre un compte | 400 invalide account/state ; 404 compte manquant |
| `PUT /api/codex-auth/accounts/pause-exhausted` | Suspendre les comptes dont le quota est épuisé | Les échecs de verrouillage de mutation deviennent 503 |
| `POST /api/codex-auth/accounts/clear-cooldown` | Effacer le temps de recharge d'exécution pour un compte ou tous les comptes | 400 identifiant invalide |
| `GET, PUT /api/codex-auth/active` | Lire ou sélectionner le compte actif | 400 compte invalide ou manquant ; 409 conflit avec un compte suspendu ou une ancienne ligne |
| `PUT /api/codex-auth/auto-switch` | Définir le seuil de quota pour le changement automatique de compte | 400 seuil invalide |
| `PUT, PATCH /api/codex-auth/pool-strategy` | Mettre à jour la stratégie de sélection du groupe de comptes Codex | 400 stratégie ou configuration invalide |
| `PUT /api/codex-auth/failover` | Définir le seuil de basculement du compte | 400 seuil invalide |
| `GET /api/codex-auth/quota` | Lire l'état du quota mis en cache par compte | — |
| `GET /api/codex-auth/reset-credits` | Inspecter l'éligibilité au crédit de réinitialisation pour un compte | 400 identifiant de compte manquant ; transmission du statut en amont ; 500 échec de recherche |
| `POST /api/codex-auth/reset-credits/consume` | Consommer un crédit de réinitialisation éligible | 400 identifiant de compte manquant ; transmission du statut en amont ; 503 `server_busy` ; 500 consommer l'échec |
| `POST /api/codex-auth/login` | Démarrer une connexion ou une réauthentification Codex | 400 requête invalide ; état de connexion en conflit ou occupé |
| `POST /api/codex-auth/login/code` | Soumettre manuellement un code pour un flux de connexion Codex | 400 flux ou code invalide |
| `POST /api/codex-auth/login/cancel` | Annuler un flux de connexion Codex | — |
| `GET /api/codex-auth/login-status` | Interrogez un flux ou un état de connexion à un compte. Un flux de nouveau compte terminé inclut `catalogRefreshPending: true` uniquement lorsque la récupération est nécessaire. | Rapport de flux inconnus `expired` ; aucun rapport de flux actif `idle` |

Si une nouvelle ligne de configuration de compte est enregistrée, mais que la mise en place des identifiants ne peut pas aboutir, le `login-status` OAuth indique
`status: "error"` avec
`code: "codex_credential_persistence_failed"`, `accountId`, `needsReauth: true` et en option
`catalogRefreshPending: true` ; les détails des erreurs de stockage ne sont pas exposés. La ligne du compte reste enregistrée :
réauthentifiez-le ou supprimez-le avant de réessayer de créer un compte.

Les délais d'attente du verrou d'écriture de la configuration ou d'actualisation des identifiants dans cette famille de routes déléguées renvoient le statut HTTP
503 avec le code `CONFIG_MUTATION_LOCK_UNAVAILABLE`. Les clients doivent réessayer rapidement plutôt que de considérer
cette réponse comme un échec de compte permanent.

La création et la suppression d'un compte valident les identifiants et la configuration avant la convergence du catalogue. Une tentative de catalogue
différée ou en échec n'annule jamais la modification persistante du compte et ne révèle jamais de détails internes sur le fournisseur,
le compte, le chemin ou les identifiants ; les clients ne reçoivent que le booléen d'achèvement. La suppression d'un
compte conserve sa liaison au sélecteur : les routes exactes échouent ainsi de manière sûre tant que le compte est absent, et le
même sélecteur est restauré si cet identifiant de compte est ajouté de nouveau.

## Choisir un client

Pour l'administration courante, le [tableau de bord web](/fr/guides/web-dashboard/) offre le parcours guidé le plus sûr.
Pour les hôtes sans interface graphique et l'automatisation, utilisez les commandes `ocx` correspondantes : elles appellent cette
même API active et renvoient un code différent de zéro lorsque le proxy est inaccessible ou que l'opération échoue.
L'accès HTTP direct est surtout utile aux intégrations qui exigent les contrats exacts des points de terminaison ci-dessus.
