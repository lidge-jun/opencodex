---
title: Compatibilité du contexte natif
description: Éligibilité, configuration d’essai authentifiée et limites du relais d’historique et de notes Codex.
---

OpenCodex relaie déjà l’historique et les notes natifs de Codex. Il ne s’agit pas d’un service de mémoire général pour les fournisseurs routés, et l’exposition de ses points de terminaison HTTP ne prouve pas qu’une version, un compte ou un modèle Codex particulier peut les utiliser. Consultez [l’intégration Codex](/fr/guides/codex-integration/) pour les limites de propriété, d’annulation et d’identifiants du relais.

## Deux conditions indépendantes

Codex doit activer l’extension, et OpenCodex doit identifier l’appelant. Modifier l’URL du backend ne satisfait à elle seule aucune de ces conditions.

Le contrat amont Codex examiné exige un modèle dont l’entrée du catalogue natif annonce `supports_experimental_context`, une connexion ChatGPT éligible et un fournisseur nommé exactement `OpenAI` dont l’URL de base se termine par `/backend-api/codex`. Son activation automatique rejette les fournisseurs qui utilisent `env_key`, `experimental_bearer_token`, une `auth` exécutée par commande ou l’authentification AWS. Le prédicat d’éligibilité examiné accepte ChatGPT Plus, Pro et ProLite ; cela ne signifie pas que tous les comptes de ces offres disposent de points de terminaison d’historique fonctionnels.

OpenCodex exige en plus une **clé API du plan de données** active, aussi bien pour la requête de modèle réussie que pour les requêtes de contexte suivantes. L’injection loopback intégrée par défaut n’envoie pas cette clé : elle peut donc servir des modèles alors que les appels de contexte échouent avec `context_principal_required` (403). La seule forme authentifiée de la table des fournisseurs distants ne résout pas non plus le contexte natif : son `env_key` et son nom de fournisseur ne satisfont pas au contrat d’activation Codex ci-dessus. Ne supprimez jamais les contrôles de principal ou de propriété du compte pour masquer l’un ou l’autre problème.

## Syntaxe d’activation explicite

OpenCodex accepte les deux formes persistantes de fonctionnalité racine reconnues par `FeatureToml` de Codex :

```toml
[features]
context_management = true
```

La forme équivalente en table fonctionne aussi et correspond à la syntaxe compatible avec les anciennes versions d’OpenCodex qui ne reconnaissaient pas encore la forme booléenne :

```toml
[features.context_management]
experimental_mode = true
```

Utilisez une seule forme. Une valeur fausse, absente ou malformée laisse la fonction désactivée. Le proxy lit sa propre configuration du répertoire Codex ; une surcharge propre au CLI ou une activation présente uniquement dans un profil Codex n’active pas sa condition d’exécution. Ce changement ne déduit pas l’activation des métadonnées du modèle.

## Profil d’essai natif authentifié

Il s’agit d’une **configuration d’essai vérifiée dans le code source, pas d’une certification de bout en bout avec un compte réel**. Sauvegardez la configuration Codex et conservez un point de reprise durable avant l’essai. Utilisez un nouveau fil jetable ; ne changez pas l’identité du fournisseur d’un fil existant qui fonctionne.

Fournissez une clé active existante du plan de données OpenCodex dans `OCX_CONTEXT_API_KEY`, dans l’environnement du processus Codex. N’utilisez pas un jeton de gestion ou d’administration et ne stockez pas la clé dans TOML. L’environnement d’un service n’est pas automatiquement hérité par une application de bureau lancée séparément. Conservez la connexion ChatGPT native habituelle de Codex ; l’en-tête supplémentaire ne remplace pas OAuth.

Avec l’activation racine ci-dessus, le fournisseur de transfert ChatGPT canonique configuré dans OpenCodex et un catalogue de modèles natifs à jour, ajoutez ce fournisseur et ce profil **supplémentaires** à la même configuration Codex. Adaptez le port à celui du proxy local. Ne modifiez pas le `model_provider` racine ni les tables de fournisseurs existantes.

```toml
[model_providers.ocx-native-context]
name = "OpenAI"
base_url = "http://127.0.0.1:10100/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
env_http_headers = { "x-opencodex-api-key" = "OCX_CONTEXT_API_KEY" }

[profiles.ocx-native-context]
model_provider = "ocx-native-context"
model = "gpt-6-astra"
```

Démarrez un nouveau fil CLI avec `codex --profile ocx-native-context`. L’exemple utilise HTTP/SSE pour limiter l’essai initial au chemin de propriété entre modèle et relais ; il ne modifie pas le transport des autres profils et ne certifie pas la parité WebSocket ou du pilotage en cours de tour. N’utilisez ce modèle que si le catalogue natif du compte annonce effectivement sa capacité de contexte ; ne forcez jamais cet indicateur sur une entrée Devin, Gemini ou d’un autre fournisseur routé.

L’identifiant personnalisé du fournisseur est volontaire. Codex en amont ne remplace généralement pas les fournisseurs intégrés à partir de `model_providers.openai` ; y ajouter un en-tête peut rester sans effet et sans avertissement. L’identifiant personnalisé préserve le fournisseur normal, tandis que le nom exact `OpenAI` satisfait au prédicat du backend natif. N’ajoutez pas `env_key` à ce profil : `env_http_headers` transporte séparément l’autorisation locale, tandis que `Authorization` continue de transporter la connexion ChatGPT native. OpenCodex consomme la clé locale ; il ne la transmet pas à ChatGPT.

L’activation racine concerne aussi les autres profils natifs éligibles. **Pendant cet essai, ne poursuivez pas les fils loopback intégrés ordinaires dépourvus de la clé supplémentaire.** Désactivez la fonctionnalité racine et exécutez `ocx sync` avant de reprendre ces fils. Il ne s’agit ni d’un changement d’intégration automatique ou par défaut, ni d’une preuve de prise en charge de la sélection de profil dans l’application de bureau.

## Vérifier avant de réinitialiser le contexte

Obtenez d’abord une réponse de modèle natif réussie dans le nouveau fil. Vérifiez ensuite l’écriture d’une note, relisez cette même note et interrogez l’historique du fil. Ce n’est qu’après la réussite de ces opérations qu’un essai jetable devrait utiliser `new_context` et vérifier que l’état enregistré peut être restauré. Conservez le point de reprise externe même si l’essai réussit.

- **403 `context_principal_required` :** aucune clé locale valide du plan de données n’a atteint le proxy.
- **409 `context_account_unavailable` :** la propriété est absente ou incohérente ; ne substituez pas le compte actif courant et ne relancez pas aveuglément une écriture.
- **404 :** distinguez la réponse du proxy pour une fonction désactivée ou un point de terminaison inconnu d’une réponse 404 en amont. Cette dernière ne prouve ni un défaut de routage OpenCodex ni une panne touchant tous les comptes.

Un appel de modèle réussi ou `ocx ready` ne prouve pas que les notes, l’historique ou la restauration de l’état fonctionnent. Le routage du modèle, les changements de compte, les redémarrages du proxy et la disponibilité des points de terminaison en amont restent des sujets distincts. Aucun indicateur local ne peut accorder une éligibilité backend manquante, et une opération de contexte échouée ne doit pas être présentée comme une réinitialisation réussie. Supprimez les tables d’essai et retirez la clé d’essai de l’environnement une fois l’essai terminé ; laissez la fonctionnalité désactivée sauf si vous utilisez un chemin authentifié vérifié.

## Contrats amont examinés

Ces liens fixent le contrat source utilisé pour la configuration ci-dessus, sans promettre son fonctionnement dans un déploiement :

- [Formes booléenne et en table de FeatureToml](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/features/src/lib.rs)
- [Éligibilité du contexte natif](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/token_budget.rs)
- [Identité du fournisseur et règles de fusion des fournisseurs intégrés](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/model-provider-info/src/lib.rs)
- [L’historique et les notes utilisent les en-têtes de requête et l’authentification du fournisseur](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/ext/history-notes/src/backend.rs)
