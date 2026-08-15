---
title: Contrat de qualité des pull requests
description: Préparation à la revue, responsabilité des contributeurs, niveaux de confiance et politique de fermeture des pull requests OpenCodex.
---

## Vous n’avez pas besoin d’autorisation pour corriger un problème

Une pull request non planifiée qui corrige un problème que vous avez réellement rencontré est la bienvenue.
Plusieurs des meilleurs correctifs du projet sont arrivés ainsi : un modèle routé qui se bloquait après des
appels d’outils, un fournisseur qui envoyait de mauvais paramètres de modèle ou des images supprimées des
résultats d’outils. Aucun n’est né d’une discussion de planification, et une règle qui l’aurait exigée nous
aurait privés de tous ces correctifs.

Ouvrir d’abord une issue est réellement utile pour les travaux plus vastes ou fortement orientés conception :
s’accorder sur l’approche évite de construire la mauvaise solution. C’est un conseil, pas une condition d’admission.

## Ce qu’affirme une pull request prête

Marquer une PR comme prête pour la revue revient à affirmer que la modification est complète, comprise et
testée. Son ouverture ne transfère pas aux responsables la responsabilité de votre branche.

Les auteurs doivent comprendre chaque ligne modifiée, indiquer les commandes et résultats exacts qui
justifient toute affirmation de validation, ajouter une couverture de régression ciblée pour les changements
de comportement et rester disponibles pour résoudre les échecs de CI et les remarques de revue. Les
responsables identifient les problèmes ; ils n’ont pas à réparer les branches des contributeurs, écrire les
tests manquants ou convertir les constats automatisés en correctifs à votre place.

« Testé » ou « la CI passe », sans commandes ni résultats précis, ne constitue pas une preuve.

## Contrôles automatisés

Trois contrôles déterministes précèdent la revue humaine. Chaque message d’échec indique précisément ce qu’il faut modifier :

- **Qualité de la PR (`enforce-target`).** Les pull requests doivent cibler `dev` et comporter une vraie
  description : un **Résumé** de la modification et de sa raison, ainsi qu’un **Plan de test** ou un contenu
  équivalent. Lorsque le diff modifie des fichiers sous `gui/`, ou lorsque GitHub renvoie une liste incomplète
  des fichiers modifiés pour un diff important, la description doit inclure une capture d’écran de l’interface.
  Le contrôle conserve la PR en brouillon et publie un commentaire jusqu’à l’ajout de la capture. Une liste
  incomplète est traitée par prudence comme une modification de l’interface. Un responsable peut lever cette
  exigence pour une modification de `gui/`, une classification erronée du chemin GUI ou un faux positif dû à
  une liste incomplète, en ajoutant le label `gui-screenshot-waived`. Son ajout ou son retrait réévalue
  immédiatement le contrôle. Les anciens commentaires de responsable tels que « no gui changes » restent
  reconnus lors de l’événement PR suivant pour assurer la compatibilité, mais les commentaires eux-mêmes ne
  déclenchent plus le contrôle privilégié. Un contributeur ne peut pas lever lui-même cette exigence.

  Les PR de contributeurs sans droit de push sur le dépôt s’ouvrent en brouillon et le restent jusqu’à ce que
  les quatre cases de préparation à la revue soient cochées dans la description : CI locale verte, branche sur
  le dernier commit de `dev`, tous les constats valides de Codex et CodeRabbit corrigés, et confirmation de
  disponibilité pour la revue. Lorsque les quatre cases sont cochées, le contrôle marque la PR comme prête et
  avertit les responsables répertoriés dans `MAINTAINERS.md`, à l’exclusion de l’auteur. L’état du contrôle et
  les actions attendues figurent dans un unique commentaire consolidé, réécrit à chaque exécution.

  La validation est liée au commit exact que pointait la tête de la PR. Tout nouveau push replace la PR en
  brouillon, réinitialise la liste et la notification, puis demande de tester et de cocher de nouveau les cases
  pour le dernier code. Recibler la PR vers `dev` efface automatiquement le message de mauvaise branche, mais
  le brouillon subsiste jusqu’à l’achèvement de la liste.

  Avant d’accepter la liste, le contrôle vérifie les affirmations qu’il peut lui-même confirmer : la branche
  doit être sur le dernier commit de `dev`, ou au plus 10 commits derrière, et tous les fils de revue Codex et
  CodeRabbit créés par un robot sur la tête actuelle doivent être résolus. Les fils non résolus d’autres auteurs
  ne bloquent pas. La case de CI locale est uniquement une attestation de l’auteur : les contributeurs depuis un
  fork ne peuvent pas démarrer la CI du dépôt, seul un responsable le peut. Le contrôle ne contredit donc jamais
  cette case, mais tout nouveau push réinitialise toutes les cases.

  Les constats CodeRabbit hors de la plage du diff, signalés seulement dans le corps d’une revue sur la tête
  actuelle, s’ajoutent au nombre d’éléments non résolus tant qu’un fil du robot reste ouvert. Résoudre tous les
  fils du robot valide la case. Une affirmation réfutée décoche sa case et conserve la PR en brouillon. Lorsque
  la liste et tous les contrôles sont verts, le label `review-ready` est ajouté comme indicateur visible.

  Les modifications des commentaires de statut CodeRabbit ne déclenchent pas le contrôle. Le statut de commit
  `CodeRabbit` réussi réveille le contrôle fiable de la branche par défaut au moyen de l’événement `status`.
  Le contrôle associe ce SHA à une seule PR ouverte dont la tête correspond encore, puis relit les fils et les
  corps de revue avant de modifier la liste, les labels, le commentaire ou l’état de brouillon. Une association
  ambiguë ou obsolète est ignorée, et aucun code de la tête de la PR n’est exécuté avec le jeton d’écriture du contrôle.

- **Hygiène.** Les changements de comportement exigent un test. Les nouvelles suppressions de règles de lint ou
  de types, les tests ciblés ou ignorés, les blocs catch vides, la modification de sorties générées et celle
  d’un lockfile sans son manifeste nécessitent chacun un label d’approbation explicite. Une modification limitée
  à un commentaire dans un fichier source ne change pas le comportement et n’exige aucun test.

- **CI multiplateforme.** Pour les changements concernés, la suite est fragmentée sous Linux et exécutée
  intégralement sous macOS pour chaque pull request. La voie Windows principale ne s’exécute actuellement que
  sur lancement manuel avec `workflow_dispatch` ; elle ne bloque ni les PR ni les promotions. Des tests ciblés
  du trousseau système et de l’installation npm globale peuvent toutefois inclure Windows.

  Le workflow est créé pour **toutes** les pull requests, quelle que soit leur branche de base, y compris une PR
  enfant empilée dont la base est la tête d’une autre PR ouverte. Le filtre interne des changements, et non la
  branche de base, décide quelles tâches coûteuses s’exécutent ; une PR limitée à la documentation reçoit tout
  de même un contrôle agrégé explicite.

- **Label de type.** Le contrôle `label` déduit `bug`, `enhancement`, `documentation` ou `chore` du titre de la
  PR. Si le titre ne possède aucun préfixe reconnu, par exemple `stack 3/5: …`, le contrôle examine les commits,
  qui restent généralement conventionnels. Les commits de la famille `chore` (`test:`, `ci:`, `refactor:`) ne
  l’emportent pas sur un `fix:` ou un `feat:`. Une PR qui mélange réellement plusieurs types reste sans label
  plutôt que d’en recevoir un au hasard, et un label défini par une personne n’est jamais écrasé.

CodeRabbit examine chaque PR et ses constats sont consultatifs. Corrigez ce qui est juste et expliquez pourquoi
un constat est erroné lorsqu’il l’est. CodeRabbit ne bloque pas une fusion.

### Prise d’effet d’une modification du workflow

`enforce-target` et `label` utilisent une automatisation fiable chargée depuis la branche par défaut. Le contrôle
de PR s’exécute sur les événements `pull_request_target` et `status` de CodeRabbit, tous deux chargés depuis la
branche par défaut du dépôt. Le comportement disposant de droits d’écriture ne change donc qu’après la promotion
de la révision du contrôle vers `main`. Le workflow de CI multiplateforme s’exécute sur `pull_request` et prend
effet dès qu’il se trouve sur la branche ciblée.

## Surfaces nécessitant un parrainage

L’authentification, la gestion des informations d’identification, les workflows GitHub Actions, l’automatisation
des versions et l’installation de dépendances exigent le parrainage d’un responsable (`maintainer-sponsored`)
avant la fusion. Une mauvaise fusion sur ces surfaces est coûteuse et difficile à annuler ; ce sont donc les
seules surfaces soumises à cette règle. Toutes les autres restent ouvertes.

## Fermeture d’une pull request

Une PR bloquée par des remarques de revue non résolues peut être fermée, avec une raison clairement indiquée.
La fermeture n’est pas un jugement sur le contributeur : rouvrez la PR lorsque la raison donnée est résolue,
ou remplacez-la par une nouvelle PR propre. Demandez des précisions si la raison n’est pas claire.
