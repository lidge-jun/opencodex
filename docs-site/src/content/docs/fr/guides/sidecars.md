---
title: "Services auxiliaires : recherche web et vision"
description: Dotez les modèles routés d’une véritable recherche web et donnez aux modèles textuels une compréhension des images grâce à des services auxiliaires ChatGPT natifs.
---

Tous les modèles routés ne proposent pas une **recherche web** hébergée ni une **entrée d’image** native. opencodex complète
ces capacités au moyen de deux services auxiliaires. Chacun peut s’appuyer sur un fournisseur connecté à ChatGPT (`forward`) ou sur un
fournisseur Anthropic OAuth enregistré ; la recherche web peut aussi utiliser un OAuth Grok enregistré via le moteur `xai` explicite. Les erreurs des services auxiliaires sont converties en résultats d’outil limités ou en marqueurs d’image,
au lieu de faire échouer l’intégralité du tour.

:::note[Sélection automatique du moteur]
Une valeur `backend` explicite est prioritaire. Sans valeur, la recherche web utilise toujours `openai` ; Vision utilise
`anthropic` si un compte OAuth Anthropic utilisable existe, sinon `openai`. Une sélection explicite de
`anthropic` ou `xai` sans identifiants utilisables échoue sans repli. `openai` exige à la fois une connexion ChatGPT et un
fournisseur `forward` actif.
:::

## Service auxiliaire de recherche web

Lorsque Codex demande un hébergement `web_search` pour un modèle routé sans passage, opencodex :

1. **Supprime** l'outil hébergé `web_search` et expose à sa place un outil de fonction synthétique `web_search(query)`
   au modèle routé. Les options de l'outil hébergé d'origine sont conservées pour l'appel du service auxiliaire.
2. Exécute le modèle routé dans une petite **boucle d'agent**. Lorsqu'il appelle `web_search`, opencodex utilise le
   moteur du service auxiliaire sélectionné : OpenAI exécute l'outil hébergé `web_search` avec `gpt-5.6-luna` par défaut ;
   Anthropic exécute `web_search_20250305` avec `claude-sonnet-5` par défaut. La réponse en streaming et
   les citations deviennent le résultat d’un outil. xAI exécute `web_search` avec `grok-4.6` par défaut et ajoute
   `x_search` à la même requête lorsque `xSearch.enabled` vaut true.
3. **Répète la boucle** jusqu'à ce que le modèle réponde ou que le nombre total de recherches réelles atteigne `maxSearchesPerTurn`
   (par défaut 3), supprime ensuite l'outil de recherche et force une réponse finale. De vrais outils clients tels que
   `apply_patch` ou le shell mettent fin au tour afin que ces appels parviennent à Codex.

Chaque itération du modèle routé envoie `stream: true` en amont, mais, par défaut, opencodex met entièrement
en mémoire tampon les événements sémantiques avant de décider s'il faut lancer une recherche ou renvoyer la réponse finale.
Seuls les en-têtes et le statut du tour final, ainsi que les réponses 429 de la première itération, sont traités immédiatement. Ainsi,
les appels de recherche synthétiques et les résultats préliminaires ne sont jamais exposés comme sorties du modèle visibles par le client.

L'activation explicite de `webSearchSidecar.streamRoutedModelOutput` (`false` par défaut) diffuse à la place les principaux deltas
de texte et de raisonnement de chaque itération. Le client voit la sortie dès que le modèle la produit, comme sur le chemin sans service auxiliaire.
Cette fenêtre de diffusion se ferme définitivement à la limite du premier appel d'outil : la décision d'intercepter `web_search` reste donc
atomique et aucun contenu n'est livré deux fois, puisque la relecture terminale ignore ce qui a déjà été diffusé. En contrepartie, le texte
émis par le modèle *avant* sa décision de lancer une recherche — texte que le mode avec tampon supprime silencieusement — devient visible
et peut être partiellement répété dans la réponse qui suit la recherche. La page Vue d'ensemble du tableau de bord expose ce réglage sous
**Diffuser les réponses en direct** dans la carte du service auxiliaire de recherche web (`PUT /api/sidecar-settings` avec
`webSearch.streamRoutedModelOutput`).

Les commentaires Kiro sont indépendants de cette option : en mode avec tampon, le texte de la phase de commentaire est déjà diffusé
avant l'événement terminal. Ce traitement reste inchangé avec ou sans `streamRoutedModelOutput` ; seuls les événements nécessaires
à la décision de recherche — les appels d'outils et tout ce qui suit la limite du premier appel — restent dans le tampon afin que la
décision concernant `web_search` demeure atomique.

Le résultat injecté est enveloppé dans une limite de données non fiables, limité en longueur et dédupliqué par
URL source. Dans les tours à sortie structurée (`json_schema` / `json_object`), il est fourni sous une forme compacte
plutôt qu'en prose. Pour les modèles routés limités au texte, le modèle de recherche doit également décrire
les images pertinentes et inclure leurs URL sources.

```json
{
  "webSearchSidecar": {
    "enabled": true,
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 200000,
    "streamRoutedModelOutput": false
  }
}
```

Le niveau de raisonnement `minimal` n'est pas utilisé, car le moteur hébergé rejette les outils à ce niveau. Une recherche
échouée est renvoyée au modèle routé sous la forme d'un résultat d'erreur borné, ce qui lui permet de répondre à partir du
contexte qu’il a déjà.

Quatre délais distincts s'appliquent. `stallTimeoutSec` est le délai de base pour les événements et les blocages du pont.
`connectTimeoutMs` (`200000` par défaut) couvre uniquement DNS, TCP, TLS et la réception des en-têtes de réponse.
Le réglage réservé au fichier de configuration `webSearchSidecar.routedModelStallTimeoutMs` (`200000` par défaut, entier
`1..2147483647`) limite l'inactivité continue des octets de réponse brute pour chaque itération du modèle routé et
se réinitialise à chaque octet non vide. `webSearchSidecar.timeoutMs` limite séparément une requête de recherche hébergée.
Le délai de surveillance effectif du pont vaut
`max(base stall, connect timeout, routed-model stall, sidecar timeout) + 30 seconds`. Le délai d'inactivité du modèle routé
n'est pas un délai total de génération. Les échecs antérieurs au démarrage du flux SSE renvoient une réponse JSON non-2xx ;
les échecs de génération postérieurs à l'envoi des en-têtes sont transmis sous la forme d'un événement SSE `response.failed`.

## Service auxiliaire de vision

Lorsque le modèle routé est répertorié dans le `noVisionModels` de son fournisseur et qu'une requête porte une image,
opencodex décrit chaque image **avant** l'appel principal et la remplace par du texte. Quand
si `visionSidecar.model` est absent ou vide, le chemin d'exécution OpenAI, le tableau de bord et l'API de gestion
utilisent le modèle de repli `gpt-5.4-mini`. Au démarrage, une ancienne valeur `gpt-5.4-mini` explicitement enregistrée
est toujours migrée vers `gpt-5.6-luna` ; cette migration s'applique à une valeur stockée, et non à l'absence du
champ du modèle.

- Les images peuvent provenir de messages utilisateur, développeur et de résultats d’outils, y compris de `view_image` dans Codex.
- Sur le chemin OpenAI (ChatGPT-login passthrough), chaque image est envoyée au modèle de vision configuré
  au point de terminaison Responses avec la valeur `reasoning.effort` sélectionnée (`low` par défaut) ; sa
  description remplace l'image en ligne. Le chemin Anthropic utilise le point de terminaison Messages avec sa
  propre correspondance entre réflexion et budget, et ignore ce paramètre propre à OpenAI.
- Pour les modèles natifs dont les capacités sont connues, un niveau de raisonnement non pris en charge est ramené au
  niveau pris en charge le plus élevé qui ne dépasse pas la valeur demandée ; s'il n'en existe aucun, le niveau pris en charge le plus bas
  est utilisé. Les modèles inconnus ou personnalisés restent permissifs en l'absence de métadonnées fiables sur leurs capacités.
- Les descriptions s'exécutent avec une concurrence limitée (3 à la fois, dans l'ordre des entrées). Le contexte utilisateur envoyé
  au modèle de description est limité à 800 caractères, et chaque description injectée à 2 000
  caractères. La requête n'envoie pas `max_output_tokens`, que le moteur ChatGPT rejette.
- Les URL des images sont validées avant transfert : les URL des données doivent utiliser `png` / `jpeg` / `jpg` / `webp` /
  `gif` et les données base64 sont limitées à environ 20 Mo. Seuls les schémas `data:` et `https:` sont acceptés ;
  les images distantes `https` sont récupérées par le moteur OpenAI, et non par le proxy.
- La correspondance `noVisionModels` ignore un suffixe `:size` de style Ollama, donc une entrée `gpt-oss` couvre également
  `gpt-oss:120b`.
- Si la description échoue, le modèle reçoit un bref marqueur d'erreur de traitement. Si aucun service auxiliaire n'est
  disponible, l'image brute est supprimée plutôt que transmise à un moteur limité au texte.
- `maxDescriptionsPerTurn` (8 par défaut) limite les nouvelles descriptions par tour du modèle principal. Les résultats du cache et
  les doublons au même tour ne le consomment pas. Les descriptions d'images `data:` réussies sont mises en cache par
  moteur, modèle, niveau de détail, octets de l'image et contexte du message — ainsi que l'effort de raisonnement dans les
  clés OpenAI (les clés Anthropic l'omettent, puisque ce champ y est ignoré) ; les images `https:` modifiables ne sont pas
  mises en cache.

L'API de gestion et le sélecteur du tableau de bord répertorient désormais les modèles qui peuvent réellement accepter des images.
Lorsque le moteur correspondant est disponible, `gpt-5.6-luna` (OpenAI) et `claude-haiku-4-5` (Anthropic)
sont toujours proposés comme options de base. `PUT /api/sidecar-settings` rejette un modèle connu pour être
texte uniquement, mais accepte toujours un identifiant inconnu afin que les noms personnalisés ou en avance sur le catalogue continuent de fonctionner.

```json
{
  "visionSidecar": {
    "enabled": true,
    "backend": "openai",
    "model": "gpt-5.6-luna",
    "reasoning": "medium",
    "maxDescriptionsPerTurn": 8,
    "timeoutMs": 45000
  }
}
```

Un modèle est marqué en texte uniquement par fournisseur :

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  }
}
```

## Contrôles du tableau de bord et désactivation

La carte Vision du tableau de bord permet d'activer ou de désactiver le service auxiliaire, de définir
`maxDescriptionsPerTurn` et `timeoutMs`, ainsi que de régler le modèle, le moteur
et le raisonnement. La désactivation du service auxiliaire ne supprime pas ces
paramètres ; sa réactivation conserve le modèle, le moteur, le niveau de raisonnement,
le délai d'attente et la limite précédemment choisis.

`PUT /api/sidecar-settings` accepte les mêmes champs. Les mises à jour partielles laissent
les clés omises inchangées. `timeoutMs` utilise les limites entières de l'environnement d'exécution
(1–2147483647 ms).

Vous pouvez toujours définir `enabled: false` dans `config.json` si vous préférez modifier le
fichier directement. La recherche et la description d'images avec OAuth Anthropic réutilisent les identifiants
Claude Code existants du magasin d'empreintes précédent. Testez néanmoins ce comportement avec le
compte et la charge de travail prévus.

Consultez la [Référence de configuration](/fr/reference/configuration/server/#services-auxiliaires) pour chaque champ.
