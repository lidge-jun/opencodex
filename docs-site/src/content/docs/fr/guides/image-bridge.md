---
title: Pont de génération d'images
description: Acheminer les appels à l'outil hébergé image_generation vers xAI Grok Imagine lorsqu'un fournisseur autre qu'OpenAI est utilisé.
---

## Vue d'ensemble

Lorsque vous acheminez Codex vers un modèle autre qu'OpenAI (Claude, Gemini, Grok, etc.), l'**outil
hébergé** `image_generation` ne fonctionne normalement pas : il dépend de l'environnement d'exécution
côté serveur d'OpenAI. Le pont de génération d'images détecte ces appels et les redirige de manière
transparente vers xAI Grok Imagine, afin que le modèle avec lequel vous échangez puisse tout de même
générer des images.

## Prérequis

- **Activez le pont** en définissant `images.bridgeEnabled: true` dans votre configuration (il est désactivé
  par défaut afin d'éviter des frais xAI inattendus — voir [Configuration](#configuration) ci-dessous).
- Configurez un fournisseur `xai` avec une **clé API**. Le pont envoie systématiquement les requêtes au
  point de terminaison Images xAI du registre (`https://api.x.ai/v1`) ; tout remplacement de `baseUrl`
  configuré est ignoré pour les appels d'images. OAuth ou `ocx login xai` seul n'active **pas** le pont
  (le transport OAuth de la CLI Grok est destiné aux conversations et n'est pas utilisé pour `/images/*`).

  ```json
  {
    "providers": {
      "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
    }
  }
  ```

- Sélectionnez comme fournisseur actif un modèle autre qu'OpenAI. (Lorsque le fournisseur actif est
  OpenAI, l'outil hébergé natif est utilisé directement et le pont est contourné.)

## Configuration

Les options du pont de génération d'images se trouvent sous `images` dans
`~/.opencodex/config.json`. Le pont est **facultatif** : vous devez définir `bridgeEnabled: true`
pour activer la génération payante avec xAI Grok Imagine :

```json
{
  "images": {
    "bridgeEnabled": true,
    "bridgeModel": "grok-imagine-image-quality",
    "maxRounds": 3,
    "timeoutMs": 60000
  }
}
```

| Option | Valeur par défaut | Description |
| --- | --- | --- |
| `bridgeEnabled` | `false` | Interrupteur principal. Définissez-le sur `true` pour activer le pont. Il est désactivé par défaut afin d'éviter des frais xAI inattendus. |
| `bridgeModel` | `grok-imagine-image-quality` | Identifiant du modèle d'image xAI auquel envoyer les invites. |
| `maxRounds` | `3` | Nombre maximal d'itérations de la boucle de génération d'images par tour. La valeur est ramenée à un entier et limitée à `[0, 10]` ; une valeur non finie est remplacée par `3`. |
| `timeoutMs` | `60000` | Délai maximal par appel xAI, en millisecondes. Les valeurs positives et finies sont ramenées à un entier, puis transmises à la requête xAI. |
| `artifactsKeepCount` | `200` | Nombre maximal de fichiers conservés sous `artifacts/`. Lorsque cette limite est dépassée, les fichiers les plus anciens sont supprimés après chaque appel mené à terme. Définissez la valeur sur `0` ou sur un nombre négatif pour désactiver l'élagage. |

## Conservation des artefacts

Les images générées sont enregistrées dans `~/.opencodex/artifacts/`. Pour éviter une croissance illimitée
du stockage pendant les sessions prolongées, le répertoire est automatiquement élagué après chaque appel
d'image mené à terme (une fois que tout le lot de cet appel est enregistré sur le disque). Lorsque le nombre
de fichiers dépasse le maximum configuré (200 par défaut, réglable avec `images.artifactsKeepCount`), les
plus anciens selon leur date de modification sont supprimés. Seuls les chemins qui subsistent après cet
élagage sont renvoyés au modèle.

## Fonctionnement

Le pont de génération d'images s'active uniquement pendant les tours **Responses** qui incluent l'outil
hébergé `image_generation` dans le tableau tools de `/v1/responses`, lorsqu'un modèle **autre qu'OpenAI**
est sélectionné. Il n'intercepte **pas** l'outil `image_gen` intégré à Codex, lequel envoie directement une
requête POST à `/v1/images/generations` (ou `/images/edits`) ; ce parcours est traité séparément dans
[Intégration de Codex](/fr/guides/codex-integration/#génération-dimages-intégrée-image_gen).

1. Lorsqu'une requête Responses répertorie `image_generation` dans `tools`, OpenCodex le détecte pendant le
   prétraitement de la requête.
2. L'outil hébergé est remplacé par un **outil de fonction synthétique** que le modèle routé peut appeler
   normalement : le modèle voit un outil exécutable plutôt qu'un outil hébergé opaque qu'il ne peut exécuter.
3. Lorsque le modèle appelle cet outil, OpenCodex intercepte l'appel et envoie l'invite à l'API de génération
   d'images de xAI.
4. Les images générées sont enregistrées dans `~/.opencodex/artifacts/`, puis leur **chemin de fichier local**
   est renvoyé au modèle comme résultat de l'outil.
5. Le modèle poursuit la conversation en connaissant l'image générée et son emplacement.

Du point de vue du modèle, rien n'a changé : il a appelé un outil et obtenu un résultat. Du point de vue de
l'utilisateur, la génération d'images fonctionne avec n'importe quel fournisseur routé au lieu d'échouer
silencieusement.

## Limitations

- **Seul xAI Grok Imagine est pris en charge.** DALL-E et d'autres fournisseurs d'images pourront être ajoutés ultérieurement.
- **La recherche web est prioritaire** sur les adaptateurs qui prennent en charge la boucle du service auxiliaire de recherche web. Si la recherche web et la génération d'images sont toutes deux demandées pendant le même tour, la recherche web est exécutée et la génération d'images est ignorée. Les adaptateurs Cursor/`runTurn` ne peuvent actuellement pas utiliser ce service auxiliaire ; le pont de génération d'images peut donc tout de même s'exécuter pendant ces tours qui demandent les deux outils.
- **Les tarifs xAI s'appliquent.** La génération d'images par xAI exige un abonnement xAI actif ou des crédits API.
- **Diffusion en continu uniquement.** Le pont intercepte le flux de réponse SSE ; les requêtes contenant `stream: false` sont rejetées avec une erreur 400.
