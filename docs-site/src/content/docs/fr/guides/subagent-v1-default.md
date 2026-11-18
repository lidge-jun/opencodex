---
title: Pourquoi v1 est la surface de sous-agent par défaut
description: Ce que bloque la limite des tâches chiffrées en v2, pourquoi OpenCodex livre désormais v1 et comment utiliser malgré tout v2.
---

OpenCodex s'installe avec la surface de sous-agent réglée sur **v1**. Les pages
Dashboard, Models et Subagents demandent toutes confirmation avant de passer à
**base** ou **v2** et renvoient vers cette page. La CLI ne demande rien.

La raison est précise : sur le chemin v2 chiffré inchangé, une tâche confiée par un modèle ChatGPT natif à un modèle routé est illisible pour ce dernier. Une telle tâche échoue à cette frontière, par exemple lorsqu’un parent GPT lance un enfant Grok, Claude ou GLM. L’option expérimentale ci-dessous modifie la production des nouveaux messages sans déchiffrer les anciens.

## V2 facultatif avec messages de tâche en clair

**V2 · tâches en clair** (`v2-plaintext`) sélectionne V2 pour les nouvelles conversations sans activer la priorité V2 globale. Il conserve les noms de tâche V2, la hiérarchie, les suivis, l’annulation et la concurrence, et utilise le compilateur expérimental en clair pour les requêtes Responses ChatGPT canoniques admissibles. Les conversations existantes conservent leur sélection ; une mise à jour ne choisit pas ce mode automatiquement.

Les choix du catalogue concernent les nouvelles sessions. Le compilateur suit le réglage actuel pour chaque requête canonique admissible ultérieure, y compris dans les sessions V2 existantes. La sélection V2 conservée ne dispense pas ces requêtes de compilation. Le mode et la valeur explicite `plaintextV2AgentMessages: true` activent chacun indépendamment le compilateur.

Dans ce mode, la continuation locale par identifiant de réponse exige la même identité de clé API opencodex admise et le `thread-id` propre à la requête. Un fil parent ne donne pas accès à la tâche conservée d’un enfant. Sans l’une de ces identités, après un redémarrage du proxy ou pour les anciennes entrées de cache non liées, renvoyez la conversation complète sans `previous_response_id`. L’état conservé dans ce mode reste lié après changement de mode. En `v1` par défaut, l’état non lié conserve le comportement de continuation limité au fil parent, y compris pour les appelants de bouclage.

Le tableau de bord demande de reconnaître que le texte peut rester dans l’historique Codex, les requêtes du fournisseur sélectionné et l’état local de réponse et de débogage, y compris les instantanés ou fichiers de débordement sur disque. HTTPS et l’authentification restent actifs ; aucun appel de récupération supplémentaire n’est ajouté. Les tâches déjà chiffrées ne sont pas déchiffrées, l’historique n’est pas réécrit et la désactivation ne supprime pas les copies conservées. Un comportement non pris en charge du client ou du backend peut toujours échouer. Les modes v1 et natif-v1/routé-v2 restent disponibles.

```bash
ocx v2 mode v2-plaintext --live --acknowledge-plaintext-agent-messages
```

Pour la cible active, vérifiez ensuite `ocx v2 status --live --json`. Pour la cible locale, omettez `--live` dans les deux commandes et vérifiez `ocx v2 status --json` : l’état configuré et la convergence du catalogue ne prouvent pas qu’une délégation réelle réussit. Pour quitter ce mode, choisissez-en explicitement un autre ; la préférence indépendante `plaintextV2AgentMessages` est conservée.

## Ce que vous voyez alors

La création de l'agent est rejetée au lieu de produire silencieusement une
tâche enfant vide :

```json
{
  "error": {
    "code": "unreadable_encrypted_agent_task",
    "message": "Routed V2 worker task is encrypted for the native ChatGPT backend and cannot be read by the selected provider. Use plaintext V2 agent-message delivery or select a native ChatGPT model."
  }
}
```

Le serveur renvoie HTTP 400 sans jamais renvoyer le texte chiffré. Cet échec
fermé est volontaire : transmettre une charge illisible donnerait à l'enfant
une consigne vide et conduirait à une réponse erronée présentée avec assurance.

## Pourquoi cela se produit

![Comparaison de la même délégation sur deux voies. En v1, un parent ChatGPT envoie une tâche en texte clair via OpenCodex ; elle franchit la frontière fournisseur et l'enfant routé la lit. En v2, le parent envoie encrypted_content créé par le backend ChatGPT ; OpenCodex ne peut pas le déchiffrer. La tâche s'arrête donc à la frontière fournisseur et la requête échoue avec unreadable_encrypted_agent_task.](../../../../assets/subagent-v2-encrypted-task.svg)

En v1, le parent émet la tâche de l'enfant en texte clair. OpenCodex la lit et
l'achemine ; l'enfant routé reçoit une consigne exploitable.

En v2, le parent émet la tâche sous forme de `encrypted_content`, produit par
le backend ChatGPT. La clé reste dans ce backend. OpenCodex ne l'a jamais eue :
le proxy ne peut donc rien déchiffrer ni réécrire. La valeur est réellement du
texte chiffré, et non du texte clair caché derrière un indicateur. La limite
est structurelle, pas un défaut de configuration : aucun réglage du proxy ne permet le déchiffrement local.

Aucun réglage du proxy ne permet le déchiffrement local. L’option expérimentale `agentTaskRecovery` peut demander au backend ChatGPT de récupérer les tâches éligibles ; elle ne les déchiffre pas localement. Les règles d’autorisation, d’éligibilité et d’échec décrites plus haut restent applicables.

Trois configurations restent possibles, ce qui éclaire la forme de l'échec :

| Topologie | v1 | v2 |
| --- | --- | --- |
| Parent ChatGPT vers enfant routé | fonctionne | **échoue par défaut** ; voir le relais optionnel ci-dessous |
| Parent routé vers enfant routé | fonctionne | fonctionne |
| Parent ChatGPT vers enfant ChatGPT | fonctionne | fonctionne — le backend peut déchiffrer ce qu'il a produit |

Le backend peut toujours lire son propre texte chiffré. Seul le franchissement
de la frontière échoue.

## Est-ce corrigé en amont ?

Pas encore, du moins pas pour la partie décisive. Le projet amont a fusionné
[openai/codex#35845](https://github.com/openai/codex/pull/35845), qui ajoute
la prise en charge des messages de collaboration en texte clair, mais du côté
de la *réception*. Il traite du texte clair déjà produit ; il ne fait pas en
sorte qu'un parent OpenAI le produise.

L'envoi reste un problème ouvert :
[#36376](https://github.com/openai/codex/issues/36376), reproduit sur les CLI
0.146 à 0.151 sous Windows, macOS et Linux, et
[#37197](https://github.com/openai/codex/issues/37197), qui nomme directement
la pièce manquante : une règle de livraison côté envoi. Aucun des deux n'a
d'engagement d'un mainteneur ni de date prévue.

OpenCodex a consigné la conséquence dans [#92](https://github.com/lidge-jun/opencodex/issues/92),
fermée sans suite prévue : rien dans ce dépôt ne peut la corriger. L'issue
renvoie donc aux travaux en amont, plutôt qu'à une tâche en attente ici.

## Fonctionnement actuel des trois modes

| Mode | Surface | Quand le choisir |
| --- | --- | --- |
| **v1** (par défaut) | Chaque modèle annonce les outils de création classiques avec espace de noms. Une création peut désigner directement un autre modèle. | Si vous déléguez entre fournisseurs. C'est le réglage livré par défaut. |
| **base** | Épinglages des modèles en amont : Sol et Terra utilisent v2, Luna utilise v1, les modèles non épinglés suivent le propre indicateur de Codex. | Si vous voulez la surface prévue par Codex pour chaque modèle et ne déléguez qu'au sein d'un fournisseur. |
| **v2** | Chaque modèle annonce les outils concurrents sans espace de noms. | Si vous voulez le nouveau modèle de sessions concurrentes et que parent et enfant restent du même côté de la frontière. |

base figure en deuxième position, car ses épinglages placent Sol et Terra —
les deux modèles depuis lesquels on délègue le plus souvent — en v2. base
n'est pas un compromis pour ce problème : une création ChatGPT vers un modèle
routé s'y comporte comme en v2.

## Si vous avez déjà choisi base ou v2

Rien n'a été modifié pour vous. La mise à niveau vers une version qui livre ce
réglage par défaut ne réécrit pas un paramètre existant ; le tableau de bord
affiche l'avis une fois et attend votre réponse.

- **Continue** conserve le mode actuel et cesse de poser la question.
- **Switch to v1** active v1 et cesse de poser la question.

Chaque réponse est enregistrée et l'avis ne revient pas. Si vous fermez
l'avis sans répondre, il réapparaît à la prochaine ouverture du tableau de bord.

Les changements de choix du catalogue s'appliquent aux **nouvelles** sessions Codex ; le compilateur en clair suit le réglage actuel pour les requêtes admissibles, y compris les requêtes ultérieures des sessions V2 existantes. Lancez
une nouvelle session après votre choix. Si un hôte App durable affiche encore
l'ancienne surface, exécutez `ocx sync` et redémarrez cette surface Codex.

## Si vous voulez tout de même v2

Voici quatre possibilités, dans l'ordre où la plupart des utilisateurs
devraient les essayer :

1. **Keep ChatGPT on v1.** Dans v2, l'option `keepNativeChatGptOnV1` laisse
   Sol et Terra sur la surface v1 pour qu'ils puissent toujours lancer Grok ou
   Claude, tandis que les parents routés utilisent v2. C'est la solution la
   plus proche d'une combinaison des deux.
2. **Delegate within one provider.** Un parent routé lançant un enfant routé
   transmet du texte clair en v2 et fonctionne normalement.
3. **Trust a direct key-auth Responses relay.** Un fournisseur explicitement
   marqué `allowEncryptedV2AgentTasks: true` reçoit la charge opaque au lieu
   de l'erreur 400. Réservez ce réglage aux destinations dont vous savez
   qu'elles peuvent consommer cette charge.
4. **Enable `agentTaskRecovery`.** Fonction expérimentale désactivée par
   défaut. Elle récupère via le backend ChatGPT les éléments chiffrés
   illisibles `NEW_TASK`, `MESSAGE`, `FOLLOWUP_TASK` et `FINAL_ANSWER`, au
   prix de quota, de latence et d'une dépendance à un comportement non
   documenté ; la récupération combo reste limitée aux tours des enfants
   lancés, et les fragments de jetons découpés restent non pris en charge.

Consultez [Surface des sous-agents](/fr/guides/sub-agent-surface/) pour le
fonctionnement détaillé de chaque option et
[Configuration des agents](/fr/reference/configuration/agents/) pour les réglages.

## Quand cette page deviendra inutile

Lorsqu'une version en amont permettra à un parent ChatGPT natif d'émettre la
tâche d'un enfant routé en texte clair, la raison de ce réglage par défaut
disparaîtra. Le mode par défaut reviendra alors à base, la confirmation ne
s'affichera plus et cette page relèvera de l'historique plutôt que du conseil.

## Changer de mode

Dashboard, Models et Subagents proposent le sélecteur v1/base/v2 et l’option `v2-plaintext` ; cette dernière exige un consentement explicite. Depuis la CLI :

```bash
ocx v2 status
ocx v2 mode v1
```

La CLI ne demande pas de confirmation interactive ; l’entrée en `v2-plaintext` exige le drapeau de consentement indiqué ci-dessus.

## Limite de sous-agents simultanés

Dans **Models → Model settings**, le réglage de limite des sous-agents définit le nombre maximal
de sous-agents simultanés, sans compter l'agent principal. Il reste disponible en v1, base et v2,
y compris en mode hybride lorsque le drapeau v2 global est désactivé. Le choix du mode est
indépendant de cette limite.

Augmenter la limite autorise davantage de sous-agents, sans les créer automatiquement ni garantir
une exécution plus rapide. Lancez une nouvelle session Codex après modification. Si un hôte App
de longue durée utilise encore l'ancienne limite, redémarrez cet hôte.
