---
title: Clients compatibles Ollama
description: Dirigez les outils qui parlent l'API Ollama vers opencodex et utilisez les modèles de vos fournisseurs configurés.
---

opencodex répond à un sous-ensemble de l'API HTTP d'Ollama : un outil qui ne sait parler qu'à Ollama peut
ainsi utiliser les modèles déjà configurés dans opencodex. Les requêtes sont traduites vers le chemin Chat
Completions et envoyées au fournisseur choisi. opencodex ne télécharge, ne stocke et n'exécute aucun modèle sur
votre machine.

## Connecter un client

Utilisez l'adresse du proxy comme hôte Ollama. Pour une installation locale par défaut :

```bash
export OLLAMA_HOST=http://127.0.0.1:10100
curl "$OLLAMA_HOST/api/tags"
```

Lorsque le proxy exige une clé d'API (par exemple avec une liaison `0.0.0.0`), envoyez-la comme pour
`/v1/chat/completions`, par exemple `Authorization: Bearer <opencodex key>`. Une clé limitée à certains modèles
ne voit et n'utilise que les modèles autorisés. Ces points de terminaison ne sont servis que par l'écouteur
principal ; l'écouteur loopback sans authentification, Remote Link et l'entrée de gestion du hub ne les exposent pas.

## Points de terminaison

| Point de terminaison | Comportement |
| --- | --- |
| `GET /api/version` | La version d'opencodex. |
| `GET /api/tags` | Les modèles des fournisseurs configurés, sous la forme `provider/model`. |
| `POST /api/show` | `{ "model": "provider/model" }` ne renvoie que des faits connus ; ni taille de fichier, ni empreinte, ni modèle de prompt, ni licence. |
| `POST /api/chat` | Conversation avec des messages `system`, `user`, `assistant` et `tool`. |
| `POST /api/generate` | Une seule invite, avec un `system` facultatif. |

Tous les autres chemins `/api/*` restent dans l'API de gestion d'opencodex.

## Champs de requête pris en charge

- `model` : un nom renvoyé par `/api/tags`.
- `stream` : `true` par défaut (JSON délimité par des sauts de ligne). Indiquez `false` pour une seule réponse JSON.
- `images` : PNG, JPEG, GIF ou WebP en base64 sur les messages utilisateur (chat) ou sur la requête (generate).
- `tools` (chat uniquement) : outils de type fonction. Renvoyez le message assistant tel quel, y compris
  l'`id` de chaque appel ; un résultat `tool` est associé par `tool_call_id` ou, à défaut, par `tool_name`.
- `options` : `temperature`, `top_p`, `num_predict` et `stop`.
- `format` : uniquement `"json"`.

Chaque requête `/api/chat` accepte au maximum **1 024 appels d’outils au total** dans l’ensemble des messages
assistant, y compris ceux qui ont déjà un résultat. Au-delà, elle renvoie HTTP 400 avant d’atteindre
un fournisseur. Raccourcissez l’historique de la conversation et renvoyez-le, en conservant chaque
résultat d’outil avec l’appel correspondant dans le message assistant.

Tout le reste est refusé avec un HTTP 400 au lieu d'être ignoré : `think`, `keep_alive`, `suffix`, `raw`,
`template`, `context`, les autres `options`, un `format` en schéma JSON et les URL d'images. Les points de
terminaison Ollama de gestion des modèles et d'embeddings ne sont pas fournis.

Les combos, les politiques de routage, les alias `--fast` ou d'effort, et les fournisseurs qui transmettent les
identifiants de l'appelant ne peuvent pas être sélectionnés ici. Ces requêtes échouent avant tout envoi en amont.

## Réponses

Une réponse terminée porte `done: true` avec un `done_reason` valant `stop`, `tool_calls` ou `length`.
`prompt_eval_count` et `eval_count` apparaissent lorsque le fournisseur a signalé l'usage ; les champs de durée
ne sont pas renseignés. Un flux envoie exactement une ligne `done: true`, une fois la réponse amont entièrement terminée.

Les erreurs utilisent la forme Ollama `{ "error": "message" }` et conservent le statut HTTP, y compris
`Retry-After` pour les limites de débit et les refus pour surcharge. Une réponse interrompue par un filtre de contenu
ou pour une raison inconnue est renvoyée comme erreur, jamais comme un arrêt normal. Si un flux échoue après avoir
commencé, sa dernière ligne est un objet `error` et aucune ligne `done: true` ne suit.

Les requêtes apparaissent dans le journal des requêtes du tableau de bord comme le reste du trafic, et l'en-tête
de réponse `x-opencodex-request-id` désigne la ligne correspondante.
