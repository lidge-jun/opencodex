---
title: Référence de la CLI
description: Répartition des commandes, codes de sortie et liens vers toutes les familles de commandes ocx.
---

L’interface en ligne de commande d’opencodex est `ocx`. La première commande détermine l’opération à exécuter. Les alias documentés, tels que `setup`/`init`, `restore`/`eject` et `models`/`model`, déclenchent la même opération. Une commande inconnue ou une syntaxe de commande non valide produit une erreur.

Exécutez `ocx help` (ou `ocx --help` / `ocx -h`) pour afficher l’aide générale. Pour une commande enregistrée dans la table d’aide, exécutez `ocx help <command>`, `ocx <command> --help` ou `ocx <command> -h`. Les commandes d’aide et de version sont en lecture seule : elles ne démarrent, n’arrêtent, n’installent, ne désinstallent ni ne réécrivent l’état de Codex ou d’opencodex.

## Familles de commandes

- [Cycle de vie](/fr/reference/cli/lifecycle/) — configuration initiale, cycle de vie du proxy et du service, état de santé, diagnostics, synchronisation du catalogue, tableau de bord et mises à jour.
- [Fournisseurs, comptes et modèles](/fr/reference/cli/providers-accounts/) — configuration des fournisseurs, authentification, pools d’identifiants, quotas, modèles personnalisés, visibilité, modèles sélectionnés et limites de contexte.
- [Agents, routage et intégrations](/fr/reference/cli/agents/) — contrôles multi-agents, combinaisons, observabilité, clés d’admission, intégrations clientes, paramètres d’exécution et configuration validée.

## Fonctionnement sans interface interactive

Les commandes de gestion communiquent avec l’API de gestion du proxy actif. Elles s’appuient sur le port d’exécution enregistré et sur des contrôles d’identité, plutôt que sur un second chemin de configuration. Un proxy arrêté ou inaccessible est représenté par une réponse HTTP 503 et entraîne un code de sortie CLI non nul. Les commandes explicitement documentées comme des opérations de configuration hors ligne peuvent, quant à elles, valider et modifier le fichier de configuration sans proxy actif.

L’affichage d’une liste ou d’un état est l’action par défaut lorsqu’il n’y a aucune ambiguïté. Utilisez `--json` pour obtenir des instantanés structurés et `ocx observe logs --follow --jsonl` pour suivre un flux de journaux de requêtes. Le thème, la langue, la navigation et les autres états purement visuels du navigateur n’ont pas d’équivalent dans la CLI. La configuration de Cloudflare Tunnel ne fait pas partie de cet ensemble de commandes.

## Codes de sortie et confirmation

Une commande réussie renvoie le code 0. Une syntaxe non valide, une commande ou une ressource inconnue, l’échec d’une opération d’API ou l’indisponibilité d’un service requis produit un code non nul. Plus précisément, `ocx health` renvoie 0 uniquement lorsque le proxy est sain, et 1 dans le cas contraire ; cette commande peut donc servir de sonde de service. Les scripts doivent tester le code de sortie plutôt que d’analyser le texte destiné aux utilisateurs.

Les opérations de suppression destructive, d’importation, de consommation de crédits et de mise à jour qui annoncent une confirmation exigent `--yes` en mode non interactif. Ce drapeau constitue un consentement explicite : son absence ne doit jamais confirmer silencieusement l’opération.

## Version et cibles de répartition internes

`ocx --version`, `ocx -v` et `ocx version` affichent une seule ligne de version exploitable par un script, puis se terminent.

Deux cibles de répartition sont volontairement absentes de l’aide habituelle : `__refresh-version [preview]` actualise le cache des notifications de mise à jour dans un processus détaché, tandis que `__gui-update-worker <job-id> [latest|preview] [restart]` exécute une tâche de mise à jour du tableau de bord. Il s’agit de détails d’implémentation, et non de commandes publiques stables. Le tableau de bord enregistre le PID du processus de travail, récupère une tâche active dont le processus est mort, considère comme obsolètes après dix minutes les anciens enregistrements actifs sans PID et protège un processus vivant contre les mises à jour concurrentes.
