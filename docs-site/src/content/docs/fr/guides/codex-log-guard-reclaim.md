---
title: Récupération d’espace avec Codex Log Guard
description: Récupérez manuellement les pages libres du stockage SQLite des journaux de diagnostic Codex par un compactage incrémental borné.
---

Reclaim est l’étape manuelle de récupération d’espace de Codex Log Guard. Elle compacte la base de données canonique `logs_2.sqlite` de Codex uniquement lorsque la base et l’environnement d’exécution passent les mêmes contrôles de sécurité que ceux de la protection Log Guard.

Reclaim n’est **jamais planifié automatiquement** et ne s’exécute pas simplement parce que la page Stockage est ouverte. Le tableau de bord exige une action Compact explicite et une seconde confirmation avant d’envoyer la requête de modification.

## Fonctionnement de Reclaim

OpenCodex effectue une séquence de maintenance hors ligne et bornée :

1. résoudre le chemin canonique de `logs_2.sqlite` à partir du `sqlite_home` effectif de Codex ;
2. vérifier l’identité du fichier et le schéma connu des journaux Codex ;
3. vérifier que l’énumération des processus a réussi et qu’aucun processus d’écriture Codex pris en charge n’est actif ;
4. acquérir le verrou Log Guard dédié, partagé entre processus ;
5. répéter la vérification des processus Codex pendant que ce verrou est détenu ;
6. ouvrir la base existante en lecture et écriture sans autoriser sa création et vérifier qu’un accès immédiat en écriture SQLite peut être obtenu ;
7. exiger que `PRAGMA auto_vacuum` soit déjà réglé sur `INCREMENTAL` ;
8. exécuter `PRAGMA quick_check` avant la maintenance ;
9. effectuer un checkpoint WAL complet et refuser un checkpoint occupé ou incomplet ;
10. exécuter des lots bornés de `PRAGMA incremental_vacuum(N)`, avec un checkpoint après chaque lot ;
11. exécuter de nouveau `PRAGMA quick_check` après la maintenance ; et
12. communiquer les mesures avant/après de la base, du WAL, du nombre de pages, de la liste des pages libres et des octets récupérables.

La cible par défaut d’un lot est d’environ **8 Mio de pages SQLite**. Une exécution récupère au plus environ **256 Mio de pages**, avec une limite supplémentaire sur le nombre d’itérations. S’il reste des pages libres, le résultat est signalé comme partiel et vous pouvez relancer Compact plus tard.

Les limites en octets sont converties en nombres de pages selon la taille réelle des pages SQLite de la base. Elles bornent les pages SQLite logiques traitées ; elles ne mesurent pas le volume d’écritures sur SSD/NAND.

## Garanties de sécurité

Reclaim ne fait délibérément **pas** les actions suivantes :

- exécuter un `VACUUM` complet ;
- modifier le mode `auto_vacuum` d’une base Codex existante ;
- supprimer, tronquer, renommer ou manipuler directement les fichiers Codex `-wal` / `-shm` ;
- supprimer des lignes de diagnostic ;
- modifier les déclencheurs de protection Log Guard ou d’autres déclencheurs utilisateur ;
- s’exécuter lorsque Codex est détecté comme actif ;
- continuer si l’énumération des processus est incertaine ;
- continuer avec un futur schéma de journaux inconnu ; ou
- continuer après l’échec d’un contrôle d’intégrité SQLite.

Un verrou Log Guard occupé, un accès SQLite en écriture occupé ou un checkpoint initial occupé entraîne un refus explicite, sans nouvelle tentative en arrière-plan. Si la contention du checkpoint apparaît seulement après la validation d’un lot de compactage incrémental, OpenCodex signale le travail déjà effectué comme un résultat partiel réussi avec `stopReason: "busy"`, au lieu de prétendre qu’aucun changement n’a eu lieu.

## CLI

Examinez d’abord l’espace récupérable :

```bash
ocx storage codex-logs status
```

Exécutez une passe de maintenance bornée :

```bash
ocx storage codex-logs compact
```

Pour obtenir des mesures avant/après lisibles par machine :

```bash
ocx storage codex-logs compact --json
```

Si le résultat indique qu’il reste de l’espace récupérable, arrêtez-vous là, sauf si vous souhaitez explicitement une autre passe bornée. OpenCodex ne boucle pas indéfiniment et ne planifie pas de passe supplémentaire à votre place.

## API de gestion

Le compactage n’est exposé que par un point de terminaison de modification :

```text
POST /api/storage/codex-logs/compact
```

Il n’existe aucun alias GET pour le compactage. Une réponse réussie contient un objet `report` avec les mesures avant/après, le nombre de pages récupérées, la variation de la taille physique du fichier principal de la base, le nombre d’itérations, l’état d’achèvement, le motif d’arrêt et l’état d’intégrité.

Les états de refus habituels comprennent :

- `codex_running` : Codex est en cours d’exécution ;
- `process_enumeration_failed` : l’énumération des processus a échoué ;
- `busy` : une ressource est occupée ;
- `unsupported_schema` : le schéma n’est pas pris en charge ;
- `auto_vacuum_not_incremental` : le mode de compactage requis est absent ;
- `unsafe_path` : le chemin n’est pas sûr ;
- `integrity_check_failed` : le contrôle d’intégrité a échoué ;
- `database_error` : une erreur de base de données s’est produite.

Les échecs d’intégrité précisent s’ils se sont produits avant ou après la passe de maintenance. Un refus `busy` signifie qu’une contention a été détectée avant la validation du moindre lot ; `stopReason: "busy"` dans un rapport réussi signifie qu’au moins un lot a été validé avant qu’une contention ultérieure du checkpoint n’arrête la passe.

## Interpréter le résultat

`pagesReclaimed` et `logicalBytesReclaimed` décrivent les pages de la liste libre SQLite retirées pendant la passe. `physicalDatabaseBytesReclaimed` indique la réduction observée de la taille du fichier principal après les checkpoints de maintenance.

Ces nombres peuvent différer. Le comportement de SQLite, du WAL et du système de fichiers signifie que récupérer des pages logiques ne garantit pas une réduction physique immédiate identique. Aucune de ces mesures ne doit être interprétée comme un nombre d’écritures NAND, une usure du SSD ou un volume TBW consommé ou économisé.

`complete: true` signifie que la liste libre observée est vide. Un résultat partiel utilise `stopReason: "page_budget"` lorsque le budget de pages par exécution ou la limite finie d’itérations met fin à la passe, `stopReason: "no_progress"` lorsque SQLite cesse de réduire la liste libre, et `stopReason: "busy"` lorsqu’une contention du checkpoint apparaît après une récupération validée. Ces trois issues sont bornées et ne déclenchent aucune nouvelle tentative automatique.
