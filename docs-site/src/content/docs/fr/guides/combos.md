---
title: "Combos : basculement et équilibrage de charge"
description: Acheminez un modèle virtuel vers plusieurs fournisseurs pour un basculement ou un équilibrage de charge pondéré.
---

Un **combo** est un modèle virtuel placé devant une liste ordonnée de cibles fournisseur/modèle réelles. Le client
demande `combo/<id>` ; opencodex choisit une cible, réécrit la requête vers le sélecteur concret
`provider/model` et peut essayer une autre cible si la première rencontre un échec autorisant une nouvelle tentative.

Ceci est utile lorsque vous souhaitez :

- **Basculement :** privilégier un modèle tout en gardant des solutions de repli disponibles.
- **Équilibrage de charge :** répartir les requêtes réussies entre plusieurs modèles ou fournisseurs par lots pondérés.

Les combos interviennent en amont du routage normal des fournisseurs. Consultez d’abord [Routage des modèles](/fr/guides/model-routing/)
si vous ne connaissez pas encore les sélecteurs `provider/model`.

## Démarrage rapide en 60 secondes

Cet exemple crée `combo/main`, avec Anthropic en premier et OpenAI en second. Les deux fournisseurs doivent
déjà exister et être activés.

```bash
ocx combo set main --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol
```

La stratégie par défaut est le basculement, donc une requête normale est envoyée à
`anthropic/claude-opus-4-8`. Si cette tentative rencontre un échec autorisant une nouvelle tentative, opencodex peut basculer vers
`openai/gpt-5.6-sol`.

Utilisez le modèle virtuel partout où vous fourniriez normalement un identifiant de modèle :

```json
{
  "model": "combo/main",
  "input": "Explain why the sky looks blue."
}
```

Confirmez la définition enregistrée :

```bash
ocx combo show main
```

:::tip
Commencez par le basculement avec des pondérations égales. Passez au round-robin uniquement si vous souhaitez réellement
répartir le trafic, et n’ajoutez des pondérations que si une distribution uniforme ne convient pas.
:::

## Comment fonctionnent les noms de combos

L'identifiant du combo dans `ocx combo set <id>` doit commencer par une lettre ou un chiffre. Il peut alors contenir
lettres, chiffres, `.`, `_` ou `-`, jusqu'à 64 caractères au total. Son identifiant de modèle canonique est toujours
`combo/<id>` ; par exemple, id `main` devient `combo/main`.

L'espace de noms `combo/` est réservé pendant la configuration des combos. Un fournisseur nommé `combo` ne peut pas
l'occuper, et un identifiant combo ne peut pas dupliquer un nom de fournisseur configuré.

Un alias facultatif donne au combo un nom de modèle public différent. Un pseudonyme :

- utilise les mêmes caractères qu'un identifiant ;
- peut être nu, comme `daily-fast`, ou contenir un `/`, comme `team/daily-fast` ;
- ne peut pas être `combo` ni commencer par `combo/` ;
- ne peut pas dupliquer un autre alias de combo ; et
- ne peut normalement pas être un simple nom de famille OpenAI natif commençant par `gpt-`, `o1-`, `o3-`, `o4-`,
  ou `codex-`. Le mode de compatibilité explicite du bureau ci-dessous est la seule exception.

Même lorsqu'un alias est défini, la forme canonique `combo/<id>` est toujours résolue. Exécutions de recherche canonique
avant la correspondance d'alias, donc un alias ne peut pas reprendre l'identifiant canonique d'un autre combo.

:::note
Les alias modifient le nom public demandé par les clients ; ils ne changent ni l’identifiant enregistré du combo ni les
sélecteurs concrets fournisseur/modèle qui le composent.
:::

## Compatibilité avec la liste d’autorisation native de Codex Desktop

Certaines versions de Codex Desktop appliquent une liste d’autorisation `available_models` réservée aux modèles natifs après que
le serveur d’application a déjà chargé `model_catalog_json`. Des identifiants routés normaux tels que
`Nova1/codex-gpt-5.6-sol` restent alors utilisables dans la CLI, mais sont absents du sélecteur Desktop. Il s’agit du
[bogue de Codex Desktop](https://github.com/openai/codex/issues/19694) en amont, suivi dans
[opencodex #241](https://github.com/lidge-jun/opencodex/issues/241).

Lorsque vous contrôlez une cible routée équivalente, un combo peut explicitement reprendre un identifiant natif :

```bash
ocx combo set nova-sol \
  --targets Nova1/codex/gpt-5.6-sol \
  --alias gpt-5.6-sol \
  --native-alias \
  --display-name 'Nova1 - codex-gpt-5.6-sol'
```

Ce mode est délibérément activation explicite et nécessite à la fois `--native-alias` et une étiquette d'affichage non vide.
L’alias doit correspondre à l’un des identifiants de modèle natifs pris en charge par cette version ; un simple préfixe de
famille native n’est pas accepté, car la suppression doit pouvoir restaurer des métadonnées faisant autorité.
Lorsque la réponse de découverte de la cible routée ne fournit qu’un identifiant de modèle, la ligne de compatibilité complète
les métadonnées manquantes de contexte, de modalité et de raisonnement à partir de l’identifiant natif remplacé. Les limites explicites
de la cible restent prioritaires : ce mécanisme de repli n’augmente jamais un plafond de contexte et ne remplace aucune capacité déclarée.
Cela modifie la priorité de routage exacte : les demandes de `gpt-5.6-sol` se résolvent en `combo/nova-sol` avant
la route canonique de la famille native OpenAI. Le catalogue contient une seule ligne non qualifiée portant le libellé
d’affichage configuré, et non deux lignes, native et combo. Seul l’identifiant non qualifié `gpt-5.6-sol` est intercepté.
Lignes qualifiées par le compte telles que `main/gpt-5.6-sol` et lignes qualifiées par le fournisseur telles que
`openai-apikey/gpt-5.6-sol` restent des itinéraires OpenAI distincts ; l'itinéraire clé API qualifié par le fournisseur
ne tombe jamais dans l'alias natif.

Les clés de visibilité restent sans ambiguïté :

- `combo/nova-sol` masque le combo de compatibilité de la découverte.
- L'entrée `gpt-5.6-sol` nue dans `disabledModels` continue de signifier la ligne OpenAI native dormante ;
  cela ne masque pas le combo qui détient actuellement cet identifiant public.
- Lorsqu'au moins un alias natif est configuré, les lignes natives nues désactivées sont omises du
  catalogue Codex effectif au lieu d’être conservées avec `visibility: "hide"`. La liste d’autorisation de
  Desktop ne peut donc pas faire réapparaître des lignes qui devraient rester masquées. La page **Modèles**
  continue d’afficher les commutateurs natifs non masqués ; réactiver l’un d’eux restaure ses métadonnées
  natives préservées ou actuelles.

:::caution
Un alias natif reprend intentionnellement un identifiant de modèle propriétaire. Utilisez-le uniquement lorsque la cible
est opérationnellement équivalente et étiquetez honnêtement la ligne du sélecteur. La suppression du combo restaure
le routage natif et l’identité du catalogue lors de la prochaine synchronisation.
:::

## Choisissez une stratégie

### Basculement : commande principale et sauvegardes

`failover` sélectionne la première cible éligible dans l’ordre de configuration. Une cible est éligible lorsque son
fournisseur existe, est activé, n’est pas en période de refroidissement et peut gérer toute contrainte particulière de la demande.
Les poids et `stickyLimit` n’affectent pas cette stratégie.

Compte tenu de cet ordre :

1. `anthropic/claude-opus-4-8`
2. `openai/gpt-5.6-sol`
3. `google/gemini-3-pro`

chaque requête commence par Anthropic. Un échec d’Anthropic autorisant une nouvelle tentative fait basculer la requête vers OpenAI ; un
échec similaire d’OpenAI peut la faire basculer vers Google. Une erreur terminale interrompt immédiatement le traitement au lieu de
essayer les cibles restantes.

### Round-robin : lots pondérés lisses

`round-robin` utilise un round-robin pondéré en douceur. Un poids cible plus grand donne à cet objectif un plus grand
partager au fil du temps sans envoyer la totalité de sa part en un seul long bloc. `stickyLimit` contrôle combien
les demandes réussies restent sur la cible sélectionnée avant la prochaine sélection pondérée.

Créez un combo 2:1 avec des lots de deux requêtes réussies :

```bash
ocx combo set balanced \
  --targets anthropic/claude-opus-4-8:2,openai/gpt-5.6-sol:1 \
  --strategy round-robin \
  --sticky 2
```

Appelant les cibles **A** (poids 2) et **B** (poids 1), les six premières sélections pondérées sont
`A, B, A, A, B, A`. Parce que `stickyLimit` est 2,, chaque sélection reste active pendant deux
demandes :

| Demande réussie | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cible | A | A | B | B | A | A | A | A | B | B | A | A |

À long terme, la répartition reste de 2:1. Un échec autorisant une nouvelle tentative met fin au lot persistant en cours et place la cible en période de refroidissement.
cible et sélectionne une autre cible éligible pour la même demande.

:::caution
Les poids sont relatifs et non en pourcentage. Les poids `2,1` et `200,100` expriment le même rapport. Préférer
petites valeurs qui communiquent l’intention.
:::

## Que se passe-t-il lorsqu'une cible échoue

Les échecs d’un combo se répartissent entre ceux qui entraînent un **basculement** et les échecs **terminaux**.

| Résultat | Comportement |
| --- | --- |
| HTTP 401, 403, 404, 408, 429, ou n'importe quel 5xx | Refroidissez la cible et passez à la prochaine cible éligible. |
| Erreur classée comme erreur d’authentification, d’abonnement, de quota, de limitation de débit, de surcharge ou de serveur en amont | Place la cible en période de refroidissement et bascule, même si le statut seul ne suffit pas. |
| Annulation client (499), `origin_rejected`, refus de cyber-politique, débordement de contexte ou demande invalide | Arrêtez et renvoyez l'erreur ; une autre cible ne rendrait pas la demande valide. |
| Toute autre erreur non classifiée | Arrêtez et renvoyez l'erreur. |

Une cible sautée entre en temps de recharge pendant 60 secondes par défaut. Si la réponse en amont inclut un
valeur `Retry-After` valide, opencodex l’utilise à la place. Les secondes numériques et les valeurs de date HTTP sont
accepté, et chaque temps de recharge est limité à 10 minutes.

La requête actuelle ne réessaye jamais la même cible tentée. Les demandes ultérieures l'ignorent jusqu'à ce qu'il soit
le temps de recharge expire. S’il ne reste aucune cible éligible, le proxy renvoie HTTP 503 avec
`error.code = "combo_unavailable"`.

:::note
Le basculement est intentionnellement limité. Il facilite la disponibilité, l'authentification et l'authentification spécifiques à la cible.
échecs de quota et de surcharge ; il ne cache pas les erreurs des appelants ni les refus de politique.
:::

## Effort de raisonnement par défaut

`defaultEffort` fournit `reasoning.effort` uniquement lorsque toutes ces conditions sont vraies :

1. le combo a un défaut non nul ;
2. l'appelant n'a pas fait d'effort ; et
3. le catalogue de la cible sélectionnée annonce cet effort précis.

Si la requête n'a pas d'objet `reasoning`, opencodex en crée un. Si `reasoning` existe sans
`effort`, il préserve les autres champs et ajoute la valeur par défaut. Un effort fourni par l’appelant n’est
jamais écrasé.

Lorsque la capacité cible est inconnue ou n'inclut pas l'effort configuré, opencodex omet le
par défaut et laisse le comportement de la cible inchangé. Les valeurs prises en charge sont `low`, `medium`,
`high`, `xhigh`, `max` et `ultra` ; omettez le champ ou réglez-le sur `null` pour laisser l'effort entièrement à
l'appelant et la cible.

## Capacité d’entrée d’images / multimodale

Par défaut, une combinaison publie l’**intersection** des modalités d’entrée de ses cibles : les images ne
sont activées que lorsque toutes les cibles les annoncent. Définissez `imageInput: "disabled"` pour forcer
le texte seul même si toutes les cibles prennent en charge les images. Le catalogue retire alors `image`
de `inputModalities`, et les requêtes contenant des images sont rejetées avec le code HTTP 400 avant tout
appel de cible. La valeur `"auto"`, ou l’absence du champ, conserve l’intersection automatique.

## Tâches du sous-agent v2 chiffrées

Il existe une limitation importante pour les sous-agents Codex v2 ([issue #92](https://github.com/lidge-jun/opencodex/issues/92)).
Un parent natif peut envoyer la tâche d'un travailleur nouvellement généré uniquement sous forme de texte chiffré créé pour le natif.
ChatGPT back-end. Un fournisseur externe ne peut pas lire cette charge utile.

Pour une telle requête, un combo filtre ses cibles éligibles sur les routes ChatGPT natives canoniques,
y compris après un échec autorisant une nouvelle tentative. Si le combo ne comporte aucune cible capable de déchiffrer la tâche, opencodex s’arrête
avant expédition et retours HTTP 400 :

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unreadable_encrypted_agent_task"
  }
}
```

Cela empêche la tâche d’être envoyée à un fournisseur qui ne recevrait aucune instruction lisible.
Les tâches en texte clair lisibles utilisent la stratégie combo normale.

Vous disposez de quatre options de récupération :

1. Sélectionnez un modèle ChatGPT natif pour l'enfant.
2. Ajoutez une cible ChatGPT native canonique au combo.
3. Utilisez la surface v1 pour la délégation entre différents fournisseurs.
4. Si vous contrôlez l'appelant, renvoyez la tâche sous forme de contenu en texte brut v2 `agent_message`.

Voir [Surface sous-agent](/fr/guides/sub-agent-surface/) pour les modes v1/base/v2 et le chiffrement complet
flux de travail des tâches.

## Gérer les combos

### Tableau de bord

Ouvrez le tableau de bord local et choisissez **Modèles → Combos**. L'espace de travail crée, modifie, renomme et supprime
combos, et son sélecteur de cible exclut les modèles désactivés et les combos imbriqués.

### CLI

Les commandes principales sont :

```bash
ocx combo list
ocx combo show <id>
ocx combo set <id> --targets provider/model[:weight],...
ocx combo remove <id> --yes
```

`set` accepte également `--strategy`, `--sticky`, `--effort`, `--alias`, `--native-alias`,
`--display-name` et `--rename-from`. Utilisez `-` comme valeur de `--effort`, `--alias` ou
`--display-name` pour effacer ce champ. `--native-alias` exige un alias de modèle natif non qualifié actuellement
pris en charge et un nom d’affichage non vide. `create` et `update` sont des alias pour `set` ; `delete` est un alias pour
`remove` ; et les mêmes sous-commandes sont disponibles sous `ocx route combo`.

### Gestion API

Les clients sans interface utilisent `GET`, `PUT` et `DELETE` sur `/api/combos`. `GET` liste les définitions
normalisées, `PUT` en crée ou en remplace une et peut en renommer une, tandis que `DELETE` utilise le paramètre
de requête `id`. L’authentification et les détails des requêtes et réponses se trouvent dans la
[Gestion API référence](/fr/reference/management-api/).

Pour la configuration persistante complète, voir [Configuration](/fr/reference/configuration/).

## Référence de configuration

Les combos sont stockés dans l'objet `combos` de niveau supérieur, saisi par l'identifiant du combo :

```json
{
  "combos": {
    "balanced": {
      "targets": [
        { "provider": "anthropic", "model": "claude-opus-4-8", "weight": 2 },
        { "provider": "openai", "model": "gpt-5.6-sol", "weight": 1 }
      ],
      "strategy": "round-robin",
      "stickyLimit": 2,
      "defaultEffort": "high",
      "alias": "team/balanced"
    }
  }
}
```

| Champ | Obligatoire | Par défaut | Règles |
| --- | --- | --- | --- |
| `targets` | Oui | — | Tableau ordonné non vide de `{ provider, model, weight? }` cibles configurées. Les paires provider/model en double sont rejetées. |
| `targets[].weight` | Non | `1` | Entier de 1 à 10 000. Utilisé en round-robin ; ignoré par le basculement. |
| `strategy` | Non | `"failover"` | `"failover"` ou `"round-robin"`. |
| `stickyLimit` | Non | `1` | Nombre entier de 1 à 100 requêtes réussies par sélection à tour de rôle. |
| `defaultEffort` | Non | `null` | `low`, `medium`, `high`, `xhigh`, `max` ou `ultra` ; appliqué uniquement lorsque l'appelant omet ses efforts et que la cible annonce son soutien. |
| `imageInput` | Non | `"auto"` | `"auto"` ou `"disabled"`. `"auto"` publie les images uniquement si toutes les cibles les prennent en charge ; `"disabled"` impose le texte seul, retire les images des modalités publiées et rejette les requêtes qui en contiennent avant leur distribution. |
| `alias` | Non | aucun | Identifiant de modèle public tronqué facultatif ; utilisez les règles d'alias ci-dessus. Une valeur vide est stockée sans alias. |
| `nativeAlias` | Non | `false` | Autoriser explicitement un `alias` natif nu actuellement pris en charge à avoir la priorité sur le routage et le catalogue. Jamais déduit de l'alias. |
| `displayName` | Non | aucun | Étiquette de catalogue délimitée en affichage uniquement. Obligatoire et non vide lorsque `nativeAlias` est vrai. |

## Dépannage

### Pourquoi `combo/<id>` renvoie 404 ?

L'identifiant du combo est inconnu. La réponse est HTTP 404 de type `invalid_request_error`. Courir
`ocx combo list`, vérifiez l'orthographe et la casse, et confirmez que votre commande de gestion a écrit sur le même
exécution d'une instance opencodex qui reçoit des requêtes de modèle.

### Pourquoi est-ce que je reçois `combo_unavailable` ?

Chaque cible est actuellement inéligible : par exemple, son fournisseur est désactivé, il est en phase de refroidissement,
elle a déjà été tentée pour cette requête, ou une tâche v2 chiffrée l'exclut. Vérifier la cible
état du fournisseur et erreurs récentes en amont. Pour les temps de recharge, attendez la valeur par défaut de 60 secondes ou la
délai indiqué par `Retry-After` en amont (jamais plus de 10 minutes), puis réessayez.

### Pourquoi mon alias a-t-il été rejeté ?

Vérifiez d'abord la grammaire des alias et les noms réservés. Un alias en double ou une forme non valide est rejeté comme
HTTP 400. Un alias barre oblique dont le premier segment est un espace de noms de compte Codex configuré est rejeté
comme HTTP 409 ; choisissez un autre espace de noms d’alias. Le CLI et le tableau de bord affichent l'adresse exacte du serveur.
message de validation.

### Pourquoi le basculement s'est-il arrêté après la première erreur ?

L’erreur était terminale plutôt que spécifique à la cible. Corriger une entrée invalide, réduire un contexte surdimensionné,
gérer un refus de politique ou corriger l’origine de la demande rejetée. Les combos ne sautent pas dans ces cas-là.
