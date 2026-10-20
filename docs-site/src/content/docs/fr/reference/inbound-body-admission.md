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

Quand la limite effective dépasse 256 MiB, chaque requête HTTP concernée doit réserver toute
sa marge par requête **avant toute lecture du corps**. Le budget d'admission partagé par le
processus passe de 512 MiB à **2 GiB**, y compris lorsque plusieurs écouteurs partagent ce
processus. Ce budget est distinct de `appOwnedMemoryBudgetMb`.

Avant la fin de l'analyse JSON avec contrôle de taille, ni un petit `Content-Length` ni un petit
corps compressé sur le réseau ne réduisent la réservation. L'admission ne considère pas ces
valeurs comme une preuve fiable de la taille décodée ou normalisée du JSON.

Après une analyse JSON réussie dans les limites de taille, le lecteur réduit la réservation
au maximum des octets observés sur le réseau, des octets décodés et de la mesure existante du
JSON normalisé lorsqu'un traducteur fournit un budget pour cette mesure. La réservation ne
peut que diminuer et reste plafonnée à la marge initiale par requête ; une mesure du JSON
normalisé supérieure à cette marge ne l'augmente jamais. Les contrôles UTF-8 et de JSON
resérialisé sont conservés ; la longueur d'entrée ne remplace pas la taille potentiellement
plus grande du JSON normalisé.

Avec une limite par requête de 512 MiB, le budget peut admettre jusqu'à **4 envois réservant
chacun 512 MiB** avant la mesure et la réduction des réservations. Ce n'est pas une limite fixe
de 4 requêtes après l'analyse : par exemple, **8 très petites requêtes peuvent diffuser leur
réponse simultanément** lorsque les réservations réduites laissent de la place aux admissions
suivantes, sous réserve du budget partagé et des autres limites.

La réservation réduite reste détenue pendant le travail asynchrone et l'attente du fournisseur,
jusqu'à la fin du flux de réponse (EOF), une erreur ou la fin de l'annulation. L'analyse seule
ne la libère pas. Si le client se déconnecte, elle reste détenue jusqu'à la fin de l'annulation
côté producteur. Elle est libérée exactement une fois, même si erreur, abandon et annulation
se produisent en concurrence.

Les points de terminaison POST concernés sont `/v1/responses`, `/v1/responses/compact`,
`/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`,
`/v1/images/generations`, `/v1/images/edits` et `/v1/alpha/search`.
Les images, la recherche et le comptage de jetons conservent leurs limites configurables
existantes par corps. Les traductions directes internes et les appels combo ne réservent pas
une deuxième marge HTTP. Les limites de gestion, d'audio, d'historique de contexte et de
WebSocket restent inchangées.

Un réglage absent ou égal à zéro, ou une limite effective inférieure ou égale à 256 MiB,
n'active pas ce contrôle supplémentaire de simultanéité. Les limites existantes sur le nombre
de requêtes et les autres ressources continuent de s'appliquer.

## Refus temporaire ou corps trop volumineux

Si la marge complète est temporairement indisponible, la requête peut rejoindre une **file
FIFO de 32 requêtes en attente au maximum**, avec une **attente limitée à 120 secondes**.
Les corps restent non lus pendant l'attente. Une réduction après mesure ou une libération
finale permet d'admettre les requêtes dans l'ordre de la file. Une requête abandonnée pendant
l'attente est retirée de la file et son corps non lu est annulé sans être consommé.

Une file pleine ou une attente expirée entraîne HTTP **503**, `Retry-After: 1` et le code
d'erreur `server_busy`, avant l'analyse du corps ou l'envoi au fournisseur. Les corps non lus
sont annulés lors du refus. Les clients Messages et de comptage de jetons reçoivent une erreur
au format Anthropic de type `overloaded_error` ; les clients compatibles OpenAI reçoivent
`server_error`. Les contrôles d'authentification et d'origine précèdent l'admission et la mise
en file.

Respectez l'en-tête de nouvelle tentative et la temporisation du client. L'attente bornée et
les réservations mesurées réduisent les refus de capacité évitables, sans éliminer toutes les
réponses 503. Augmenter encore la limite par requête ne résout pas un épuisement durable de
la capacité.

Un corps dépassant sa limite par requête suit toujours le traitement HTTP **413** existant.
Une taille déclarée excessive emprunte cette voie plutôt que de devenir un refus pour serveur
occupé.

## Ce que mesure le budget

Le budget de **2 GiB** compte des unités d'admission : les marges complètes avant l'analyse,
puis les réservations mesurées. Il **ne borne ni la RSS du processus ni le tas des objets
analysés** et ne garantit pas une consommation mémoire inférieure à 2 GiB. Le décodage, les
chaînes, les graphes d'objets, les copies de requêtes et les autres états de l'application
consomment davantage de mémoire.

Le passage du budget partagé de 512 MiB à 2 GiB quadruple la réservation totale possible.
Les déploiements qui choisissent une limite supérieure à 256 MiB peuvent désormais admettre
4 envois réservant chacun 512 MiB au lieu d'un seul : leur pic potentiel de consommation
mémoire augmente. Les objets analysés et les copies peuvent porter la mémoire réelle au-delà
du budget d'admission. Les limites par défaut ou inférieures n'activent pas ce contrôle et
conservent leur comportement existant.

Conservez si possible la limite par requête par défaut. Augmentez-la volontairement si un
parcours avec un historique volumineux l'exige, en tenant compte du pic mémoire potentiellement
plus élevé et de l'attente bornée.
