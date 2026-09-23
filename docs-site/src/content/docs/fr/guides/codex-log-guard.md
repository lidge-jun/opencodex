---
title: Codex Log Guard
description: Examinez et réduisez explicitement la persistance des journaux de diagnostic Codex sans exposer leur contenu.
---

OpenCodex peut examiner la base persistante des journaux de diagnostic Codex et, si vous l’activez, réduire les lignes de diagnostic que Codex conserve. L’inspection reste en lecture seule ; la protection est une modification explicite, refusée si le schéma connu des journaux Codex est absent ou si Codex est en cours d’exécution.

## Ce que rapporte Inspect

OpenCodex détermine le `sqlite_home` effectif de Codex selon l’ordre de priorité existant de Codex et examine la base canonique `logs_2.sqlite` qui s’y trouve. Un fichier `logs_N.sqlite` de numéro supérieur ou hérité ne remplace jamais la cible susceptible d’être modifiée.

La vue Stockage indique :

- la taille des fichiers de la base principale, du WAL et du SHM ;
- le nombre total de lignes de journaux et la part enregistrée au niveau `TRACE` ;
- les principales catégories de cibles de journaux par nombre de lignes, désignées par leur rang plutôt que par leur nom ;
- l’espace libre SQLite qui pourrait être récupéré plus tard ; et
- la compatibilité du schéma observé avec le schéma actuellement connu des journaux Codex.

Si `sqlite_home` se trouve hors de `CODEX_HOME`, la base de diagnostic est affichée séparément. Ses octets ne sont pas ajoutés silencieusement au total de stockage `CODEX_HOME` existant.

OpenCodex ne sélectionne ni n’expose `feedback_log_body` pour produire ces diagnostics. Les niveaux de journal sont réduits à l’ensemble fixe des niveaux connus, plus `OTHER`, et les noms des cibles ne sont pas sérialisés.

## Modes de Protect

La protection est **désactivée par défaut**. Son activation installe un déclencheur `BEFORE INSERT` appartenant à OpenCodex dans la base canonique `logs_2.sqlite` de Codex. OpenCodex ne remplace jamais un déclencheur inconnu portant l’un de ses noms réservés et ne supprime que les déclencheurs dont le SQL correspond à sa propre version.

Deux modes sont disponibles :

- **Compatibilité** (`compat`) est le mode recommandé. Il applique l’ensemble actuel de règles Log Guard v1 aux cibles à fort volume que Codex filtre déjà ou dont il abaisse le niveau dans son stockage persistant SQLite. Les autres lignes `TRACE` sont conservées.
- **Silencieux** (`quiet`) supprime toutes les nouvelles lignes `TRACE` tout en conservant les lignes `DEBUG`, `INFO`, `WARN` et `ERROR`.

La protection réduit les lignes qui atteignent le stockage persistant SQLite. Elle ne supprime **pas** le travail de traçage effectué plus tôt par Codex : les événements peuvent encore être mis en forme, placés en file, regroupés en transactions et examinés par la logique d’élagage propre à Codex avant que le déclencheur n’ignore une ligne. Considérez Protect comme une protection contre les écritures persistantes répétées, et non comme un interrupteur qui désactive la production des diagnostics dans Codex.

Log Guard filtre uniquement les lignes de journaux SQLite locaux persistants. Il ne modifie ni le traitement des diagnostics Codex, ni le [transport des adaptateurs](/fr/reference/adapters/), ni les charges utiles des fournisseurs, la sémantique du streaming, l’authentification, le routage, les quotas ou l’état des comptes.

### Contrôles de sécurité

Avant que Protect, Disable ou Repair ne modifie cette base externe, OpenCodex :

1. résout exactement le chemin canonique de `logs_2.sqlite` ;
2. vérifie qu’il s’agit d’un fichier ordinaire, sans lien symbolique, et que le schéma connu correspond exactement ;
3. vérifie que l’énumération des processus a réussi et qu’aucun processus d’écriture Codex pris en charge n’est actif ;
4. acquiert un verrou Log Guard dédié, partagé entre processus ;
5. répète la vérification des processus Codex après l’acquisition du verrou ;
6. ouvre la base en lecture et écriture **sans** autoriser sa création et acquiert `BEGIN IMMEDIATE` dans SQLite sans attente en cas d’occupation ;
7. ne modifie que les déclencheurs Log Guard appartenant à OpenCodex et relit le résultat avant validation ; et
8. enregistre le mode demandé dans la configuration OpenCodex pendant que le verrou Log Guard est encore détenu.

Si l’énumération des processus est incertaine, si la base est occupée, si le schéma est inconnu ou si un nom de déclencheur réservé appartient à un autre SQL, la modification est refusée par précaution. OpenCodex n’arrête pas Codex automatiquement.

## Dérive et réparation

Le mode de protection demandé est enregistré dans la configuration OpenCodex, séparément de la base des journaux Codex. C’est important, car une migration Codex peut reconstruire la table `logs`, et SQLite supprime les déclencheurs attachés à une table remplacée.

Lorsque le mode enregistré est `compat` ou `quiet`, mais que le déclencheur correspondant n’est plus observé, Log Guard signale une **dérive**. `ocx doctor` la signale sans jamais la réparer automatiquement.

La réparation est explicite :

```bash
ocx storage codex-logs repair
```

OpenCodex ne recrée délibérément pas la protection à chaque démarrage. Une version ultérieure pourra réexaminer la réparation automatique lorsque suffisamment d’observations sur le terrain auront établi sa sûreté lors des migrations Codex.

## CLI

Consultez l’état :

```bash
ocx storage codex-logs status
ocx storage codex-logs status --json
ocx doctor
```

Activez la politique de compatibilité recommandée :

```bash
ocx storage codex-logs protect
```

Choisissez explicitement le mode silencieux :

```bash
ocx storage codex-logs protect --mode quiet
```

Désactivez la protection OpenCodex ou réparez une dérive :

```bash
ocx storage codex-logs unprotect
ocx storage codex-logs repair
```

Ajoutez `--json` aux commandes Log Guard pour obtenir une sortie lisible par machine. Consultez la [référence CLI](/fr/reference/cli/) pour la syntaxe canonique et le comportement JSON.

La commande existante reste inchangée :

```bash
ocx storage --json
```

Sa réponse contient le même état des journaux Codex que celui utilisé par la page Stockage.

## API de gestion

L’état est disponible à l’adresse :

```text
GET /api/storage/codex-logs
```

Les modifications explicites utilisent :

```text
POST /api/storage/codex-logs/protect
POST /api/storage/codex-logs/unprotect
POST /api/storage/codex-logs/repair
```

Le corps de Protect est soit `{"mode":"compat"}`, soit `{"mode":"quiet"}`. `GET /api/storage` inclut également le rapport sous `codexLogs`, afin que le tableau de bord puisse actualiser la répartition normale du stockage et les diagnostics des journaux Codex à partir d’un seul instantané.

## Sémantique des instantanés en lecture seule

L’inspection de l’état ouvre la base en lecture seule avec SQLite `immutable=1`. Une lecture de diagnostic ne peut ainsi ni créer ni mettre à jour les fichiers annexes `-wal` ou `-shm`.

Ce choix a une conséquence importante : les agrégats SQL et les métadonnées de déclencheurs observées décrivent le dernier instantané de la base ayant fait l’objet d’un checkpoint. Si Codex écrit activement, le WAL courant peut contenir des lignes ou des pages de schéma plus récentes que l’instantané immuable. Une réponse de modification réussie s’appuie sur l’état du déclencheur vérifié par OpenCodex dans sa transaction d’écriture ; une requête ultérieure d’état en lecture seule peut rester temporairement en retard jusqu’à ce que SQLite effectue un checkpoint de ces pages de schéma.

OpenCodex indique séparément la taille du fichier WAL et ne présente **pas** le résultat comme un débit d’écriture SSD, des écritures NAND ou une consommation d’usure/TBW du disque.

## États de compatibilité

Avec un schéma connu, l’inspection et la protection sont signalées comme prises en charge. Un schéma absent, illisible ou inconnu d’une version future reste inspectable sous forme de métadonnées, mais les opérations susceptibles de modifier la base sont indiquées comme non prises en charge.

Un schéma inconnu n’est pas supposé compatible. Une version plus récente de Codex reste ainsi observable sans que Log Guard traite une structure de base non examinée comme sûre à modifier.

## Reclaim reste distinct

Protect n’exécute ni `VACUUM` ni compactage SQLite. [**Reclaim**](/fr/guides/codex-log-guard-reclaim/) fournit un flux explicite, hors ligne et borné de compactage incrémental, avec checkpoints et contrôles d’intégrité.

Protect n’exécute jamais `VACUUM`, ne tronque ni ne supprime directement le WAL de Codex et ne planifie jamais de récupération d’espace.
