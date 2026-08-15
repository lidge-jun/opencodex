---
title: Formats de l’API proxy
description: Référence au niveau du fil pour les réponses, Chat Completions, Anthropic Messages, le catalogue de modèles, WebSocket, le temps réel et les surfaces de compactage.
---

opencodex présente un proxy local dans plusieurs dialectes clients. Un client Codex peut parler le
Responses API, une application compatible avec OpenAI peut parler Chat Completions, et Claude Code peut parler
Anthropic Messages sans exiger que chaque fournisseur en amont implémente chaque format.

Le chemin de traduction normal est :

```text
client dialect → internal Responses model → provider adapter → provider wire format
provider events → internal adapter events → client dialect
```

La représentation Réponses est le centre du pont. Les itinéraires compatibles natifs peuvent sauter des parties
de la traduction et transmettre une demande, mais l'authentification, le routage, le contrôle d'admission et
la sécurité des réponses se produit toujours à la limite du proxy. Configurez les clés d'écoute et d'admission dans
[Configuration](/fr/reference/configuration/); utilisez [Combos](/fr/guides/combos/) lorsqu'un identifiant de modèle public
doit choisir parmi plusieurs cibles.

## Présentation du point de terminaison

| Espace client | Point de terminaison | Résultat non-stream réussi | Résultat de flux ou de socket réussi |
| --- | --- | --- | --- |
| OpenAI Réponses | `POST /v1/responses` | Réponses JSON | Réponses SSE, ou Réponses JSON encadrés de texte sur WebSocket |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `chat.completion` JSON | `chat.completion.chunk` SSE se terminant par `[DONE]` |
| Anthropic Messages | `POST /v1/messages` | Anthropic `message` JSON | Anthropic Messages SSE |
| Comptage des jetons Anthropic | `POST /v1/messages/count_tokens` | `{ "input_tokens": number }` | Sans objet |
| Découverte de modèles | `GET /v1/models` | L'un des trois contrats du catalogue | Sans objet |
| Voix et temps réel | `POST /v1/live`, `POST /v1/realtime/calls` | Réponse de création d'appel relayée | Une bande latérale séparée WebSocket relaie les trames dans les deux sens |
| Compactage des réponses | `POST /v1/responses/compact` | Historique de remplacement JSON | Sans objet |

## `POST /v1/responses`

Il s'agit de la forme native du plan de données opencodex. Le corps de la requête doit être un objet JSON avec un
non vide `model`. `input` peut être une chaîne ou un tableau d'éléments de réponses.

### Champs de demande acceptés

| Zone | Forme acceptée |
| --- | --- |
| Modèle et entrée | Requis non vide `model` ; chaîne facultative `input` ou un tableau d'éléments |
| Éléments de message | messages `user`, `developer`, `system` et `assistant` ; contenu de chaîne ou blocs de contenu typés appropriés au rôle |
| Blocs de contenu | Texte, images d'entrée, fichiers d'entrée, texte de sortie, refus et blocs de raisonnement summary/text là où leur élément parent le permet |
| Historique de l'outil | Articles `function_call`, `function_call_output`, `custom_tool_call` et `custom_tool_call_output` |
| Outils | Outils de fonction et entrées d'outils libres intégrées ou hébergées ; `tool_choice` accepte les choix `auto`, `none`, `required`, nommés function/custom, hébergés ou `allowed_tools` |
| Raisonnement | `reasoning.effort` et `reasoning.summary` (`auto`, `concise`, `detailed` ou `none`) |
| Poursuite et mise en cache | `previous_response_id`, `store` et `prompt_cache_key` |
| Contrôles de génération | `max_output_tokens`, `temperature`, `top_p`, `stop`, `presence_penalty` et `frequency_penalty` |
| Service et exécution | `stream`, `service_tier`, `parallel_tool_calls`, `instructions`, `metadata` et `user` |
| Champs de réponses étendues | `background`, `include`, `prompt`, `text` et `truncation` sont acceptés pour les itinéraires compatibles |

Les types d’éléments inconnus sont acceptés en tant qu’éléments typés librement pour des raisons de compatibilité ascendante. Adaptateurs traduits
ne traitent que les types d’éléments qu’ils reconnaissent et peuvent rejeter une fonctionnalité que leur fournisseur ne peut pas représenter.

### Sortie JSON et SSE

Avec `stream: true`, la réponse est `text/event-stream`. Le pont émet des événements de réponses tels que
`response.created`, les éléments de sortie et les deltas de texte/d’outil, puis exactement un événement terminal
événement `response.completed`, `response.failed` ou `response.incomplete`. Un flux normal se termine par
`data: [DONE]`.

Avec `stream: false` ou pas de `stream`, les mêmes événements d'adaptateur sont collectés dans une seule réponse JSON
objet. Les deux formulaires préservent le modèle sélectionné, les éléments de sortie, l'état du terminal et l'utilisation.

Les trames SSE des réponses destinées au client sont limitées à 4 Mio par trame, mesuré en octets bruts avant la
SSE délimiteur de bloc. Sur HTTP, une trame amont non terminée qui dépasse la limite échoue fermée
avec un événement synthétique `response.failed` suivi de `data: [DONE]`. Sur les réponses WebSocket
pont, la même condition émet un 502 `websocket_protocol_error` et annule le lecteur amont.
Une trame de terminal de réponses complète fait autorité : octets de fin surdimensionnés ou mal formés après
ce terminal est abandonné plutôt que de remplacer le tour terminé par un échec de transport.

Pour le streaming canonique ChatGPT forward, stable Bun 1.4.0 ou plus récent peut utiliser de manière transparente
Le transport WebSocket amont de Codex. Bun 1.3.14 groupés, versions préliminaires et runtime invérifiable
les identités utilisent HTTP/SSE. L'adaptateur WS en amont conserve le même contrat SSE en aval, plafonne les deux
la trame JSON brute et son enveloppe SSE à 4 MiB, et ferme l'amont lorsque sa file d'attente d'octets 8 MiB
déborderait. Ce débordement émet un événement terminal en aval `response.failed` suivi de
`[DONE]`.

Chaque objet d'utilisation des réponses du terminal inclut les deux objets de détail, même si le fournisseur ne l'a pas fait.
signaler ces détails :

```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "total_tokens": 0,
  "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 0 }
}
```

Lorsqu'il est disponible, `input_tokens_details` peut également inclure `cache_write_tokens`. Le toujours présent
les objets de détail constituent une garantie de compatibilité pour les clients Responses stricts ; zéro peut signifier « non
signalé », pas nécessairement « le prestataire n’a effectué aucun travail de ce type ».

### Mise à niveau WebSocket sur le même chemin

Lorsque `websockets` est activé, un client peut mettre à niveau `/v1/responses` au lieu d’ouvrir une requête HTTP POST.
L'authentification et l'admission de l'origine se produisent lors de la poignée de main WebSocket. Ils ne se répètent pas
dans chaque trame.

Cette mise à niveau orientée client est distincte de la sélection transparente en amont ChatGPT WebSocket
décrit ci-dessus ; le paramètre `websockets` contrôle uniquement le point de terminaison côté client.

Le client envoie JSON blocs de texte :

```json
{
  "type": "response.create",
  "model": "provider/model",
  "input": "Hello",
  "tools": [],
  "generate": true
}
```

Tout sauf `type` devient le corps de la requête Réponses et le proxy force le streaming pour le
tourner. Un nouveau `response.create` remplace et annule le tour précédent sur cette prise.
`response.processed` est accepté comme un accusé de réception de non-opération. Types de trames non analysables ou sans rapport
sont ignorés.

Les frames du serveur sont des frames de texte JSON. Une sortie diffusée en continu réussie utilise les mêmes charges utiles JSON que
apparaîtrait en SSE `data:` lignes, sans l'enveloppe SSE ni `[DONE]`. Un interne sans streaming
le résultat est recadré en `response.created`, zéro ou plus `response.output_item.done` images, puis un
trame terminale. Les erreurs utilisent cette enveloppe :

```json
{
  "type": "error",
  "status": 502,
  "error": {
    "type": "upstream_error",
    "message": "..."
  },
  "headers": {}
}
```

Une trame d'échauffement avec `generate: false` n'appelle pas d'amont. Il renvoie un synthétique
`response.created` suivi de `response.completed`, tous deux avec un identifiant de réponse vide et aucune sortie.

:::note
Lorsque les WebSockets sont désactivés, une tentative de mise à niveau reçoit HTTP 426 avec le code
`upgrade_required`. Codex traite ce résultat de poignée de main comme un signal de retour à HTTP pour le
session. Il ne s’agit pas d’un échec du modèle routé.
:::

## `POST /v1/chat/completions`

Ce point de terminaison accepte compatible avec OpenAI Chat Completions requêtes avec un `model` requis et un
tableau `messages` non vide. Il traduit les messages du système, de l'utilisateur, de l'assistant et de l'outil en messages internes.
Éléments de réponses ; traduit les outils fonctionnels, le choix des outils, les images, l'effort de raisonnement et les éléments pris en charge
formats de réponse ; exécute le pipeline de routage de réponses normal ; puis traduit le résultat.

Le raisonnement fait partie de cette traduction. `reasoning_effort` (ou `reasoning.effort`) devient
interne `reasoning.effort`. Parce que l'analyseur de réponses cache la pensée à moins que
`reasoning.summary` est défini et n'est pas `none`, Chat Completions requêtes qui demandent un
l’effort est par défaut `reasoning.summary: "auto"`, donc la réflexion revient au fur et à mesure
`delta.reasoning_content`. Les clients peuvent toujours masquer les traces avec `include_reasoning: false` ou
`reasoning.summary: "none"`. Un `reasoning.summary` explicite de `auto`, `concise`,
`detailed`, ou `none` l'emporte sur `include_reasoning`.

La sortie structurée fait partie de cette traduction : `response_format` avec `json_object` ou
`json_schema` est transmis aux modèles `openai-chat` acheminés. Sur `POST /v1/responses` le
le champ de requête équivalent est `text.format` : les routes de réponses natives le conservent dans le brut
Corps des réponses, et il est traduit en `response_format` lorsque le modèle achemine vers un
`openai-chat` fournisseur. Un modèle répertorié dans le `noStructuredOutputModels` du fournisseur omet
`response_format` sur ce protocole ; les modèles apparentés conservent la traduction. Les services en amont non classés
recevoir le champ et renvoyer sa propre erreur au lieu que le proxy devine sa capacité.

La sortie sans streaming a `object: "chat.completion"`. La sortie streaming utilise des objets SSE avec
`object: "chat.completion.chunk"`, choix deltas, un choix terminal avec `finish_reason`, et
`data: [DONE]`. Les informations d'appel d'outil et d'utilisation sont traduites là où les événements source sont transportés.
eux.

Étant donné que le chemin d'exécution interne est basé sur les réponses, un adaptateur de fournisseur peut imposer un chemin d'exécution plus étroit.
ensemble de fonctionnalités. Par exemple, une fonctionnalité de demande qui ne peut pas être représentée par l'adaptateur sélectionné est
renvoyé comme une erreur au lieu de changer silencieusement sa signification.

## `POST /v1/messages` et `count_tokens`

Ces points de terminaison parlent le dialecte Anthropic Messages utilisé par Claude Code et les clients compatibles.
La plupart des requêtes sont traduites en réponses, acheminées normalement, puis retraduites en Anthropic JSON
ou Anthropic SSE.

Le relais Anthropic natif n'est éligible que lorsque tous les éléments suivants sont vrais :

- le passthrough natif n'a pas été désactivé dans la configuration Claude Code ;
- le modèle demandé commence par `claude` ou `anthropic` ;
- la demande porte un porteur natif Anthropic ou un titre `x-api-key` ;
- sur un écouteur sans bouclage, la requête porte également une admission proxy valide uniquement dans
  `x-opencodex-api-key` ; et
- aucun alias configuré ou carte de modèle ne revendique cet identifiant de modèle pour une cible acheminée.

Une demande éligible est transmise dans le dialecte Anthropic donc les en-têtes bêta natifs, en pensant
les signatures et l'identité de l'abonnement restent bout à bout. Sinon il faut les réponses
aller-retour.

L’en-tête d’admission dédié n’est jamais transmis. Les secrets d’admission du proxy trouvés dans
`Authorization` ou `x-api-key` sont également supprimés ; un justificatif d'identité Anthropic authentique distinct est
préservé. Les en-têtes d'informations d'identification ambigus joints par des virgules échouent lorsqu'ils sont fermés au lieu d'être transmis.

`POST /v1/messages/count_tokens` suit la même résolution de modèle et la même décision de passthrough. Un
La requête éligible en mode natif est transmise au point de terminaison de comptage de Anthropic. D'autres demandes utilisent le local
estimation documentée du contenu du système, des messages et des outils et retour :

```json
{ "input_tokens": 123 }
```

## `GET /v1/models`

Le même itinéraire dessert trois clients qui attendent des enveloppes de catalogue incompatibles.
La variante Anthropic est prioritaire, sauf si `client_version` est également présent.

| Contrat | Déclencheur | Forme de niveau supérieur | Comportement de l’identifiant du modèle |
| --- | --- | --- | --- |
| Anthropic liste des modèles | `anthropic-version` en-tête ou `?flavor=anthropic`, sans `client_version` | `{ "data": [...] }` avec Anthropic entrées d'informations sur le modèle | Claude Code reçoit des identifiants lisibles ; Desktop peut recevoir sa famille d'alias spécifique au profil |
| Codex catalogue | `client_version` paramètre de requête | `{ "models": [...] }` | Les entrées natives et routées contiennent les champs de catalogue Codex les plus riches, la visibilité, l'effort, WebSocket et les métadonnées multi-agents |
| Liste simple OpenAI | Ni l'un ni l'autre déclencheur | `{ "object": "list", "data": [...] }` | Les identifiants natifs visibles sont nus ; les identifiants routés sont des alias ou `provider/model` |

## `POST /v1/live` et bande latérale en temps réel

`POST /v1/live` accepte la surface de création d'appel ChatGPT/Codex App sans cadre.
`POST /v1/realtime/calls` accepte la surface de création d'appel OpenAI Realtime. opencodex sélectionne un
route OpenAI-family éligible, normalise la demande de création d'appel pour l'authentification en amont
mode et relaie la réponse limitée.

Après la création de l'appel, les clients peuvent rejoindre une bande latérale WebSocket en utilisant n'importe quel formulaire entrant pris en charge :

- `/v1/live/{callId}`
- `/v1/realtime/calls/{callId}`
- `/v1/realtime?call_id={callId}`

Le proxy normalise la jointure amont URL puis relaie de manière transparente le texte et les trames binaires dans
les deux sens. Les en-têtes du protocole client sont conservés tandis que l'authentification en amont demeure
appartenant à un mandataire.

## `POST /v1/responses/compact`

Le compactage renvoie l'historique des remplacements pour les clients qui doivent raccourcir une réponse longue.
conversation.

| Type d'itinéraire | Comportement |
| --- | --- |
| Voie canonique ChatGPT ou officielle OpenAI | Transfère la demande au point de terminaison `/responses/compact` natif avec le compte résolu et l'authentification du modèle |
| Autre modèle routé | Exécute un tour de compactage interne, sans flux et sans outils avec un `compaction_trigger` ; nécessite exactement un élément `compaction` synthétique dont `encrypted_content` est une enveloppe `ocx1:` ; décode ce résumé dans l'historique de remplacement de la v1 |

Les réponses compactes natives sont mises en mémoire tampon avec un maximum de 32 Mio, y compris les réponses dont
`Content-Length` dépasse déjà la limite. Les échecs spécifiques au compact incluent :

| Statut | Type ou code | Signification |
| --- | --- | --- |
| 400 | `invalid_request_error` | JSON/forme du corps invalide ou modèle manquant |
| 404 | `invalid_request_error` | Le modèle demandé ne peut pas être acheminé |
| 499 | `client_cancelled` | Le client a annulé lors du transfert ou de la mise en mémoire tampon |
| 502 | `compact_response_too_large` | Sortie compacte native dépassée 32 MiB |
| 502 | `upstream_error` | Échec du tour de connexion, de lecture ou de compactage synthétique |
| 502 | `invalid_response_error` | Le tour synthétique n’a pas produit exactement un élément de compactage `ocx1:` valide et non vide |

## Matrice d'authentification

Sur une liaison de bouclage uniquement, l’admission au plan de données ne nécessite pas de clé configurée. Lors d'une liaison à distance,
utilisez la matrice ci-dessous. « Dédié » signifie `X-OpenCodex-API-Key` ; les autres colonnes signifient
`Authorization: Bearer ...` et `x-api-key`.

| Surfaces | Dédié | Porteur | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` HTTP et WebSocket | Obligatoire | Rejeté pour l’admission au proxy | Rejeté |
| `/v1/responses/compact` | Obligatoire | Rejeté pour l’admission au proxy | Rejeté |
| `/v1/chat/completions` | Obligatoire | Rejeté pour l’admission au proxy | Rejeté |
| `/v1/messages` et `/v1/messages/count_tokens` | Accepté | Accepté | Accepté |
| `/v1/models` | Accepté | Accepté | Accepté |
| `/v1/live`, `/v1/realtime/calls` et jointures de bande latérale | Accepté | Accepté | Accepté |

Réponses-famille et demandes de chat réservées `Authorization` au fournisseur ou Codex Direct
passthrough, donc une clé proxy distante doit utiliser l'en-tête dédié. Messages et surfaces en temps réel
ont besoin d’une compatibilité client plus large et acceptent donc les trois formes.

:::caution
Les clés du plan de données ne sont pas des informations d’identification de gestion. La gestion API utilise un secret d'administration distinct ;
voir [Gestion API](/fr/reference/management-api/). Ne réutilisez jamais un secret pour les deux avions.
:::

## Vocabulaire d'erreur courant

Les erreurs utilisent l'enveloppe du dialecte client lorsque cela est nécessaire, mais ces significations status/code sont stables :

| Statut | Type ou code | Signification |
| --- | --- | --- |
| 401 | `authentication_error` | Un identifiant requis pour l’admission au proxy est manquant ou invalide |
| 403 | `origin_rejected` | Une demande de plan de données Réponses/OpenAI ou une mise à niveau WebSocket provient d'une origine non autorisée |
| 503 | `combo_unavailable` | Chaque cible du combo sélectionné est indisponible, en temps de recharge, désactivée ou autrement inéligible |
| 400 | `unreadable_encrypted_agent_task` | Une tâche de travail v2 chiffrée n'a pas de cible native éligible pouvant la consommer |
| 426 | `upgrade_required` | Le transport Réponses WebSocket est désactivé ou la mise à niveau a échoué ; utiliser HTTP |

Les échecs d'origine Anthropic sont restitués dans l'enveloppe d'erreur de Anthropic, donc le rejet d'origine est un
403 `permission_error` sur ce dialecte plutôt que sur le corps `origin_rejected` de style OpenAI.

## Hygiène du contenu crypté

Le proxy traite le véritable texte chiffré du backend comme opaque. Le texte chiffré structurellement valide est préservé
octet par octet : opencodex ne le déchiffre pas, ne traduit pas son contenu et ne le rechiffre pas pour un autre
fournisseur.Certains hooks d'agent ont historiquement placé le texte de contrôle en clair dans un emplacement `encrypted_content`.
Pour des raisons de compatibilité, le proxy sépare ce texte brut en parties de texte tout en conservant tout
Fernet structurellement valide fonctionne inchangé. Si un `agent_message` perd toutes les parties chiffrées pendant
cette réparation, cela devient un message utilisateur normal. Si une tâche v2 actuelle reste véritablement chiffrée
mais la cible routé sélectionnée ne peut pas lire le texte chiffré natif ChatGPT, opencodex échoue avec
`unreadable_encrypted_agent_task` au lieu d'envoyer des octets illisibles à ce fournisseur. Voir
[Surface du sous-agent](/fr/guides/sub-agent-surface/) pour le comportement du client autour des tâches des travailleurs.
