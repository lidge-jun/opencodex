---
title: Espace disque occupé par les fichiers temporaires
description: Ce que sont les fichiers responses-state.json.ocx.*.tmp, pourquoi ils pouvaient s'accumuler et comment récupérer l'espace.
---

Des utilisateurs ont trouvé plusieurs gigaoctets de fichiers nommés comme
`responses-state.json.ocx.<pid>.<seq>.tmp` dans leur répertoire opencodex
(`~/.opencodex` par défaut), dont le nombre augmentait après chaque redémarrage.

## À quoi servent ces fichiers

opencodex conserve un cache de continuation pour que les chaînes
`previous_response_id` survivent au redémarrage du proxy. Il écrit cet
instantané de façon atomique : le contenu va d'abord dans un fichier
temporaire, puis remplace le fichier réel en une seule étape. Cela évite
qu'une panne pendant l'écriture laisse un instantané incomplet.

Le fichier temporaire est normalement supprimé dès la fin du remplacement.
Si le processus meurt entre les deux étapes, il reste sur le disque.

Chaque fichier peut atteindre 24 MB, car l'instantané est réécrit entièrement
au lieu d'être complété. Quelques centaines de fichiers abandonnés occupent
donc vite beaucoup d'espace.

**Il s'agit d'un cache, pas d'un état durable.** Leur suppression ne coûte
rien, hormis le fait que des chaînes de conversation en cours peuvent renvoyer
leur contexte une fois. Ces fichiers ne contiennent ni configuration, ni
identifiants, ni historique.

## Pourquoi ils pouvaient s'accumuler

Un nettoyage existait déjà, mais ne s'exécutait qu'une fois : lorsque le proxy
chargeait le cache de continuation pour la première fois, *avant* toute
écriture par ce processus. Cela avait deux conséquences.

Après une panne et un redémarrage, le balayage arrivait trop tôt pour voir le
fichier temporaire laissé par le processus précédent : un délai de grâce de
15 minutes protège les fichiers en cours d'écriture. Le proxy ne cherchait
ensuite plus rien pendant toute sa durée de vie. Chaque redémarrage ajoutait
un fichier.

Pire, le nettoyage ignorait tout fichier dont l'identifiant de processus
propriétaire était encore actif. Après un redémarrage, le système d'exploitation
réattribue couramment les mêmes identifiants ; un ancien fichier pouvait donc
être pris indéfiniment pour celui d'un processus actif. C'est pourquoi la
croissance suivait les redémarrages.

## Ce que fait désormais opencodex

Le nettoyage se répète sur le minuteur habituel du proxy en arrière-plan, au
lieu de ne s'exécuter qu'au démarrage. Un proxy actif récupère ainsi lui-même
les fichiers abandonnés. Le contrôle de l'identifiant de processus est aussi
ignoré pour les fichiers antérieurs au démarrage actuel : aucun processus
encore actif ne peut en être propriétaire.

Les règles de sécurité restent les mêmes : aucun fichier de moins de 15
minutes n'est supprimé, et le proxy ne supprime jamais un fichier qu'il est
lui-même en train d'écrire.

## Fréquence d'écriture de l'instantané

Les écritures sont temporisées selon la taille du **dernier instantané
effectivement écrit** : tant que ce fichier est petit, la prochaine écriture
est programmée environ deux secondes après un changement ; près de la limite
de 24 MB, l'attente s'étend jusqu'à trente secondes au plus. Un cache qui
vient de grossir conserve donc une fois l'attente courte : la cadence plus
lente s'applique à partir de l'écriture suivante. Une vidange n'est ignorée
que si ce processus a déjà écrit les mêmes octets dans le même fichier, que
le fichier correspond toujours sur disque et que, hors Windows, ses
permissions restent réservées au propriétaire. Un nouveau processus réécrit
une fois un instantané identique ; un fichier dont le contenu ou les
permissions ont été modifiés sous le proxy est réécrit par la voie sécurisée.

Chaque cycle ordinaire en arrière-plan effectue au plus une réécriture
atomique complète. Si le cache de continuation change pendant cette écriture,
opencodex programme une seule écriture supplémentaire au cycle différé
normal, au lieu de réécrire aussitôt l'instantané entier. L'arrêt gracieux
conserve ses nouvelles tentatives limitées après la fin des requêtes en cours,
pour que l'instantané final soit à jour avant la sortie du processus.

Ces mesures maintiennent une fréquence d'écriture à peu près stable à mesure
que le cache grandit, au lieu de resérialiser et remplacer le fichier entier
toutes les deux secondes.

Un arrêt gracieux vide le cache immédiatement plutôt que d'attendre le
minuteur. L'attente plus longue élargit donc surtout la période pendant
laquelle un arrêt brutal peut faire perdre les dernières entrées de
continuation, qui restent un cache. Cette vidange écrit malgré tout sur le
disque et peut échouer comme toute autre écriture ; un arrêt avec un volume
plein ou en lecture seule peut perdre les mêmes entrées.

## Récupérer les fichiers déjà accumulés

Si le proxy fonctionne, le nettoyage s'effectue automatiquement en une ou
deux minutes.

Si le proxy ne démarre **pas** — le cas où les fichiers s'accumulent le plus
vite — vérifiez l'état depuis la ligne de commande :

```bash
ocx doctor
```

La section "Response-state temp files" indique le nombre de fichiers
récupérables et l'espace qu'ils occupent. Elle se contente de les signaler,
sans rien modifier.

Pour les supprimer effectivement :

```bash
ocx doctor --reclaim-response-temps
```

Les deux commandes fonctionnent sans proxy actif. Les fichiers actuellement
verrouillés par un autre processus sont signalés sans être forcés. Une
nouvelle tentative aura lieu au prochain nettoyage, automatiquement si le
proxy fonctionne ou lors de votre prochaine exécution de cette commande.

Si un très grand nombre de fichiers dépasse la capacité d'un passage, la
commande indique combien il en reste pour que vous puissiez la relancer.

Cette procédure vise uniquement les fichiers temporaires des instantanés de
l'état des réponses. D'autres composants écrivent des fichiers temporaires
aux noms similaires ; ils ne sont pas concernés.
