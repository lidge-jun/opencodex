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

Par défaut, les tâches vont à xAI ; `images.videoProvider` peut les envoyer à un autre backend compatible.

## Prérequis

Ces prérequis concernent la destination xAI par défaut. Si `images.videoProvider` est défini, voir [Choisir le fournisseur vidéo](#choisir-le-fournisseur-vidéo).

- Une entrée de fournisseur `xai` avec une **clé API** (`ocx login xai` seul ne suffit pas : le pont vidéo exige une authentification par clé, et non OAuth)
- Un modèle autre qu'OpenAI comme fournisseur routé (par exemple Anthropic Claude ou Google Gemini)
- opencodex configuré pour acheminer les requêtes vers ce fournisseur autre qu'OpenAI

> **⚠ Clé de fournisseur obligatoire :** le pont vidéo ne s'active que si le fournisseur `xai` utilise
> l'authentification par clé API. Ajoutez ceci à votre configuration :
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "${XAI_API_KEY}", "authMode": "key" }
>   }
> }
> ```
>
> Définissez `XAI_API_KEY` dans l’environnement de démarrage du proxy et gardez `${XAI_API_KEY}` avec `authMode: "key"`. Une exportation dans un autre terminal ne change pas un proxy actif : redémarrez-le via Desktop, son service ou son terminal propriétaire. Ne partagez pas les clés littérales.

## Configuration

Ajoutez `videoBridgeEnabled: true` à votre configuration `images` :

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video-1.5-lite",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| Option | Valeur par défaut | Description |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | Interrupteur principal. Doit être activé explicitement. |
| `videoBridgeModel` | `"grok-imagine-video-1.5-lite"` | Identifiant du modèle vidéo xAI. |
| `videoMaxRounds` | `2` | Nombre maximal de tours de génération vidéo avant une réponse finale forcée. |
| `videoTimeoutMs` | `300000` (5 min) | Délai maximal par vidéo, interrogation comprise. |
| `videoProvider` | non défini (xAI) | Fournisseur facultatif à clé d'API qui traite `video_gen` avec ses propres `baseUrl` et clé. Voir [Choisir le fournisseur vidéo](#choisir-le-fournisseur-vidéo). |

## Choisir le fournisseur vidéo

Par défaut, le pont envoie les tâches `video_gen` à xAI avec la clé d'API du fournisseur `xai`. Définissez `images.videoProvider` pour les envoyer à un autre backend qui implémente la même API asynchrone (`POST {baseUrl}/videos/generations`, puis `GET {baseUrl}/videos/{id}`), par exemple un pont multimédia auto-hébergé :

```json
{
  "providers": {
    "my-video-bridge": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:8790/v1",
      "apiKey": "${VIDEO_BRIDGE_KEY}",
      "authMode": "key",
      "allowPrivateNetwork": true
    }
  },
  "images": {
    "videoBridgeEnabled": true,
    "videoProvider": "my-video-bridge",
    "videoBridgeModel": "grok-imagine-video-1.5-lite"
  }
}
```

- Seuls le `baseUrl` et la clé d'API du fournisseur désigné servent de destination et d'identifiant. L'adaptateur importe peu, mais l'authentification doit se faire par clé d'API.
- `"videoProvider": "xai"` conserve le point de terminaison fixe `https://api.x.ai/v1`, quel que soit le `baseUrl` de l'entrée `xai`. Les autres identifiants de fournisseurs intégrés sont refusés ; désignez un fournisseur personnalisé.
- Un `baseUrl` en boucle locale ou en réseau privé exige `allowPrivateNetwork: true` sur ce fournisseur, comme pour le reste du trafic des fournisseurs.
- Une clé qu'OpenCodex peut reconnaître comme xAI (clé `xai-`, clé détenue par une entrée `xai` ou référence d'environnement nommée d'après xAI ou Grok) n'est envoyée qu'à `https://api.x.ai` ou `https://cli-chat-proxy.grok.com` ; toute autre origine est refusée. Une clé sans ces marques ne peut pas être reconnue : ne collez donc pas votre clé xAI dans l'entrée d'un autre fournisseur. Une référence de trousseau vers le secret d'un autre fournisseur est toujours refusée, une clé active en pause est refusée, et le `baseUrl` ne peut contenir ni identifiants, ni requête, ni fragment.
- Si le fournisseur est absent, désactivé, en pause, sans clé ou refusé, chaque appel `video_gen` renvoie cette erreur au modèle. Rien n'est envoyé et le pont ne se rabat jamais sur xAI.
- Avec le protocole xAI, la vidéo terminée n'est téléchargée que depuis une URL `data:` en base64 ou une URL `https:` publique ; un pont local doit donc renvoyer l'une des deux dans `video.url`. Un backend qui sert le fichier depuis son propre hôte définit plutôt `"videoApi": "openai"` (voir [la section OpenAI Videos API du guide anglais](/guides/video-bridge/#openai-videos-api-backends)).

## Fonctionnement

1. opencodex détecte qu'un modèle routé autre qu'OpenAI est utilisé avec `videoBridgeEnabled: true`.
2. Un outil de fonction synthétique `video_gen` est injecté dans la conversation.
3. Lorsque le modèle appelle `video_gen`, opencodex soumet une tâche à `/videos/generations` chez xAI (ou au `images.videoProvider` configuré).
4. Le pont interroge l'état de la tâche toutes les 5 à 15 secondes et envoie des messages de maintien afin de garder le flux actif.
5. Une fois la vidéo prête, elle est téléchargée dans le répertoire des artefacts.
6. Le chemin du fichier local est renvoyé au modèle comme résultat de l'outil.

## Paramètres pris en charge

L'outil `video_gen` accepte les paramètres suivants :

| Paramètre | Type | Plage | Description |
|-----------|------|-------|-------------|
| `prompt` | string | facultatif avec une image ou une image clé | Invite textuelle |
| `duration` | integer | 1-15 | Durée de la vidéo en secondes |
| `resolution` | string | `480p`, `720p`, `1080p` | Selon le modèle ; 720p au maximum avec `last_frame`, `keyframes` ou `reference_images` |
| `aspect_ratio` | string | selon le modèle | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `5:2`; refusé si seule une `image` est animée, car elle conserve son propre format |
| `image` | string | première image | URL HTTPS, URL de données ou artefact mémorisé |
| `last_frame` | string | 1.5 uniquement | Dernière image |
| `keyframes` | array | 1.5, 4 au maximum | `{image, timestamp_s}`; horodatage strictement à l’intérieur du clip (8 s si `duration` est omis) |
| `reference_images` | array | 1.5 : 14, classique : 7 (≤ 10 s) | Images de référence ; le modèle classique ne peut pas les combiner avec `image` |

Les réglages qu’un modèle ne peut pas respecter sont refusés avant tout appel payant au lieu d’être ignorés.

### Modèles et images en entrée

| Modèle | Résolution | Entrées | par seconde (480p / 720p / 1080p) |
|-------|------------|--------|------------------|
| `grok-imagine-video-1.5` | 480p / 720p / 1080p natif | première/dernière image, 4 images clés, 14 références (720p maximum) | $0.08 / $0.14 / $0.25 |
| `grok-imagine-video-1.5-lite` (par défaut) | 480p / 720p / 1080p agrandi | première image | $0.02 / $0.03 / $0.14 |
| `grok-imagine-video` | 480p / 720p | première image, 7 références | $0.05 / $0.07 / — |

Réglez `images.videoBridgeModel` sur `grok-imagine-video-1.5` pour utiliser les images clés ou références. Les modèles connus acceptent neuf formats ; les autres conservent sept formats, 480p/720p et aucune image. Les URL HTTPS et données PNG/JPEG/WebP jusqu’à 10 Mio décodés sont acceptées. Une image téléchargée par le pont peut être référencée par URL d’artefact, chemin absolu ou URL `file:` pendant une heure : son URL source est utilisée sans lire le fichier local. Cela exige la destination xAI fixe, pas un `images.videoProvider` personnalisé. Les résultats en ligne n’ont pas d’URL source et une URL temporaire peut expirer plus tôt.


## Limitations

- **xAI par défaut** : sans `videoProvider`, la génération vidéo utilise l'API Grok Imagine Video de xAI ; un autre backend doit implémenter la même API asynchrone.
- **Asynchrone** : la génération d'une vidéo prend de 30 à 120 secondes.
- **Une vidéo par appel** : chaque appel à `video_gen` produit une vidéo.
- **Coexiste avec le pont de génération d'images** : les deux ponts peuvent être activés simultanément.
- **Priorité à la recherche web** : lorsqu'un service auxiliaire de recherche web est actif pendant un tour (adaptateur autre que `runTurn`), le pont vidéo est ignoré ; les deux ne peuvent pas s'exécuter simultanément. Un `console.warn` est émis afin que vous puissiez le repérer dans les journaux.
- **Le délai couvre la soumission et l'interrogation** : le budget `videoTimeoutMs` commence avant la soumission de la tâche ; l'appel de soumission (60 s) et les interrogations suivantes partagent donc la même échéance.
