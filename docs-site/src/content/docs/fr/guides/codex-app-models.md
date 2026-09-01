---
title: Sélecteur de modèles de Codex App
description: Comment les modèles opencodex apparaissent dans Codex App, Codex CLI et Codex TUI par l'intermédiaire du catalogue Codex partagé.
---

opencodex ne modifie pas Codex App. Il écrit la même configuration et le même catalogue de modèles Codex
que ceux utilisés par Codex CLI et TUI. Le serveur d'application lit cet état partagé, mais certaines versions
de Codex Desktop appliquent dans le moteur de rendu une seconde liste d'autorisation distante et peuvent
encore retirer les lignes routées du sélecteur.

Les entrées OpenAI utilisent deux routes d'identification : la connexion Codex native et le transport par
clé API avec espace de noms `openai-apikey/<model>`. Le simple passage de `codexAccountMode` entre Pool et
Direct ne change pas les identifiants du sélecteur. Toutefois, lorsque les lignes qualifiées par compte sont
activées avec `codexAccountPickerEnabled` et que `codexAccountNamespaces` contient des sélecteurs admissibles
dont les comptes associés existent toujours, opencodex ajoute une ligne
`<selector>/<native-openai-model>` distincte pour chaque compte associé et masque les lignes natives non
qualifiées du sélecteur Codex. Les libellés des sélecteurs sont des noms publics choisis par l'utilisateur et
n'ont aucune signification intégrée quant au rôle du compte. Choisir une ligne qualifiée utilise exclusivement
le compte associé, ne change pas le compte Pool actif et échoue de façon fermée au lieu de changer de compte
si la cible n'est pas disponible. Si le catalogue Codex propre à un compte contient un identifiant visible de
la famille OpenAI, pris en charge par l'API mais absent de l'ensemble statique d'opencodex, cet identifiant
exact est conservé sous forme de ligne qualifiée pour les sélecteurs admissibles du compte principal. Il
n'est ni copié vers un compte sans rapport, ni ajouté aux listes de modèles non qualifiés ou accessibles par
clé API. La ligne est reconnue d'après la structure de champs d'une véritable entrée de catalogue, ce qui
filtre les entrées mal formées ; cela ne prouve pas que l'identifiant provient d'une réponse en amont, car le
cache appartient à l'utilisateur. Consultez les
[sélecteurs exacts de compte Codex](/fr/reference/configuration/routing/#sélecteurs-exacts-de-comptes-codex).

`gpt-daybreak-blue-latest` suit cette règle d'observation uniquement pour les lignes qualifiées par compte et
n'est pas ajouté à la liste d'autorisation native non qualifiée. Une entrée `customModels` distincte et
explicite peut exposer le même identifiant transmis comme `openai/gpt-daybreak-blue-latest` par
l'intermédiaire du fournisseur canonique de transfert de la connexion Codex :

```json
{
  "customModels": [
    {
      "id": "daybreak-codex-forward",
      "provider": "openai",
      "modelId": "gpt-daybreak-blue-latest"
    }
  ]
}
```

Seuls ce fournisseur, ce point de terminaison et cet identifiant de modèle exacts reçoivent l'instantané de
capacités Sol épinglé : contexte de 372 000 jetons, compactage automatique à 334 800 jetons, échelle de
raisonnement native et métadonnées d'outils Codex natives. La requête continue d'envoyer
`gpt-daybreak-blue-latest` ; opencodex ne le réécrit pas en Sol, ne crée aucune ligne non qualifiée et
n'accorde aucun droit au compte. La ligne API `openai-apikey/daybreak-blue-latest`, facturée séparément,
emprunte une autre route, et ses limites de 1 050 000 / 922 000 jetons ne sont jamais copiées dans la ligne
de connexion Codex.

Lorsque la table `codexAccountNamespaces` est vide, les lignes qualifiées par compte sont désactivées. Si
`codexAccountPickerEnabled` est omis alors que cette table n'est pas vide, elles sont considérées comme
activées par compatibilité ascendante. Définissez-le sur `false` pour masquer les lignes qualifiées générées
et rétablir les lignes natives non qualifiées dans le sélecteur, sans supprimer les associations ni désactiver
le routage exact `<selector>/<native-openai-model>`.

Les entrées API GPT-5.6 et Daybreak emploient un contexte de 1 050 000 jetons et une entrée maximale de
922 000 jetons. Les identifiants `*-pro` du sélecteur se résolvent vers le modèle transmis de base avec
`reasoning.mode: "pro"`, tandis que les **Journaux**, l'**Utilisation** et l'état du sélecteur conservent
l'identifiant virtuel. Le catalogue API contient exactement dix identifiants : `gpt-5.5`, `gpt-5.6`,
Sol/Terra/Luna, leurs trois identifiants virtuels Pro, `daybreak-red-latest` et `daybreak-blue-latest` ; il
n'existe aucun alias générique `gpt-5.6-pro`. Les requêtes de compactage conservent le niveau sélectionné,
mais envoient le modèle de base sans objet de raisonnement.

Choisissez la route d'identification représentée par l'identifiant du sélecteur. Modifiez Pool/Direct sur la
page **Fournisseurs** ; `<selector>` désigne ci-dessous un libellé public choisi par l'utilisateur et associé
par `codexAccountNamespaces` :

```text
gpt-5.6-sol                         # route de connexion Codex nue via Pool ou Direct
<selector>/gpt-5.6-sol              # compte Codex enregistré associé à ce sélecteur
openai-apikey/gpt-5.6-sol           # clé API
openai/gpt-daybreak-blue-latest     # ligne personnalisée explicite relayée vers Codex (372 000)
<selector>/gpt-daybreak-blue-latest # identifiant natif qualifié par compte observé, si disponible
openai-apikey/daybreak-blue-latest  # route à clé API distincte (1 050 000 / 922 000)
```

Les nouvelles installations et les configurations sans mode enregistré utilisent Pool par défaut. Les
configurations actuelles emploient le marqueur 2 et enregistrent une copie de sauvegarde unique de la
configuration v1 livrée dans `~/.opencodex/config.json.pre-openai-tiers-v2.bak`. Restaurez cette copie avec :

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

Les anciennes configurations v1 à trois fournisseurs migrent automatiquement vers l'unique ligne tenant
compte de l'option choisie.

## Limitation de la liste d'autorisation distante de Desktop

Si `codex debug models` et `model/list` du serveur d'application contiennent un modèle routé que Desktop
n'affiche pas, consultez le [ticket Codex nº 19694](https://github.com/openai/codex/issues/19694). Lorsque la
stratégie distante `use_hidden_models` est active, Desktop peut ne conserver que les identifiants présents
dans sa liste native `available_models` et peut aussi afficher des lignes natives dont la visibilité du
catalogue vaut `hide`. L'actualisation du catalogue et le redémarrage du proxy ne peuvent pas, à eux seuls,
modifier cette stratégie du moteur de rendu.

Pour un modèle routé équivalent, opencodex propose un mode explicite de combinaison avec alias natif,
désactivé par défaut. Il publie un identifiant non qualifié autorisé avec un libellé d'affichage personnalisé
fidèle, puis achemine cet identifiant exact vers la combinaison configurée avant le routage OpenAI canonique.
Il omet aussi du catalogue effectif les lignes natives non qualifiées désactivées tant que des alias de
compatibilité existent, afin que Desktop ne puisse pas les faire réapparaître en ignorant `visibility`.
Consultez [Compatibilité avec la liste d'autorisation native de Codex Desktop](/fr/guides/combos/#compatibilité-avec-la-liste-dautorisation-native-de-codex-desktop)
pour la commande, la sémantique de la clé de désactivation et les contraintes de sécurité.

## Parcours d'intégration

`ocx init`, `ocx start` et `ocx sync` relient au proxy la configuration et le catalogue Codex partagés.
Consultez [Intégration de Codex](/fr/guides/codex-integration/) pour l'injection de configuration, la
synchronisation du catalogue, les lanceurs intermédiaires, le repli WebSocket et les mécanismes de restauration.

## Pourquoi les modèles routés apparaissent

Le sélecteur de modèles de Codex attend des entrées ayant la structure de son propre catalogue. opencodex
crée les entrées routées en clonant un modèle d'entrée Codex natif, puis en remplaçant l'identité du modèle :

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

Le clone conserve les champs exigés par l'analyseur strict, notamment les niveaux de raisonnement, le type
de shell, les indicateurs de prise en charge de l'API et les instructions de base. opencodex retire ensuite
les capacités exclusivement natives que la route ne peut respecter, dont les métadonnées de niveau de
service OpenAI.

## Couverture stable actuelle des modèles

L'ensemble natif de secours comprend `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` et GPT-5.6
Sol/Terra/Luna. Pour la famille GPT-5.5/5.4, opencodex conserve les entrées dynamiques plus riches du
catalogue Codex installé et ne synthétise qu'une entrée manquante. L'instantané amont fourni n'est employé
que pour GPT-5.6, auquel il apporte l'identité et les métadonnées réelles de chaque modèle plutôt qu'une
approximation fondée sur un ancien modèle d'entrée.

| Route | Identifiants du sélecteur et métadonnées du catalogue |
| --- | --- |
| Connexion Codex (lignes qualifiées par compte désactivées) | Identifiants natifs non qualifiés comme `gpt-5.6-sol`, `gpt-5.6-terra` et `gpt-5.6-luna` ; Pool ou Direct est choisi avec `codexAccountMode`. Les lignes GPT-5.6 utilisent une fenêtre de catalogue de 372 000 jetons. |
| Connexion Codex (lignes qualifiées par compte activées avec des sélecteurs admissibles) | Une ligne `<selector>/<native-openai-model>` par sélecteur admissible et modèle natif pris en charge ; chaque ligne utilise exclusivement le compte associé, et les lignes natives non qualifiées sont masquées dans le sélecteur. Les métadonnées natives et les fenêtres de contexte sont préservées. |
| Connexion Codex (ligne Daybreak transférée explicitement) | `openai/gpt-daybreak-blue-latest` uniquement lorsque l'entrée `customModels` exacte est configurée sur le fournisseur canonique `openai`. Elle conserve l'identifiant Daybreak transmis et utilise l'instantané de capacités Sol épinglé (contexte de 372 000 jetons ; compactage automatique à 334 800 jetons). |
| OpenAI (clé API) | Exactement dix lignes avec espace de noms : `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, les trois identifiants virtuels `*-pro` et les deux alias Daybreak (contexte de 1 050 000 jetons ; entrée maximale de 922 000 jetons pour les dix) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` (1 050 000) |
| Cursor | Le repli statique comprend `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra` et `cursor/gpt-5.6-luna` (1 000 000), ainsi que des lignes ordinaires/rapides pour Grok 4.5 et 4.6 (500 000) ; 4.6 ajoute `xhigh`, et la découverte dynamique propre au compte détermine quelles lignes restent visibles. |
| xAI | La découverte dynamique fait autorité. Le catalogue de secours comprend `xai/grok-4.6` et utilise `xai/grok-4.5` par défaut ; les deux ont une fenêtre de 500 000 jetons. Grok 4.6 propose `low` / `medium` / `high` / `xhigh` (valeur amont par défaut : `high`), tandis que Grok 4.5 s'arrête à `high`. |

Les entrées GPT-5.6 épinglées préservent exactement l'échelle amont. Sol et Terra proposent les niveaux de
`low` à `ultra` ; Luna s'arrête à `max`. Sol utilise `low` par défaut, contre `medium` pour Terra et Luna.
La ligne Daybreak Blue explicitement transférée par Codex hérite de l'échelle et de la valeur par défaut de
Sol sans changer son identité transmise. `ultra` est un choix côté client qui combine un raisonnement maximal
et une délégation proactive ; il atteint le serveur sous la forme `max`. La présence d'une entrée dans le
sélecteur signifie seulement que le catalogue est prêt : le compte ou la clé API connectés doivent encore
autoriser l'utilisation du modèle.

## Activation des modèles natifs et routés

La page **Modèles** du tableau de bord expose des commutateurs `disabledModels` pour les identifiants natifs
non qualifiés et les identifiants routés `provider/model`. `disabledModels` accepte également les identifiants
qualifiés par compte `<selector>/<native-openai-model>`, mais le tableau de bord ne répertorie pas ces lignes
exactes et ne permet pas de les basculer ; ajoutez-les manuellement à la configuration :

- Les identifiants routés possèdent un espace de noms (`provider/model`). En désactiver un l'exclut du catalogue synchronisé et de `/v1/models`.
- Les identifiants natifs qualifiés par compte emploient `<selector>/<native-openai-model>`. En ajouter un à `disabledModels` ne masque que la ligne de ce sélecteur.
- Les identifiants GPT natifs sont des identifiants non qualifiés. En désactiver un conserve son entrée exacte dans le catalogue pour une réactivation ultérieure, mais change sa valeur `visibility` en `hide` ; la ligne non qualifiée et tous ses clones qualifiés par sélecteur disparaissent alors de la découverte.
- Lorsqu'au moins une combinaison avec alias natif est configurée, les lignes natives non qualifiées désactivées sont omises au lieu d'être conservées sous forme masquée, car les versions concernées de Desktop ignorent l'indicateur de masquage. Un identifiant natif non qualifié remplacé par un alias natif est également omis de la page **Modèles** et n'y possède donc aucun commutateur natif ; seules les lignes natives non remplacées peuvent y être activées ou désactivées. Une synchronisation restaure les métadonnées natives intactes lorsqu'une ligne désactivée et non remplacée est réactivée.
- Les lignes natives non remplacées proviennent de l'ensemble statique pris en charge ; un modèle non remplacé et désactivé reste donc visible dans le tableau de bord et peut être réactivé.

La passe de visibilité s'exécute après les mises à niveau des instantanés. Après l'utilisation d'un
commutateur, l'API de gestion actualise le catalogue et force l'obsolescence du cache de modèles Codex.

## Mode de surface multi-agent

Le contrôle v1/base/v2 de la page **Modèles** change la surface de collaboration Codex utilisée par chaque
entrée du sélecteur. Consultez [Surface des sous-agents](/fr/guides/sub-agent-surface/) pour le mode canonique,
la délégation, l'héritage, le repli et le comportement des tâches chiffrées.

## Niveaux de raisonnement supérieurs

La visibilité des niveaux de raisonnement est indépendante du mode de surface v1/base/v2. Les entrées
générées capables de raisonner annoncent `max` afin que les remplacements directs de l'effort d'un sous-agent
soient validés ; les entrées routées générées actuelles et les anciennes entrées GPT natives annoncent aussi
`ultra`. Les échelles amont exactes de GPT-5.6 sont préservées : Luna possède donc `max`, mais pas `ultra`.

Sur le réseau, les adaptateurs routés convertissent ou plafonnent les niveaux non pris en charge. Pour les
anciens modèles natifs dont l'échelle réelle s'arrête à `xhigh`, `nativeEffortClamp` convertit une sélection
directe `max` ou `ultra` en `xhigh` (GPT-5.5, par exemple). Sol, Terra et Luna possèdent un véritable niveau `max`.

## Règles du niveau rapide

Codex enregistre le mode rapide ainsi :

```toml
service_tier = "fast"

[features]
fast_mode = true
```

Toutefois, le catalogue de modèles et l'identifiant du niveau employé dans la requête d'exécution utilisent
`priority`. opencodex préserve cette distinction. Les modèles OpenAI natifs transférés conservent la prise en
charge du mode rapide ; les fournisseurs routés sont conditionnés par leurs capacités. `service_tier` n'est
retiré que si le fournisseur déclare `supportsServiceTier: false` (le registre classe OpenAI canonique comme
`true`, et DeepSeek ainsi que Volcengine Ark comme `false`). Les passerelles personnalisées non classées
conservent intactes les valeurs transmises par l'appelant et ne reçoivent jamais d'injection. Une passerelle
personnalisée peut l’activer globalement avec `supportsServiceTier: true`, ou uniquement pour certains
modèles avec `modelSupportsServiceTier: { "verified-model": true }`. Une valeur exacte `false` restreint une
valeur globale `true`, tandis que `supportsServiceTier: false` reste fermé par défaut. La décision finale de
l’adaptateur et du modèle régit à la fois les métadonnées du catalogue et l’injection à l’exécution ;
l’option rapide n’est donc jamais annoncée lorsqu’elle ne peut être respectée. Une destination
`openai-chat` peut autoriser tous les modèles autrement admissibles avec `chatServiceTier: true`, ou
uniquement des modèles précis avec `modelSupportsServiceTier` ; les routes Responses n’ont pas besoin de
cette autorisation supplémentaire sur le protocole Chat.

## Sélection des sous-agents

Codex trie les entrées visibles du sélecteur par `priority` croissante et propose les cinq premières comme
remplacements de modèle pour `spawn_agent`. La page **Sous-agents** du tableau de bord permet de choisir et
d'enregistrer jusqu'à cinq identifiants natifs non qualifiés ou identifiants routés `provider/model`.
`subagentModels`, lorsqu'il est configuré manuellement, accepte aussi les identifiants qualifiés par compte
`<selector>/<native-openai-model>`, mais le tableau de bord ne propose pas ces identifiants exacts ; enregistrer
la page remplace la liste par les choix visibles dans le tableau de bord. opencodex attribue des priorités de
catalogue basses dans l'ordre choisi. Lorsque les lignes qualifiées par compte sont activées, les sélections
natives non qualifiées s'étendent en groupes qualifiés par sélecteur. Les autres modèles restent accessibles
par leur identifiant exact.

La liste des modèles mis en avant est distincte de la sélection **Délégation de sous-agent** du tableau de
bord. Elle détermine les remplacements que Codex propose en premier ; elle ne sélectionne aucun modèle et ne
déclenche aucune délégation à elle seule.

## Serveurs distants de Desktop

Le mode serveur distant de Codex Desktop filtre le sélecteur d'après la propre liste d'autorisation
`available_models` du client, active lorsque le réglage distant `use_hidden_models` est activé. Les entrées
routées du catalogue restent chargées et servies — `model/list` les renvoie et la CLI fournie les lit — mais
le moteur de rendu de Desktop retire avant affichage tout élément absent de cette liste exclusivement native.
opencodex n'a aucun accès à cette liste ; le défaut amont est suivi dans
[openai/codex#19694](https://github.com/openai/codex/issues/19694).

Tant que Desktop ne permet pas de contrôler cette liste d'autorisation :

- Définissez directement le modèle dans `~/.codex/config.toml` sur la machine distante, par exemple avec `model = "input/grok-4.5"`. Le sélecteur peut afficher `Custom`, mais les requêtes utilisent toujours le modèle routé configuré.
- Utilisez Codex CLI ou TUI plutôt que le sélecteur de Desktop ; ces interfaces n'appliquent pas la liste d'autorisation et répertorient normalement les modèles routés.

## Actualisation de l'état des modèles
## Limitation du repli sur quota natif

Lorsque l'application Codex épuise son quota natif de cinq heures, elle peut basculer vers un modèle de repli de réserve et griser les autres lignes de son sélecteur. Signalé dans [#2813](https://github.com/lidge-jun/opencodex/issues/2813), ce filtrage masque aussi les lignes routées par opencodex, alors que celles-ci utilisent des identifiants de fournisseur sans rapport et ne consomment aucun quota ChatGPT.

Ce filtrage est appliqué par le client avant que la requête n'atteigne le proxy, donc opencodex ne peut pas le lever. Les lignes routées sont écrites avec `visibility: "list"`, le filtrage du catalogue ne consulte que `disabledModels` et le `selectedModels` de chaque fournisseur, et aucune valeur de quota n'intervient dans la visibilité routée.

Sélectionner un modèle routé explicitement ne passe pas par le sélecteur. Définissez le modèle dans `config.toml` :

```toml
model = "anthropic/claude-sonnet-5"
```

ou envoyez-le directement :

```bash
ocx access test anthropic/claude-sonnet-5 --protocol responses
```

Les deux chemins routent correctement **dès que la requête atteint le proxy** — c'est couvert par des tests. En revanche, l'application de bureau Codex n'envoie pas le modèle configuré pendant le mode réserve : elle détermine l'état de réserve à partir de son propre sondage `wham/usage` (upsell `luna_reserve` plus une limite additionnelle `gpt-reserve` encore autorisée) et force le réglage de modèle sur `gpt-reserve` avant l'envoi, de sorte que la voie `config.toml` est écrasée dans l'application. Jusqu'à la réinitialisation de la fenêtre, utilisez `ocx access test`, Claude Code via le proxy (`ocx claude`) ou tout client `/v1` direct. Voir [Modèles routés pendant le mode réserve de Codex](/guides/codex-integration/#routed-models-during-codex-reserve-mode).


Si le sélecteur affiche encore des entrées obsolètes, actualisez le catalogue et redémarrez l'interface Codex concernée :

```bash
ocx sync
```

opencodex réécrit `models_cache.json` avec une enveloppe de cache volontairement périmée chaque fois que la
visibilité, la priorité ou les métadonnées du catalogue changent. La prochaine actualisation des modèles
Codex relit ainsi le nouveau catalogue.
