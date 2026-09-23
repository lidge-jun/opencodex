---
title: Inspection des réponses et réponses volumineuses
description: Interaction entre la conservation limitée des diagnostics, l'inspection des flux et la livraison des réponses.
---

OpenCodex limite la taille des diagnostics de réponse conservés sans appliquer
cette limite aux octets livrés au client. Les autres limites des fournisseurs,
des requêtes et du transport s'appliquent indépendamment.

## Réponses JSON et erreurs ordinaires

L'inspection JSON conserve au plus 32 MiB d'octets source. Si le corps dépasse
cette limite, la journalisation abandonne sa copie conservée et continue de
transmettre la réponse originale. Elle n'interprète pas un préfixe tronqué comme
des métadonnées fiables d'usage ou de modèle. L'usage déjà fourni par une autre
voie fiable est préservé ; un usage manquant n'est pas remplacé par un zéro
inventé. Les diagnostics d'erreur ordinaires non JSON ne conservent que les
premiers 8 KiB et passent par la logique de masquage existante.

Le client reçoit les blocs au fil de sa lecture, sans attendre que l'inspection
diagnostique du corps entier s'achève. Un échec de lecture est enregistré comme
502 et une annulation comme 499 dans l'historique des requêtes ; ces résultats
diagnostiques ne réécrivent pas les en-têtes HTTP déjà envoyés. La journalisation
est finalisée une seule fois.

## Réponses en flux

L'inspection SSE native se met en pause lorsqu'elle prend trop d'avance sur la
consommation du client. Sa marge est de 32 MiB, plus le surcoût des blocs source
et de la prélecture native ; ce n'est ni une limite à la taille totale de la
réponse, ni un plafond sur toute la mémoire du processus. Une réponse plus
longue reste inspectée jusqu'à son événement de fin réel, y compris l'usage
final et l'état de continuation.

Après la déconnexion du client, la vidange limitée existante peut encore
observer une fin tardive pendant au plus 15 secondes ou 32 MiB d'inspection
supplémentaire. Un arrêt forcé est différent : il abandonne les candidats
inachevés au lieu de les enregistrer comme réponses terminées. Le choix du
transport existant et les limites mémoire de WebSocket restent inchangés. Aucun
nouveau paramètre de configuration n'est nécessaire.
