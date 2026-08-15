---
title: Pont Factory Droid
description: Connectez les modèles Factory Droid à OpenCodex au moyen d’un pont local compatible avec Responses.
---

Factory Droid est un environnement d’exécution d’agents, et non un point de terminaison d’inférence compatible avec OpenAI et documenté. Si un fournisseur personnalisé qui pointe vers une URL interne de Factory LLM renvoie `403 Forbidden`, modifier uniquement l’adaptateur OpenCodex ou ajouter des en-têtes de fournisseur ne transforme pas cette route privée en API publique prise en charge.

L’intégration fonctionnelle est la suivante :

```text
Client Responses en texte seul
  -> OpenCodex (http://127.0.0.1:10100/v1/responses)
  -> pont Responses local (http://127.0.0.1:11435/v1/responses)
  -> commande officielle droid exec
  -> compte Factory et modèle sélectionné
```

Ainsi, l’identifiant Factory reste dans le client Droid officiel. OpenCodex reçoit un jeton distinct, limité au pont local.

## Échecs possibles et causes

| Symptôme | Cause | Correction |
| --- | --- | --- |
| `403 Forbidden` depuis une URL Factory LLM | Cette URL n’est pas un point de terminaison OpenAI général documenté pour les clients tiers | Appelez Factory au moyen du CLI ou du SDK Droid officiel |
| `404` sur `/models/models` | L’URL de base du fournisseur se terminait déjà par `/models` | Utilisez la racine de l’API comme `baseUrl` ; n’y incluez jamais le chemin de découverte |
| La recherche de modèles échoue | Le pont n’expose pas de catalogue dynamique complet | Définissez `liveModels: false` et fournissez une liste `models` statique |
| Le fournisseur local est rejeté | L’accès au réseau privé est refusé par défaut | Définissez `allowPrivateNetwork: true` uniquement pour le pont local |
| `${DROID_BRIDGE_TOKEN}` n’est pas résolu | La variable est absente de l’environnement du service OpenCodex | Injectez-la dans le processus de service, pas seulement dans un terminal interactif |
| `OutputTextDelta without active item` | Le pont a émis un delta de texte avant d’ouvrir un élément de sortie et une partie de contenu | Émettez dans l’ordre le cycle de vie SSE Responses complet |

Le même identifiant Factory peut donc fonctionner avec `droid exec` alors qu’une requête directe vers une URL LLM non documentée renvoie toujours `403`. Ces résultats testent des produits différents et ne sont pas contradictoires.

## Prérequis

1. Installez le [CLI Droid](https://docs.factory.ai/droid-cli/quickstart) et connectez-vous.
2. Vérifiez qu’une requête non interactive et bornée fonctionne :

   ```bash
   droid exec --model glm-5.2 --output-format json "Reply with DROID_OK only."
   ```

3. Exécutez un pont local qui appelle `droid exec` (ou le SDK Droid officiel) et expose :

   - `GET /healthz`
   - `GET /v1/models`
   - `POST /v1/responses`

Factory présente `droid exec` comme son interface d’automatisation non interactive et recommande la sortie JSON pour les scripts. Pour une intégration de plus longue durée, Factory documente également le flux JSON-RPC ainsi que les SDK TypeScript et Python officiels dans le [guide Droid Exec](https://docs.factory.ai/droid-exec/overview).

## Contrat du pont

Liez le pont à `127.0.0.1`, exigez un jeton porteur généré aléatoirement, limitez la taille des requêtes et autorisez explicitement les identifiants de modèle. Le pont minimal accepte uniquement les formes `input` Responses suivantes :

- une chaîne non vide ; ou
- un tableau composé uniquement d’éléments `message`. Chaque message doit avoir le rôle `user`, `developer`, `system` ou `assistant`, et contenir soit une chaîne, soit des parties de contenu textuelles (`input_text` pour les rôles d’entrée et `output_text` pour l’historique de l’assistant).

Validez la requête entière avant d’appeler Droid. Si une partie d’entrée est une image ou un fichier, si `tools` contient une définition d’outil, ou si `input` contient un appel ou un résultat d’outil (`function_call`, `function_call_output`, `custom_tool_call` ou `custom_tool_call_output`), renvoyez une réponse HTTP `400` avec une erreur `invalid_request_error` au format Responses. Utilisez un code propre au pont et stable, comme `unsupported_bridge_input`, et indiquez le champ rejeté dans le message. Faites-le avant de démarrer le flux SSE, même lorsque `stream: true` ; n’ignorez, ne sérialisez et n’aplatissez jamais le contenu non pris en charge dans le prompt.

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_bridge_input",
    "param": "tools",
    "message": "The minimal Droid bridge does not accept tool definitions."
  }
}
```

Pour une requête acceptée, le pont doit :

1. convertir l’`input` Responses accepté en prompt ;
2. appeler `droid exec --model <id> --output-format json <prompt>` ;
3. analyser les valeurs finales `result` et `session_id` ;
4. renvoyer une enveloppe OpenAI Responses ;
5. associer `previous_response_id` à l’identifiant de session Droid lorsqu’une continuation est requise.

Pour les réponses diffusées, émettez ce cycle de vie dans l’ordre :

```text
response.created
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

N’exposez pas le pont sur `0.0.0.0` et ne réutilisez pas l’identifiant Factory comme jeton porteur du pont.

## Configuration du fournisseur OpenCodex

Créez le fournisseur personnalisé avec l’identifiant explicite `droid` :

```bash
ocx provider add droid \
  --adapter openai-responses \
  --base-url http://127.0.0.1:11435/v1 \
  --default-model glm-5.2 \
  --allow-private-network
```

Cette commande crée l’entrée de configuration `providers.droid`. Dans le tableau de bord, ouvrez **Fournisseurs → droid → Modifier le JSON** et remplacez la valeur du fournisseur par :

```json
{
  "adapter": "openai-responses",
  "baseUrl": "http://127.0.0.1:11435/v1",
  "responsesPath": "/responses",
  "allowPrivateNetwork": true,
  "authMode": "key",
  "apiKey": "${DROID_BRIDGE_TOKEN}",
  "liveModels": false,
  "models": ["glm-5.2", "glm-5.2-fast", "kimi-k3"],
  "defaultModel": "glm-5.2"
}
```

Les identifiants de modèle ne sont que des exemples. Ne conservez que les modèles utilisables par `droid exec` avec le compte Factory connecté. N’ajoutez pas d’en-têtes d’inférence propres à Factory à ce fournisseur : son service en amont est le pont local, et non un point de terminaison HTTP Factory.

Après avoir enregistré un fournisseur ou modifié son catalogue statique, synchronisez puis redémarrez le serveur d’application Codex afin que les nouvelles sessions lisent le catalogue à jour :

```bash
ocx sync --restart-codex
ocx doctor
```

Le redémarrage des processus du serveur d’application Codex interrompt les travaux Codex actifs. Ne le lancez qu’après avoir terminé ou enregistré ces sessions.

## Vérifier la route complète

Vérifiez chaque frontière séparément :

```bash
curl -fsS http://127.0.0.1:11435/healthz
ocx doctor
ocx access test droid/glm-5.2 --protocol responses
```

La présence d’une ligne de fournisseur ou d’une entrée dans le sélecteur de modèles prouve uniquement la visibilité dans le catalogue. L’intégration ne fonctionne réellement qu’une fois la sonde Responses revenue par la route `droid/<model>`.

## Limitation actuelle

Le pont minimal décrit ci-dessus traduit le texte et le cycle de vie SSE Responses. Il n’implémente **pas** le protocole bidirectionnel complet des appels de fonctions et d’outils de Codex. Codex App et `codex exec` envoient normalement des définitions d’outils même si le prompt demande de ne pas appeler d’outil, et le CLI Codex actuel ne fournit aucun indicateur général pour les supprimer. Le pont minimal doit rejeter ces requêtes conformément au contrat `400` ci-dessus. Les définitions, appels et résultats d’outils, les autorisations, l’annulation et les événements Droid enrichis nécessitent un pont avec état fondé sur le mode de flux JSON-RPC de Factory ou sur un SDK Droid officiel. Considérez le succès de `ocx access test` comme une validation du chemin textuel, et non du chemin des agents ou des outils Codex.
