---
title: Déploiement Remote Hub
description: Déployer un hub opencodex avec une gestion locale, Tailscale Serve et OAuth sans interface locale.
---

Un hub conserve les identifiants fournisseur, le catalogue et l’usage sur un hôte. Les clients authentifiés appellent directement son plan de données. Le plan de gestion est distinct : son écoute facultative reste sur `127.0.0.1` et ne sert que le tableau de bord et `/api/*`. Elle ne sert jamais `/v1/*`, `/healthz`, `/readyz` ni WebSocket. Ne publiez pas le port `10101` et n’utilisez pas Tailscale Funnel.

## Rôles, connexion et sécurité

`standalone` réunit données et gestion. `hub` possède les secrets fournisseur et l’usage. `client` ne conserve que l’état de connexion et une clé de données dédiée.

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

La clé client est écrite dans le fichier privé `service-api-token`, jamais dans `config.json`. En mode connecté, l’usage provient du hub et est filtré par `apiKeyId`; après déconnexion, il provient du stockage local. Il n’existe aucune réplication entre les deux.

Le jeton admin permet la gestion ordinaire mais ne peut jamais créer une session de consentement. Les actions de consentement exigent une `gui-session`, une Origin correspondante et un jeton CSRF. `Tailscale-User-Login` n’est fiable que sur l’entrée de gestion dédiée; renseignez les identités exactes dans `remoteGui.allowedTailscaleUsers`.

## Service et Tailscale Serve

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set corsAllowOrigins '["http://localhost:10100"]'

# Une configuration standalone neuve n'a ni objet `hub` ni objet `remoteGui`, et
# `ocx config set` ne crée pas un parent manquant : un chemin imbriqué échoue avec
# `config parent path not found: hub`. Définir `runtimeRole` ne le crée pas non plus.
# Créez d'abord chaque objet, puis définissez ses champs.
ocx config set hub '{}'
ocx config set remoteGui '{}'
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
```

Sur une configuration réellement vide, vous pouvez écrire chaque objet en un seul appel :

```bash
ocx config set hub '{"managementPublicOrigin":"https://hub-name.tailnet-name.ts.net","managementIngress":{"enabled":true,"port":10101}}'
ocx config set remoteGui '{"allowedTailscaleUsers":["operator@example.com"]}'
```

N'utilisez cette forme que si l'objet n'existe pas encore. Affecter l'objet entier le **remplace** au lieu de fusionner : exécutée sur une configuration qui contenait déjà `hub.managementIngress`, la ligne ci-dessus supprime silencieusement cette entrée. Pour adapter une configuration existante, le parent est déjà là : définissez un champ à la fois, la forme imbriquée fonctionne et ne touche à rien d'autre.

Deux détails décident qu'une ligne passe. La valeur est d'abord interprétée comme du JSON et retombe sur la chaîne brute, d'où l'écriture d'une URL en `'"https://…"'` : objets, tableaux, booléens et nombres doivent être du JSON valide. Ensuite, `hub` et `remoteGui` sont stricts : une clé mal orthographiée comme une valeur non conforme sont rejetées à l'écriture par une erreur `schema_invalid`, au lieu de devenir un réglage sans effet. `managementPublicOrigin` doit être une origine nue, sans chemin, requête ni fragment.

Le service lit le secret depuis `service-api-token`; le plist ou l’unité systemd ne contient pas sa valeur.

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` ne prouve que la vie du processus. Validez aussi `/readyz`, `GET /v1/catalog` authentifié et une vraie réponse routée. Le port de gestion doit écouter uniquement sur `127.0.0.1`. Pour un proxy TLS privé, utilisez `tailscale cert hub-name.tailnet-name.ts.net` et ne fabriquez jamais d’en-têtes `Tailscale-User-*`; utilisez l’association à usage unique.

### Donner du TLS à l'écoute de données

Le mappage Serve ci-dessus ne publie que l'entrée de **gestion**. Celle-ci ne sert jamais `/v1/*`, `/healthz` ni `/readyz` : à elle seule, elle ne donne donc à un client distant aucun plan de données utilisable. opencodex ne termine par ailleurs aucun TLS : l'écoute est en HTTP clair et le HTTPS vient toujours d'un frontal détenu par l'opérateur.

Serve peut aussi être ce frontal pour le plan de données, sur un second port HTTPS. Sur macOS, il faut un saut supplémentaire : Tailscale Serve ne relaie que vers `127.0.0.1` et ne peut donc pas viser l'écoute liée à l'adresse tailnet du nœud, tandis que la version App Store du client macOS refuse purement et simplement une destination distante. Lancez un relais local sur le hub et pointez Serve dessus :

```bash
# N'importe quel relais TCP local convient; socat en est un. Choisissez un port que le hub
# n'utilise pas déjà : avec le companion de loopback activé, 127.0.0.1:10100 appartient à opencodex.
socat TCP-LISTEN:10110,bind=127.0.0.1,fork,reuseaddr TCP:100.64.0.10:10100 &

tailscale serve --bg --https=8443 http://127.0.0.1:10110
tailscale serve status   # les deux mappages attendus : 443 -> 10101 et 8443 -> 10110
```

Serve n'accepte qu'un jeu limité de ports HTTPS; confirmez avec `tailscale serve status` que le mappage a bien été créé plutôt que de supposer le port autorisé. Donnez au relais la même durée de vie qu'au hub : une tâche shell en arrière-plan meurt au redémarrage alors que le service revient, ce qui laisse un hub actif et injoignable en TLS. Lancez-le depuis launchd ou systemd, aux côtés de `ocx service install`.

Connectez-vous ensuite en énonçant les deux origines séparément. L'URL positionnelle est l'origine **de données** — c'est là que sont récupérés `/readyz` et `/v1/catalog` — et `--management-url` est l'origine du tableau de bord, utilisée pour l'association et l'émission de clé. Elles ne partagent pas nécessairement le même port :

```bash
ocx connect https://hub-name.tailnet-name.ts.net:8443 \
  --management-url https://hub-name.tailnet-name.ts.net \
  --admin-token-stdin
```

Quand `--management-url` est omis, il est repris de la réponse `/readyz`, qui rapporte `hub.managementPublicOrigin`. L'indiquer explicitement est plus clair lorsque les deux origines diffèrent.

**Ne contournez pas cela en liant l'écoute de données à `127.0.0.1`.** Une liaison loopback est précisément ce à quoi opencodex reconnaît un déploiement purement local : il cesse d'exiger un identifiant de données et se met à exiger que l'en-tête `Host` de la requête soit lui aussi loopback. Un frontal TLS transmet `Host: hub-name.tailnet-name.ts.net`, donc `/v1/catalog` répond `403 origin_rejected` tandis que `/readyz`, qui n'applique pas ce contrôle, renvoie toujours `200`. Le déploiement paraît sain et ne peut servir aucun modèle. Rien dans le chemin de requête ne lit `X-Forwarded-Host`, le frontal ne peut donc pas corriger cela. Gardez l'écoute sur l'adresse tailnet : l'admission par identifiant y reste active et le contrôle `Host` ne s'applique pas.

Lier `0.0.0.0` fonctionne aussi et supprime le besoin de relais, puisque l'écoute devient alors joignable en loopback. Cela publie le port de données sur toutes les interfaces : réservez-le aux hôtes dont les autres réseaux vous importent peu.

Une fois Serve en place, rejouez les contrôles d'acceptation sur l'origine de données HTTPS : `/readyz`, `GET /v1/catalog` authentifié et une vraie réponse routée.

## OAuth, rotation et déconnexion

```bash
ocx config set oauthOpenBrowser false
ocx connect rotate --pairing-code-stdin
# uniquement en HTTPS :
ocx connect rotate --admin-token-stdin
```

Démarrez OAuth avec `POST /api/oauth/login`; si le rappel ne rejoint pas le hub, envoyez l’URL finale ou le code à `POST /api/oauth/login/code` sous `{provider,input}`. Ne placez jamais le code OAuth dans argv ou les journaux.

La rotation garde les deux clés valides sous le même `apiKeyId` pendant dix minutes au plus. L’ancienne clé est sauvegardée dans `service-api-token.prev`, la nouvelle est installée atomiquement et vérifiée avec `/v1/catalog`, puis validée. Si le résultat est incertain, relancez `ocx connect rotate` avec une autorité transitoire; ne supprimez aucun candidat.

`ocx disconnect` restaure l’état local même hors ligne et ne révoque pas la clé du hub. Après déconnexion, la seule voie de révocation est **Integrations → API Keys** sur le hub. `ocx connect revoke --admin-token-stdin` fonctionne uniquement tant que le client est connecté.

## Docker, retour arrière et dépannage

Lors d'un retour arrière, conservez les deux volumes et leurs points de montage. Les droits des volumes existants ne sont pas corrigés automatiquement. Consultez le [guide canonique](/guides/remote-hub/#docker-compose) pour les montages nommés hors Compose et les chemins d'état personnalisés.

Deux volumes distincts conservent l'état : `ocx-state` pour
`OPENCODEX_HOME=/home/bun/.opencodex` et `codex-state` pour
`CODEX_HOME=/home/bun/.codex`. Leurs fichiers `auth.json` ont des formats incompatibles :
ne fusionnez pas ces répertoires. Ils restent accessibles en écriture malgré la racine en lecture seule.

Le catalogue n'est pas généré automatiquement. Avant de tester `/v1/catalog` avec authentification,
créez ou importez un fichier valide dans `/home/bun/.codex/opencodex-catalog.json`.
Un répertoire vide renvoie normalement 404 `catalog_not_found`. Une mise à jour conserve
`ocx-state` et ajoute `codex-state`, sans déplacer les fichiers. Sauvegardez tout catalogue
précédemment placé dans `.opencodex`, puis transférez seulement ce catalogue avec des permissions
réservées au propriétaire ; ne remplacez pas un `auth.json` par celui de l'autre produit.
Si vous redéfinissez `CODEX_HOME`, montez ce répertoire exact en écriture et placez le catalogue
par défaut dans `${CODEX_HOME}/opencodex-catalog.json`. Si `model_catalog_json` désigne un autre
fichier, son chemin résolu doit aussi être persistant. Conservez les variables et montages
personnalisés jusqu'à la fin d'une migration explicite.
`docker compose down` conserve les deux volumes ; `docker compose down --volumes` supprime
`ocx-state` et `codex-state`, avec les identifiants, l'historique d'utilisation, la clé de données,
l'état et le catalogue Codex. Ce n'est pas une commande de mise à jour ou de redémarrage.

Il n’existe pas d’image Docker officielle, mais le dépôt fournit un `Dockerfile` et un `compose.yaml` maintenus pour construire localement une image Bun épinglée par digest. Initialisez une seule fois la clé de données via stdin ; elle est enregistrée avec des permissions réservées au propriétaire dans le volume `ocx-state` et n’est jamais affichée.

Installez Git et Bun sur l’hôte. Avant chaque construction, générez le manifeste canonique depuis les sources suivies par Git, sans modifier les sources entre la génération et la construction. Le JSON généré reste non suivi ; `.git` est exclu du contexte Docker. Le port hôte est lié à `127.0.0.1` par défaut. Pour un accès distant, utilisez explicitement `OPENCODEX_BIND_ADDRESS=<IP-LAN-ou-Tailscale> docker compose up -d` ; `0.0.0.0` expose toutes les interfaces. Protégez cet accès par un pare-feu et un frontal TLS/tailnet authentifié.

La construction rejette les manifestes périmés en comparant chaque SHA-256 aux fichiers du contexte puis de l’image. Les fichiers manquants ou divergents, les sources supplémentaires et les liens symboliques sont refusés. `package.json`, `bun.lock` et le seul fichier autorisé de `scripts/`, `scripts/model-metadata.source.json`, sont obligatoires.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

Le conteneur s’exécute avec l’utilisateur non-root `bun`, un système de fichiers racine en lecture seule et uniquement le port `10100` publié. Ne publiez jamais `10101` et ne placez aucun secret dans `ARG`, `ENV`, `COPY`, Compose, l’historique d’image ou argv. Après le healthcheck, vérifiez séparément `/readyz`, le catalogue authentifié et une réponse réelle. `docker compose down` conserve le volume ; `docker compose down --volumes` supprime aussi la configuration, les identifiants et la clé.

- Hub indisponible : `ocx disconnect` restaure localement, mais la révocation reste à faire.
- Catalogue périmé : seul un dernier catalogue validé est conservé après une panne transitoire; aucune substitution locale après erreur d’authentification, schéma, taille ou protocole.
- Récupération `.prev` : conservez les deux fichiers et relancez la rotation avec une autorité transitoire.
- `hub-too-new`/`hub-too-old` : mettez à niveau le côté indiqué avant toute écriture locale.
- Code d’association perdu ou épuisé : créez-en un nouveau; les essais sont limités avec 429.
- HTTP non local : l'association est refusée d'emblée et aucun indicateur ne permet d'y déroger. Placez l'origine de gestion derrière HTTPS, ou associez en loopback. Un jeton admin n’est jamais envoyé en HTTP.
- `403 origin_rejected` sur `/v1/catalog` alors que `/readyz` renvoie `200` : l'écoute de données est liée au loopback derrière un frontal TLS. Voir « Donner du TLS à l'écoute de données » ci-dessus.
- Déconnexion/expiration de session navigateur n’affecte pas la clé de données.
- Avant `tailscale serve reset`, inspectez `tailscale serve status`, car reset supprime tous les mappages.
