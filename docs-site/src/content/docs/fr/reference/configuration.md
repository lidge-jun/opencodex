---
title: Référence de configuration
description: Où opencodex stocke la configuration, comment les modifications sont appliquées et les liens vers chaque domaine de configuration.
---

opencodex stocke sa configuration persistante dans `$OPENCODEX_HOME/config.json`, normalement
`~/.opencodex/config.json`. Sous Windows, la valeur par défaut est
`%USERPROFILE%\.opencodex\config.json`.

## Façons de modifier la configuration

Choisissez le canal d'édition qui correspond à la tâche :

- **Tableau de bord :** utilisez l'interface Web pour configurer de manière guidée les fournisseurs, les modèles, les agents, les accès et le stockage.
- **Interface en ligne de commande :** `ocx init` crée le fichier initial, tandis que des commandes telles que `ocx provider`, `ocx models`,
  `ocx combo`, `ocx agent` et `ocx config` mettent à jour ou consultent les paramètres qui leur sont propres.
- **Fichier :** modifiez directement `config.json` pour les champs qui ne disposent ni d'une interface dédiée ni d'une commande. Le fichier doit
  rester au format JSON valide.

Le tableau de bord, l'API de gestion et les commandes qui modifient la configuration enregistrent tous leurs changements dans le même fichier. Privilégiez ces
canaux ou arrêtez le proxy avant toute modification manuelle. Un processus actif conserve la configuration en mémoire : un
enregistrement ultérieur à chaud peut donc réécrire, depuis cet instantané, des modifications manuelles sans rapport. Lors d'un enregistrement à chaud, les champs
`claudeCode` et ceux de liaison de l'écouteur modifiés en externe sont fusionnés lorsqu'ils bénéficient d'une protection explicite contre les conflits, mais cette
protection ne s'étend pas à toutes les sous-arborescences.

Si le fichier ne peut pas être analysé, opencodex le sauvegarde en tant que
`config.json.invalid-<timestamp>`, affiche un avertissement dans la console et démarre avec les valeurs par défaut. Si le fichier est absent,
la valeur par défaut d'une nouvelle installation est également utilisée : un fournisseur `openai` en mode transfert.

## Priorité et valeurs par défaut

Les valeurs valides de `config.json` remplacent les valeurs par défaut intégrées. Les champs facultatifs absents utilisent les valeurs par défaut
documentées dans les pages de chaque domaine. `OPENCODEX_HOME` est prioritaire sur le répertoire de configuration
par défaut. Les champs qui acceptent une référence à une variable d'environnement, comme `apiKey: "${PROVIDER_API_KEY}"`,
résolvent cette variable au moment de la requête. Pour le proxy sortant, une variable `HTTP_PROXY` ou
`HTTPS_PROXY` déjà définie est prioritaire sur le champ `proxy` de premier niveau.

Le routage a ses propres règles de résolution ordonnées ; voir [Routage](/fr/reference/configuration/routing/).

## Domaines de configuration

- [Fournisseurs](/fr/reference/configuration/providers/) — entrées de fournisseur, authentification, points de terminaison,
  catalogues, listes autorisées, limites de contexte, quotas et options spécifiques au fournisseur.
- [Routage](/fr/reference/configuration/routing/) — `defaultProvider`, ordre de résolution du modèle, combos,
  alias et valeurs par défaut des efforts de combo.
- [Agents](/fr/reference/configuration/agents/) — mode multi-agents, conseils de délégation, modèles de repli,
  synchronisation native par défaut et plafonds d’effort.
- [Serveur et environnement d'exécution](/fr/reference/configuration/server/) — écouteur et accès à distance, clés d'admission,
  délais d'attente, stockage, services auxiliaires, comportement au démarrage et appels fantômes.

## Gardez les secrets hors du fichier

Préférez les références `${ENV_VAR}` pour les clés API. Les valeurs littérales de `apiKey`, `apiKeyPool[].key` et `apiKeys[].key`
sont secrètes : ne les validez pas dans Git, ne les collez pas dans des journaux et ne les partagez pas. Les jetons OAuth et ceux des fournisseurs en mode transfert sont
stockés dans des magasins d'informations d'identification distincts plutôt que dans `config.json`. Les identifiants de compte et les adresses e-mail doivent également
rester confidentiels ; utilisez des alias de sélection publics lorsqu'ils sont pris en charge.

:::note[Écritures atomiques]
opencodex écrit les fichiers gérés `config.toml` et `opencodex-catalog.json` dans un fichier temporaire,
puis le renomme (`atomicWriteFile`).
Cela évite les fichiers partiels lorsque plusieurs processus d'écriture, comme `ocx stop` et le gestionnaire d'arrêt du proxy,
restaurent Codex simultanément.
:::
