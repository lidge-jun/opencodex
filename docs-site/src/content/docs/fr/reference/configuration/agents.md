---
title: Configuration des agents
description: Surfaces multi-agents, consignes de délégation, modèles privilégiés, chaînes de repli, synchronisation des valeurs natives par défaut et plafonds d’effort.
---

Les paramètres des agents déterminent la surface de collaboration Codex annoncée, ainsi que la manière dont opencodex guide, route et limite les tâches déléguées.

## Champs de configuration des agents

| Champ | Type | Valeur par défaut | Signification |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` marque tous les modèles du catalogue comme compatibles v1 ; `v2` les marque tous comme compatibles v2. `default` rétablit les choix imposés en amont (Sol/Terra en v2, Luna en v1) et suit sinon l’indicateur natif `multi_agent_v2`. S’applique aux nouvelles sessions. |
| `keepNativeChatGptOnV1?` | `boolean` | `false` | Lorsque `multiAgentMode` vaut `"v2"`, marque les lignes natives ChatGPT (Sol/Terra et les autres modèles du backend ChatGPT) comme v1. Les parents routés restent en v2. Utilisez cette option pour qu'un parent ChatGPT puisse encore lancer Grok ou Claude — les tâches enfants v2 natives sont chiffrées par le service en amont ([#92](https://github.com/lidge-jun/opencodex/issues/92)). Ignoré en `v1` et `default`. |
| `subagentModels?` | `string[]` | `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini` | Jusqu’à cinq identifiants de modèles natifs non qualifiés, qualifiés par un compte sous la forme `<selector>/<native-openai-model>`, ou routés sous la forme `provider/model`, affichés en tête du sélecteur de sous-agents. Le tableau de bord ne propose que les identifiants natifs non qualifiés et les identifiants routés ; lors de l’enregistrement, il omet les choix exacts qualifiés par un compte. Pour les définir, utilisez `ocx agent subagents set` ou modifiez la configuration. Une liste explicitement vide est conservée. |
| `injectionModel?` | `string` | — | Modèle de sous-agent natif ou routé privilégié dans les consignes de délégation v2 produites par le proxy. |
| `injectionEffort?` | `string` | — | Niveau d’effort privilégié (de `low` à `ultra`), pertinent uniquement avec `injectionModel`. |
| `injectionPrompt?` | `string` | — | Remplace le corps des consignes v2 intégrées. Accepte `{{model}}`, `{{effort}}`, `{{roster}}` et `{{fallback}}`. La présence d’un `injectionModel` suffit pour produire le prompt personnalisé. |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | Contrôle uniquement les consignes développeur v1/v2 produites par opencodex ; ne modifie ni les valeurs natives par défaut des agents, ni les outils, le routage, les listes de modèles ou les plafonds d’effort. |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | Autorise l’écriture de `injectionModel` et, facultativement, de `injectionEffort` comme valeurs natives par défaut de Codex pendant une synchronisation ou un redémarrage. Nécessite `injectionModel`. |
| `subagentModelFallback?` | `string[]` | `[]` | Modèles de repli globaux, classés par priorité, pour les tours enfants créés. |
| `subagentModelFallbackByModel?` | `Record<string, string[]>` | `{}` | Chaînes de repli propres à chaque modèle principal, indexées par l’identifiant demandé. C’est l’emplacement pris en charge pour les métadonnées de repli propres à un rôle ; placer `model_fallback` dans le fichier TOML d’un agent Codex conduit Codex 0.146+ à ignorer ce rôle (#1190). |
| `subagentModelFallbackPollMs?` | `number` | `60000` | Durée de mise en cache de la sonde de disponibilité. Les valeurs inférieures à 1000 ms sont remplacées par la valeur par défaut. |
| `effortCap?` | `string` | — | Plafond strict appliqué aux tours principaux v2 admissibles et aux tours enfants créés qui portent les marqueurs requis. Accepte les valeurs de `low` à `ultra`. |
| `subagentEffortCap?` | `string` | — | Plafond supplémentaire réservé aux tours enfants créés. Lorsque les deux plafonds s’appliquent, le plus bas l’emporte. |
| `agentTaskRecovery?` | `object` | — | Mécanisme expérimental, soumis à activation explicite, pour récupérer les tâches v2 chiffrées par le service en amont lorsqu’elles sont envoyées à des fournisseurs routés. Désactivé sauf si `enabled: true` ; voir [Récupération des tâches v2 chiffrées](#récupération-des-tâches-v2-chiffrées). |

Gérez la surface depuis le tableau de bord ou avec `ocx v2 status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>`. Les changements de mode s’appliquent aux nouvelles sessions. `maxConcurrentThreadsPerSession` est un champ de `PUT /api/v2`, et non une clé de `config.json`. Après l’activation de v2, `ocx v2 threads <n>` écrit `max_concurrent_threads_per_session` sous `[features.multi_agent_v2]` dans le fichier `$CODEX_HOME/config.toml` de Codex.

Le **mode Ultra** — accessible depuis l’interrupteur Sous-agents du tableau de bord, le champ `multiAgentModeHintText` de `PUT /api/v2` et `ocx v2 mode-hint` — écrit `features.multi_agent_v2.multi_agent_mode_hint_text` dans le fichier `$CODEX_HOME/config.toml` de Codex. La commande CLI `ocx v2 mode-hint` conserve cette clé même lorsque `multi_agent_v2` est désactivé ; elle n’active ni ne désactive la fonctionnalité. Cette indication remplace la politique multi-agents que codex-rs déduit du niveau d’effort : tous les modèles et tous les niveaux d’effort reçoivent alors le prompt de délégation Proactive. Elle ne modifie **pas** le niveau d’effort de raisonnement.

La valeur `null` supprime la clé et rétablit la politique fondée sur l’effort (proactive avec ultra, explicite dans les autres cas). Les valeurs vides ou composées uniquement d’espaces sont rejetées, car une substitution vide mais présente masquerait même le message Proactive associé au niveau ultra. Pour que l’interrupteur du mode Ultra soit **activé** dans la page Sous-agents du tableau de bord, la fonctionnalité native doit être active et la surface v2 doit être explicitement sélectionnée (`multiAgentMode: "v2"`, équivalent à `ocx v2 mode v2`). La seule commande `ocx v2 on` ne satisfait pas cette condition du tableau de bord.

L’API de gestion expose `GET`/`PUT /api/v2`, `/api/injection-model`, `/api/effort-caps`, `/api/subagent-models` et `/api/subagent-model-fallback`. Les mises à jour du modèle d’injection sont partielles ; le prompt personnalisé correspond au champ `prompt` de cette API.

La page Codex Auth permet également de modifier l’indicateur natif `default_mode_request_user_input` de Codex (`GET`/`PUT /api/codex-auth/features/default-mode-request-user-input`). Son activation ajoute `[features] default_mode_request_user_input = true` au fichier `$CODEX_HOME/config.toml` de Codex au moyen de la commande officielle `codex features enable|disable`. Cette modification préserve le format du fichier et est retirée lorsque l’option est désactivée. Codex peut ainsi suspendre une session en mode Default et vous poser des questions avec l’outil `request_user_input`. Cet indicateur est encore en développement en amont et ne s’applique qu’aux nouvelles sessions ; l’activation échoue explicitement si la version installée de Codex ne le reconnaît pas encore.

## Liste des modèles et consignes

La liste v2 effective comprend, parmi les modèles configurés, les cinq premiers qui sont visibles dans le sélecteur, classés par priorité, compatibles avec v2 et présents dans le catalogue injecté. Un modèle est admissible en v2 si son choix imposé en amont vaut explicitement `"v2"`, vaut `null` ou est absent. Un véritable choix `"v1"` l’exclut. Les entrées exclues restent dans la configuration afin de pouvoir redevenir admissibles ultérieurement.

La surface est détectée d’après la forme des outils. Un outil `spawn_agent` avec espace de noms, accompagné de `send_input`, `resume_agent` ou `close_agent`, correspond à v1. Un outil `spawn_agent` sans espace de noms, accompagné de `send_message`, `followup_task`, `interrupt_agent` ou `list_agents`, correspond à v2.

En v1, les consignes proactives ne sont ajoutées qu’aux niveaux `max` ou `ultra`. En v2, le proxy ajoute un message développeur uniquement lorsqu’un modèle privilégié, une liste admissible ou une chaîne de repli est défini. Les consignes v2 intégrées sont limitées à 700 caractères ; si nécessaire, la liste des modèles est supprimée en premier. Les consignes sont dédupliquées dans les préfixes rejoués et insérées avant un éventuel `compaction_trigger` final.

`injectionModel` et `injectionEffort` restent indicatifs tant que la synchronisation des valeurs natives par défaut n’est pas activée. Le texte v2 intégré demande à Codex de transmettre à `spawn_agent` les substitutions de modèle et d’effort prises en charge, avec `fork_turns: "none"`. Dans un `injectionPrompt` personnalisé, les valeurs manquantes sont remplacées par une chaîne vide.

## Synchronisation des valeurs natives par défaut de Codex

Lorsqu’il est activé, `syncCodexSubagentDefaults` écrit les champs `[agents] default_subagent_model` et `default_subagent_reasoning_effort`, en les marquant comme appartenant à opencodex. Si des champs cibles existants, non marqués et appartenant à l’utilisateur sont présents, ils sont considérés comme des conflits et restent prioritaires. Toute écriture TOML partielle ou ambiguë échoue de manière sûre. La suppression de `injectionModel` désactive également cette option. Ces valeurs par défaut ne concernent que les nouvelles tâches Codex et ne déclenchent aucune délégation à elles seules.

## Chaîne de repli

Pour un tour enfant créé, l’ordre de repli est le suivant :

1. le modèle principal demandé ;
2. les chaînes propres au modèle dans `subagentModelFallbackByModel`, indexées par le modèle principal ;
3. les entrées globales de `subagentModelFallback`.

Les chaînes de repli propres à un rôle doivent résider dans la configuration d’opencodex. L’ajout de `model_fallback` dans `$CODEX_HOME/agents/*.toml` amène Codex 0.146+ à rejeter le fichier de rôle entier à cause de ce champ inconnu, puis à ignorer le rôle (#1190). Une ancienne ligne `model_fallback` dans le fichier TOML reste lue par souci de rétrocompatibilité, mais `ocx doctor` la signale.

opencodex ignore les candidats désactivés, non routables, en mauvais état, en période de temporisation ou ayant atteint le seuil de quota. L’instantané de disponibilité est mis en cache pendant `subagentModelFallbackPollMs`. Les tâches enfants chiffrées peuvent limiter la chaîne aux cibles ChatGPT natives canoniques ; si aucune ne peut lire la charge chiffrée, la requête échoue au lieu d’envoyer un texte chiffré illisible à une autre destination.

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
  "subagentModelFallbackByModel": {
    "gpt-5.5": ["gpt-5.4-mini"]
  },
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## Récupération des tâches v2 chiffrées

`agentTaskRecovery` est un mécanisme expérimental de compatibilité destiné au cas où un parent ChatGPT natif crée un enfant v2 routé. Il est désactivé par défaut. Lorsqu’il est explicitement activé et que la tâche finale destinée à l’enfant routé contient une charge Fernet autrement illisible, opencodex envoie une requête Responses brute en mode relais vers le point de terminaison fixe `https://chatgpt.com/backend-api/codex/responses`, avec une authentification en mode transmission. ChatGPT renvoie l’instruction en clair au moyen d’un appel de fonction imposé ; avant d’envoyer la requête au fournisseur routé, opencodex convertit uniquement cet élément de tâche en message utilisateur standard.

Il ne s’agit pas d’un déchiffrement local et ce mécanisme ne corrige pas le protocole Codex. Il dépend d’un comportement non documenté du service ChatGPT et peut cesser de fonctionner après une modification de ce service. L’instruction récupérée est une sortie de modèle, et non un texte en clair vérifié cryptographiquement : sa fidélité octet par octet n’est donc pas garantie. En cas d’absence dans le cache propre à cette portée, une requête ChatGPT authentifiée supplémentaire peut être envoyée, consommer le quota du compte et ajouter de la latence avant la requête routée. Les requêtes concurrentes visant la même tâche et la même portée partagent une seule requête de récupération. Un avertissement est affiché au démarrage chaque fois que la fonctionnalité est activée.

Les règles d’admission et de conservation sont volontairement strictes :

- la récupération n’est disponible que lorsque le proxy écoute sur l’interface de bouclage ;
- seul un appelant Codex natif qui présente une paire jeton Bearer/compte ChatGPT concordante est admissible. Cette forme d’identifiant est celle du fournisseur canonique `openai` avec `authMode: "forward"`. La récupération utilise exclusivement la paire de la requête entrante et ne lui substitue jamais une authentification par clé d’API, l’identifiant d’un autre fournisseur ou un autre compte Codex ;
- les appelants qui utilisent `x-opencodex-api-key`, `x-api-key`, des identifiants d’API génériques ou un secret d’admission du proxy continuent de recevoir l’erreur `unreadable_encrypted_agent_task` existante ;
- les identifiants ChatGPT bruts sont envoyés uniquement au point de terminaison ChatGPT codé en dur. Ils ne sont jamais placés dans le corps de la requête, les journaux, les clés de cache ou la requête destinée au fournisseur. La portée du cache en mémoire n’utilise qu’un condensat, calculé avec une clé aléatoire propre au processus, de l’identifiant et du compte de l’appelant ;
- la requête de récupération ne transmet que `authorization`, le `chatgpt-account-id` concordant, `originator` et, facultativement, les métadonnées `openai-beta` et `user-agent`. opencodex définit lui-même `content-type` et `accept` ; aucun autre en-tête de l’appelant ne franchit cette limite ;
- le texte en clair récupéré n’est jamais journalisé ni conservé. Le cache propre au processus est cloisonné par identifiant, fil parent et texte chiffré ; il expire après 15 minutes et est limité à la fois par le nombre d’entrées configuré (200 par défaut, 512 au maximum) et par une taille totale de 8 MiB ;
- toute enveloppe mal formée, tout échec de récupération, dépassement de délai ou échec de validation conserve l’erreur fermée existante. Une annulation par le client renvoie 499. Aucun des deux chemins n’envoie le texte chiffré au fournisseur routé.

### Modèle de menace

Ce mécanisme suppose que l’appelant Codex natif local possède déjà un identifiant ChatGPT valide et que le point de terminaison ChatGPT fixe est digne de confiance pour l’authentifier. Il empêche les appelants génériques utilisant le proxy ou une clé d’API d’employer la fonctionnalité comme oracle de texte en clair, de rediriger les identifiants vers une autre destination, de réutiliser le cache entre comptes ou entre fils, ou de journaliser et conserver des données sensibles. Avant chaque consultation du cache, l’admission vérifie l’émetteur du jeton, son audience, le client Codex, les limites d’expiration et de date de début de validité, ainsi que la correspondance exacte du compte. Le point de terminaison reste l’autorité chargée de vérifier la signature.

Ce mécanisme ne protège pas contre un autre processus exécuté sous le même compte du système d’exploitation, un service ChatGPT ou un modèle de récupération compromis, une injection de prompt dans la tâche chiffrée, des erreurs de transcription du modèle ou l’inspection de la mémoire du proxy actif. La sortie récupérée doit donc être considérée comme une sortie de modèle non fiable, et non comme un texte en clair authentifié.

```json
{
  "agentTaskRecovery": {
    "enabled": true,
    "model": "gpt-5.6-sol",
    "timeoutMs": 45000,
    "cacheEntries": 200
  }
}
```

N’activez cette option que si la requête authentifiée supplémentaire, la consommation de quota, la présence de texte en clair dans le processus et la dépendance à un service privé sont acceptables. Dans le cas contraire, privilégiez un enfant ChatGPT natif ou une délégation hétérogène v1.

Ce mécanisme de récupération s’applique aux enfants routés directement. Au maximum 32 requêtes de récupération peuvent être actives simultanément ; toute absence supplémentaire dans le cache échoue de manière sûre. Pour les tâches chiffrées, le routage par combinaison conserve son filtre existant limité aux cibles natives et n’utilise pas la récupération.

## Plafonds d’effort

Les plafonds s’appliquent uniquement à la fonctionnalité de collaboration v2. Un tour principal est admissible lorsque ses outils exposent v2. Un tour enfant l’est lorsqu’il porte exactement le marqueur codex-rs `x-openai-subagent: collab_spawn` ou `"subagent_kind": "thread_spawn"` dans `x-codex-turn-metadata`, même si les outils terminaux n’exposent plus la collaboration. Les tours principaux v1, `multiAgentMode: "v1"`, ainsi que les tours de compactage, de révision et de consolidation de la mémoire ne sont pas plafonnés.

Un plafond ne peut que réduire l’effort. Le niveau retenu est le niveau annoncé le plus élevé qui ne dépasse pas le plafond. Si le modèle ne propose aucun contrôle d’effort ou si aucun niveau pris en charge ne convient, opencodex supprime le paramètre d’effort et laisse le fournisseur appliquer sa valeur par défaut. `max` et `ultra` sont acceptés, tandis que le tableau de bord propose les niveaux de `low` à `xhigh`.

Pour une présentation destinée aux débutants des comportements v1, default et v2, consultez [Surfaces de sous-agents](/fr/guides/sub-agent-surface/).
