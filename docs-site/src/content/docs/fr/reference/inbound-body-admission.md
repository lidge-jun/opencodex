---
title: Admission des corps de requête entrants
description: Effet de l'augmentation des limites de corps sur les requêtes HTTP simultanées, les tentatives et le décompte mémoire.
---

La [référence de configuration des fournisseurs](/fr/reference/configuration/providers/) décrit
`maxInboundBodyBytes`, la taille décodée maximale d'un corps JSON entrant. La valeur par défaut
reste 256 MiB et les valeurs configurées restent comprises entre 1 MiB et 512 MiB. Redémarrez le
proxy après avoir modifié la limite afin que l'écouteur et les lecteurs utilisent ensemble la
valeur voulue.

## Augmenter la limite modifie la simultanéité

Quand la limite résolue dépasse 256 MiB, chaque requête HTTP concernée réserve toute sa marge
configurée dans un budget d'admission partagé de 512 MiB pour le processus entier. Au plus une
requête de ce type peut donc s'exécuter à la fois, même si plusieurs écouteurs partagent le
processus. Les petits corps réservent eux aussi toute la marge ; ni un petit Content-Length ni
la compression ne contournent l'admission. La réservation demeure jusqu'à la fin du flux de
réponse, son échec ou la fin de l'annulation, et pas seulement jusqu'à l'analyse du JSON entrant.

Les points de terminaison POST concernés sont `/v1/responses`, `/v1/responses/compact`,
`/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`,
`/v1/images/generations`, `/v1/images/edits` et `/v1/alpha/search`.
Les images, la recherche et le comptage de jetons conservent leurs limites configurables
existantes par corps. Les traductions directes internes et les appels combo ne réservent pas
une deuxième marge HTTP. Les limites de gestion, d'audio, d'historique de contexte et de
WebSocket restent inchangées.

Un réglage absent ou égal à zéro, ou une limite résolue inférieure ou égale à 256 MiB,
n'active pas ce contrôle supplémentaire de simultanéité. Les limites existantes sur le nombre
de requêtes et les autres ressources continuent de s'appliquer.

## Refus temporaire ou corps trop volumineux

Si aucune marge n'est temporairement disponible, le serveur renvoie HTTP **503**,
`Retry-After: 1` et le code d'erreur `server_busy`, avant l'analyse du protocole ou l'envoi au
fournisseur. Les clients Messages et de comptage de jetons reçoivent une erreur au format
Anthropic de type `overloaded_error` ; les clients compatibles OpenAI reçoivent
`server_error`. Réessayez après la fin de la requête en cours, en respectant l'en-tête de
nouvelle tentative et la temporisation du client. Augmenter encore la limite du corps ne
résout pas l'indisponibilité de la marge.

Un corps dépassant sa limite par requête suit toujours le traitement HTTP **413** existant.
Une taille déclarée excessive emprunte cette voie plutôt que de devenir un refus pour serveur
occupé. Une déconnexion conserve le comportement d'annulation existant. Les contrôles
d'authentification et d'origine précèdent ce contrôle de simultanéité.

## Ce que mesure le budget

512 MiB est la somme des marges admises par requête, **pas une garantie que la mémoire du
processus restera sous 512 MiB**. Le décodage, les chaînes, les graphes d'objets, les copies
de requêtes et les autres états de l'application consomment davantage de mémoire. Les mesures
existantes des octets UTF-8 et du JSON resérialisé sont conservées ; la longueur de l'entrée
en octets ne remplace pas la taille potentiellement plus grande du JSON normalisé.

Pour des petites requêtes parallèles, conservez si possible la limite par défaut. Augmentez-la
volontairement pour un parcours avec un historique volumineux, en acceptant la restriction de
simultanéité supplémentaire.
