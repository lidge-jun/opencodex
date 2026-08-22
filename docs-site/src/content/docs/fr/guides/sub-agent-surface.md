---
title: Interface des sous-agents (v1 / base / v2)
description: Contrôlez la manière dont Codex génère et gère les sous-agents dans tous les modèles.
---

## Que sont les sous-agents

Un sous-agent est un travailleur Codex distinct que l'agent principal peut créer pour une tâche ciblée. Il possède
son propre contexte et ses propres outils, afin que plusieurs tâches indépendantes puissent s'exécuter en parallèle. opencodex contrôle
quelle surface de collaboration Codex expose ces travailleurs, quels modèles Codex leur propose et comment
un modèle défaillant peut reculer. Il ne décide pas quand votre agent principal doit déléguer.

## Modes

Choisissez le mode pour les **nouvelles sessions**. Les sessions existantes conservent la surface avec laquelle elles ont commencé.

| Mode | Ce que Codex obtient | Qui devrait le choisir |
| --- | --- | --- |
| **v1** | Outils classiques avec espace de noms `spawn_agent`, `send_input`, `resume_agent` et `close_agent`. Un spawn peut sélectionner directement un autre modèle. | Les débutants qui ont besoin d'une délégation fiable entre différents fournisseurs, en particulier les enfants natifs vers routés. |
| **base** (par défaut) | Paramètres de modèle en amont : GPT-5.6 Sol/Terra utilisent la v2, Luna utilise la v1, et les modèles non définis explicitement suivent l’indicateur de fonctionnalité `multi_agent_v2` de Codex. | La plupart des utilisateurs. Ce mode respecte la surface prévue par Codex pour chaque modèle, sans en imposer une globalement. |
| **v2** | Outils plats `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent` et liste d'agents, avec sessions simultanées. | Utilisateurs souhaitant utiliser le flux de travail simultané le plus récent et comprenant l'héritage de modèle et la limitation des tâches chiffrées ci-dessous. |

En **v2**, l'option facultative **Garder ChatGPT sur v1** (`keepNativeChatGptOnV1`) laisse Sol/Terra
sur la surface v1 afin qu'ils puissent encore lancer Grok ou Claude. Les parents natifs ChatGPT
chiffrent les corps `NEW_TASK` v2 ; les modèles routés ne peuvent pas les lire. Les parents routés
restent sur v2, où les tâches enfants sont en texte clair. C'est un interrupteur *à l'intérieur*
de v2, pas un quatrième mode de catalogue. CLI : `ocx v2 mode v2` puis `ocx v2 keep-native-v1 on`.

:::tip[Pas sûr ?]
Commencez par **base**. Choisissez **v1** lorsque la délégation entre fournisseurs doit fonctionner de manière prévisible. Forcer **v2**
uniquement lorsque vous souhaitez spécifiquement son modèle de session le plus récent dans chaque entrée de catalogue.
:::

## Comment ça marche

Le mode sélectionné contrôle le champ `multi_agent_version` dans chaque entrée de catalogue Codex lit :

- **v1** inscrit `multi_agent_version = "v1"` sur chaque modèle.
- **base** restaure les paramètres en amont. Les entrées sans valeur explicite suivent l’indicateur de fonctionnalité natif `multi_agent_v2`.
- **v2** inscrit `multi_agent_version = "v2"` sur chaque modèle, sauf lorsque **Garder ChatGPT sur v1** est activé : les lignes natives ChatGPT restent `"v1"` et les lignes routées ou combo restent `"v2"`.

opencodex applique cela comme passe finale à la fois au catalogue `/v1/models` en direct et au catalogue synchronisé
sur le disque. C'est pourquoi un changement de mode affecte de manière cohérente les sessions App, CLI et TUI nouvellement créées.

Pour une liste v2, l'éligibilité a trois états : une entrée estampillée `"v2"`, explicitement définie sur `null`, ou
sans champ `multi_agent_version` est admissible. Une valeur explicite `"v1"` est exclue, car elle indique
que le modèle appartient à l’autre surface de collaboration.

## Modèle et efforts de délégation

La **délégation de sous-agent** du tableau de bord contrôle trois paramètres associés :

- `injectionModel` est le modèle de travailleur préféré nommé dans le guide opencodex.
- `injectionEffort` est le `reasoning_effort` optionnel à demander pour ce modèle.
- `injectionPrompt` remplace le texte d'orientation intégré de la v2.

`multiAgentGuidanceEnabled` est activé par défaut et constitue le réglage principal des directives produites par opencodex
sur les deux surfaces. Sa désactivation supprime à la fois le bloc de désignation v2 et le texte proactif v1.

Pour les requêtes Responses sans état dont l’entrée est un tableau, opencodex place les instructions générées après les
premières métadonnées système et développeur, y compris `additional_tools` côté développeur, et avant l’entrée
conversationnelle. Les continuations avec état utilisant `previous_response_id` ne réutilisent les directives balisées que si elles correspondent au dernier
élément balisé de leur préfixe de relecture fiable. Les autres directives générées sont réutilisées lorsqu’un élément développeur généré
à l’identique figure dans ce préfixe. Lorsque les directives changent, le protocole de l’outil principal reste en première position et
les nouvelles directives sont insérées avant l’entrée conversationnelle actuelle.

Ce sont des instructions destinées à l'agent principal, et non à un routeur de génération côté proxy. Sur la v2, un fork avec historique complet
hérite du modèle parent et rejette les remplacements de modèle ou d'effort. Le guidage indique donc à Codex de
utilisez `fork_turns: "none"` (ou un compte de tour partiel positif tel que `"3"`) lorsque vous dépassez `model` ou
`reasoning_effort`, et de rendre le message de tâche autonome.

Le texte personnalisé de `injectionPrompt` peut utiliser les quatre espaces réservés suivants :

| Espace réservé | Remplacé par |
| --- | --- |
| `{{model}}` | Le modèle préféré effectif pour cette requête. Un `injectionModel` natif non qualifié n’est qualifié par un compte que si la requête cible elle-même un sélecteur de compte explicite. Une valeur non qualifiée, non résolue ou ambiguë devient une chaîne vide ; un identifiant explicite qualifié par un compte ou un routage, même non résolu, reste inchangé |
| `{{effort}}` | Le `injectionEffort` configuré, ou une chaîne vide |
| `{{roster}}` | La liste résolue, visible par le sélecteur et compatible avec la surface |
| `{{fallback}}` | Les conseils de repli globaux configurés |

Le guide v2 intégré dispose d’un budget de 700 caractères. S’il devait dépasser ce budget, opencodex réduit
la liste d'abord plutôt que de tronquer les instructions d'apparition principales. Le guidage intégré déclenche uniquement
lorsqu'un modèle préféré, une liste éligible ou une chaîne de secours est résolu. Un `injectionModel` configuré
est suffisant pour afficher une invite personnalisée ; si une valeur non qualifiée ne peut pas être résolue de manière unique, `{{model}}`
se développe en une chaîne vide.

Sur la v1, opencodex injecte uniquement les conseils de délégation proactive de style amont à `max` ou `ultra`
effort. Il n’ajoute aucun modèle préféré, aucune liste, aucune chaîne de repli ni aucune invite personnalisée en v1.

L'option `syncCodexSubagentDefaults` désactivée par défaut est distincte du guidage. Quand opencodex possède
le routage Codex actif, la synchronisation ou le redémarrage peut écrire les valeurs sélectionnées en tant que propriété du marqueur
entrées `[agents] default_subagent_model` et `default_subagent_reasoning_effort` dans Codex TOML.
opencodex met à jour ou supprime uniquement les champs portant ses marqueurs. Si l'un des champs cibles appartient à l'utilisateur,
la paire reste inchangée plutôt que partiellement écrite ; ambigu TOML est rejeté sans un
écriture. Les gestionnaires de fournisseurs externes et le routage racine appartenant à l’utilisateur conservent également leur autorité.

## Chaînes de repli

Pour un travailleur généré, opencodex construit cet ordre de priorité :

1. Le modèle primaire demandé.
2. Une chaîne par modèle de `subagentModelFallbackByModel` dans opencodex config, saisie par
   le modèle primaire demandé.
3. La liste `subagentModelFallback` globale dans opencodex config.

Les chaînes de secours par rôle appartiennent à opencodex config, pas à
`$CODEX_HOME/agents/*.toml`. Codex 0.146+ désérialise strictement les fichiers de rôles d'agent et
rejette `model_fallback` comme champ inconnu, ce qui ignore toute la définition du rôle
(#1190). opencodex peut toujours lire une ligne `model_fallback` héritée du TOML pour
compatibilité ascendante, mais `ocx doctor` en avertit et Codex lui-même ignorera
le rôle concerné.

Les identifiants de modèle en double sont supprimés tout en préservant la première occurrence. Lors de la sélection, opencodex
ignore les candidats désactivés, non routables, soutenus par un fournisseur désactivé, marqués en mauvais état,
pendant un temps de recharge, il manque un compte Codex poolé utilisable ou au-delà du seuil de quota configuré.
Les sondes de disponibilité sont mises en cache pendant `subagentModelFallbackPollMs` (60 secondes par défaut).

La solution de secours ne rend pas lisibles les tâches chiffrées incompatibles. Lorsque la tâche enfant est chiffrée pour
ChatGPT, la sélection est restreinte aux cibles ChatGPT natives canoniques même si un modèle externe
apparaît plus tôt dans la chaîne.

## Livraison de tâches v2 cryptées

Codex peut envoyer une tâche enfant v2 native vers routé uniquement sous forme `encrypted_content` chiffrée par le backend. Cette
charge utile peut être lue par le backend natif ChatGPT, mais pas par un fournisseur externe. C'est la
limitation connue [#92](https://github.com/lidge-jun/opencodex/issues/92).

opencodex échoue en toute sécurité au lieu de transférer une tâche vide ou illisible :

- Une route directe non native renvoie HTTP 400 avec
  `error.code = "unreadable_encrypted_agent_task"` et ne fait pas écho au texte chiffré.
- Un combo considère uniquement les cibles ChatGPT natives canoniques pour cette tâche, y compris les tentatives. Si aucun
  est disponible, il renvoie la même erreur 400.
- Une tâche lisible en texte clair conserve la route normale et le comportement de repli.

Les options de récupération consistent à sélectionner un enfant ChatGPT natif, à ajouter une cible ChatGPT native au combo, à utiliser
v1 pour la délégation de fournisseurs hétérogènes, ou renvoyer la tâche en texte brut v2 `agent_message`
contenu lorsque vous contrôlez l’appelant.

L’option expérimentale `agentTaskRecovery`, désactivée par défaut, peut récupérer cette forme précise de
tâche native envoyée vers une route externe. Elle utilise un transfert Responses brut vers le point de
terminaison ChatGPT `/responses` fixe et la forme d’identification entrante du fournisseur canonique
`openai` configuré avec `authMode: "forward"`.

Cette récupération est disponible uniquement lorsque le proxy écoute sur l’interface de bouclage. Elle ne
substitue jamais une autre clé API, l’identifiant d’un autre fournisseur ou un autre compte Codex. Seuls les
en-têtes `authorization`, `chatgpt-account-id` correspondant, `originator`, ainsi que les métadonnées
facultatives `openai-beta` et `user-agent`, sont transmis. `content-type` et `accept` sont générés localement ;
aucun autre en-tête de l’appelant ne franchit cette frontière.

Cette opération consomme du quota, ajoute de la latence, conserve brièvement le texte récupéré dans un cache
mémoire borné et dépend d’un comportement non documenté du service ChatGPT. Comme un modèle renvoie le texte
récupéré, la fidélité octet par octet n’est pas garantie. Les appelants génériques ou authentifiés par clé API
sont rejetés, et tout échec conserve l’erreur `unreadable_encrypted_agent_task`. Consultez
[Configuration de l'agent : récupération de tâche chiffrée v2](/fr/reference/configuration/agents/#récupération-des-tâches-v2-chiffrées)
pour la limite de confiance complète et la configuration.
Le routage des combinaisons reste inchangé et continue de considérer uniquement les cibles ChatGPT natives
canoniques pour les tâches chiffrées.

## Changer le mode

### GUI

- **Tableau de bord** → première cellule statistique : choisissez **v1**, **base** ou **v2**.
- **Modèles** → contrôle segmenté de la rangée supérieure : choisissez le même mode global.
- **Modèles** → **Garder ChatGPT sur v1** : activez cette option uniquement lorsque le mode global est **v2**. Elle est ignorée en **v1** et **base**.
- **Tableau de bord** → **Délégation de sous-agent** : définissez les conseils model/effort et l'activation explicite natif par défaut.
- **Sous-agents** : choisissez et ordonnez la liste, puis configurez la chaîne de repli globale.

### CLI

Utilisez `ocx v2` pour les paramètres de la surface de collaboration et des fonctionnalités natives :

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 mode v2
ocx v2 keep-native-v1 on
ocx v2 keep-native-v1 off
ocx v2 threads 8
```

Utilisez `ocx agent` pour les paramètres de délégation, de liste, de plafond d'effort et de secours :

```bash
ocx agent status
ocx agent injection set --model anthropic/claude-sonnet-5 --effort xhigh
ocx agent subagents set gpt-5.6-sol,anthropic/claude-sonnet-5
ocx agent fallback set gpt-5.4-mini,xai/grok-4.5 --poll-ms 60000
ocx agent effort set --subagent max
```

Passez `-` pour effacer une valeur `ocx agent injection` nullable, ou utilisez l'action `clear` appropriée pour un
liste ou chaîne de repli. Consultez la [référence CLI](/fr/reference/cli/) pour toutes les familles de commandes.

### API

La gestion API expose les points de terminaison correspondants `GET` et `PUT` :

| Point de terminaison | Gère |
| --- | --- |
| `/api/v2` | Mode Surface, indicateur de fonctionnalité native et paramètres de thread |
| `/api/injection-model` | Modèle préféré, effort, invite personnalisée, conseils et synchronisation native par défaut |
| `/api/effort-caps` | Plafonds d'effort des agents principaux et des sous-agents |
| `/api/subagent-models` | Liste commandée de cinq modèles maximum |
| `/api/subagent-model-fallback` | Ordre de repli global et intervalle d'interrogation |

Par exemple :

```bash
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode":"v2"}'

curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-5","effort":"xhigh"}'
```

## FAQ

### Le choix d'un modèle de délégation oblige-t-il Codex à le générer ?

Non. Les directives peuvent recommander un modèle et la synchronisation native des valeurs par défaut peut fournir une valeur par défaut à Codex, mais
l’agent principal décide toujours s’il doit déléguer.

### Pourquoi mon enfant v2 a-t-il utilisé le modèle parent ?

Un fork v2 à historique complet hérite du modèle parent. Utilisez un spawn qui définit `fork_turns` sur `"none"` ou
un décompte partiel positif avant de passer un dépassement de modèle ou d'effort.

### Pourquoi un modèle configuré manque-t-il dans la liste v2 ?

Il peut être masqué par le sélecteur, en dehors de la limite d'affichage de cinq modèles, absent du catalogue ou épinglé
à la v1. Une valeur de surface `"v2"`, `null` ou absente est admissible ; une valeur explicite `"v1"` ne l’est pas.

### Les changements de mode affectent-ils les sessions en cours ?

Non. Démarrez une nouvelle session Codex après avoir changé de mode. Si un hôte App de longue durée affiche toujours des informations obsolètes
état du catalogue, exécutez `ocx sync` et redémarrez cette surface Codex.

### Que se passe-t-il lorsqu’opencodex ne peut pas considérer le catalogue comme fiable ?

opencodex compare le catalogue de modèles sur disque à l'heure de démarrage de chaque Codex serveur d'applications détenu
par l'utilisateur actuel, produisant l'un des quatre états suivants :

| État | Signification | conseils v2 |
|---|---|---|
| `fresh` | Chaque serveur d'applications a démarré après la rédaction du catalogue | Conseils complets : modèle préféré, liste, solutions de secours |
| `not_running` | Aucun serveur d'application détecté | Conseils complets |
| `stale` | Au moins un serveur d'applications est antérieur au catalogue | **Aucune directive sur le modèle rédigé par opencodex** |
| `unknown` | La comparaison n'a pas pu être faite | **Aucune directive sur le modèle rédigé par opencodex** |

Pour `stale` et `unknown`, opencodex omet ses propres indications dérivées du disque — modèle préféré, liste,
secours et conseils personnalisés - car le Codex en cours d'exécution peut ne pas être en mesure de générer ce que le disque
catalogue annonce.

Il ne demande **pas** au modèle d'arrêter le réglage `model` ou `reasoning_effort`. Cette observation est
global sur chaque serveur d'applications pour l'utilisateur, alors qu'une requête entrante ne porte aucune identité d'expéditeur, donc
un processus obsolète ne peut pas être attribué à la demande dont nous sommes saisis. Interdire les dérogations à ce sujet
base bloquerait les options que l'outil actif `spawn_agent` annonce légitimement, pour une session qui
peut très bien être à jour. Le schéma de l’outil actif reste la référence.

`unknown` n'est pas synonyme de `stale`. Cela signifie que la comparaison elle-même a échoué – un catalogue illisible
horodatage, une heure de début de processus illisible ou une énumération de processus ayant échoué - et cela est signalé
séparément par `ocx doctor`. `stale` s'efface uniquement après chaque démarrage du serveur d'applications Codex détecté après
la rédaction du catalogue final ; cela n'efface pas nécessairement `unknown`.

Seul un vrai changement compte. Une synchronisation dont le résultat est identique en octets au catalogue déjà sur le disque
laisse le fichier intact, donc le redémarrage du proxy ou la resynchronisation d'un ensemble de modèles inchangé ne le fait pas
donner un aspect obsolète à un Codex en cours d'exécution.

### Effort de raisonnement

`injectionEffort` affecte uniquement le guidage des travailleurs délégués et, lorsqu'il est explicitement activé, le Codex natif
valeurs par défaut du sous-agent. Cela ne change pas l'effort de la session parent. `ultra` est un haut orienté client
niveau que Codex convertit en `max` ; opencodex mappe ou bloque ensuite la valeur du fournisseur sélectionné.

### Limite de contexte

La limite de contexte du modèle est indépendante du mode sous-agent. Configurez-le sur la page Modèles ; natif
OpenAI les modèles conservent leurs fenêtres de contexte réelles.
