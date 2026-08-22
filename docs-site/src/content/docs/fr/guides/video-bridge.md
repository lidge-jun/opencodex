---
title: Pont de génération de vidéos
description: Générer des vidéos avec Grok Imagine Video depuis un modèle autre qu'OpenAI.
---

## Vue d'ensemble

Le pont de génération de vidéos vous permet d'utiliser la génération Grok Imagine Video de xAI depuis
n'importe quel modèle autre qu'OpenAI acheminé par opencodex. Lorsqu'il est activé, un outil synthétique
`video_gen` est injecté dans la conversation. Le modèle l'appelle comme n'importe quel outil de fonction ;
opencodex intercepte l'appel, soumet une tâche de génération vidéo à xAI, interroge son état jusqu'à son
achèvement, puis télécharge le résultat.

## Prérequis

- Une entrée de fournisseur `xai` avec une **clé API** (`ocx login xai` seul ne suffit pas : le pont vidéo exige une authentification par clé, et non OAuth)
- Un modèle autre qu'OpenAI comme fournisseur routé (par exemple Anthropic Claude ou Google Gemini)
- opencodex configuré pour acheminer les requêtes vers ce fournisseur autre qu'OpenAI

> **⚠ Clé de fournisseur obligatoire :** le pont vidéo ne s'active que si le fournisseur `xai` utilise
> l'authentification par clé API. Ajoutez ceci à votre configuration :
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
>   }
> }
> ```
>
> Si vous avez configuré xAI avec `ocx login xai` (OAuth), le fournisseur reste en `authMode: "oauth"`
> et le pont ne s'activera pas, sans produire d'erreur. Définissez `XAI_API_KEY` dans l'environnement
> **ou** enregistrez directement la clé comme dans l'exemple ci-dessus.

## Configuration

Ajoutez `videoBridgeEnabled: true` à votre configuration `images` :

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| Option | Valeur par défaut | Description |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | Interrupteur principal. Doit être activé explicitement. |
| `videoBridgeModel` | `"grok-imagine-video"` | Identifiant du modèle vidéo xAI. |
| `videoMaxRounds` | `2` | Nombre maximal de tours de génération vidéo avant une réponse finale forcée. |
| `videoTimeoutMs` | `300000` (5 min) | Délai maximal par vidéo, interrogation comprise. |

## Fonctionnement

1. opencodex détecte qu'un modèle routé autre qu'OpenAI est utilisé avec `videoBridgeEnabled: true`.
2. Un outil de fonction synthétique `video_gen` est injecté dans la conversation.
3. Lorsque le modèle appelle `video_gen`, opencodex soumet une tâche à `/videos/generations` chez xAI.
4. Le pont interroge l'état de la tâche toutes les 5 à 15 secondes et envoie des messages de maintien afin de garder le flux actif.
5. Une fois la vidéo prête, elle est téléchargée dans le répertoire des artefacts.
6. Le chemin du fichier local est renvoyé au modèle comme résultat de l'outil.

## Paramètres pris en charge

L'outil `video_gen` accepte les paramètres suivants :

| Paramètre | Type | Plage | Description |
|-----------|------|-------|-------------|
| `prompt` | string | required | Invite détaillée de génération vidéo |
| `duration` | integer | 1-15 | Durée de la vidéo en secondes |
| `resolution` | string | `"480p"`, `"720p"` | Résolution de la vidéo |
| `aspect_ratio` | string | 7 ratios | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3` |

## Limitations

- **xAI uniquement** : la génération vidéo est disponible exclusivement par l'intermédiaire de l'API Grok Imagine Video de xAI.
- **Asynchrone** : la génération d'une vidéo prend de 30 à 120 secondes.
- **Coût** : la génération vidéo est une fonctionnalité xAI payante (environ 0.05 $/s en 480p et 0.07 $/s en 720p).
- **Une vidéo par appel** : chaque appel à `video_gen` produit une vidéo.
- **Coexiste avec le pont de génération d'images** : les deux ponts peuvent être activés simultanément.
- **Priorité à la recherche web** : lorsqu'un service auxiliaire de recherche web est actif pendant un tour (adaptateur autre que `runTurn`), le pont vidéo est ignoré ; les deux ne peuvent pas s'exécuter simultanément. Un `console.warn` est émis afin que vous puissiez le repérer dans les journaux.
- **Le délai couvre la soumission et l'interrogation** : le budget `videoTimeoutMs` commence avant la soumission de la tâche ; l'appel de soumission (60 s) et les interrogations suivantes partagent donc la même échéance.
