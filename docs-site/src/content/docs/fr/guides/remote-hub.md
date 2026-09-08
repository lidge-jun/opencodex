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
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set corsAllowOrigins '["http://localhost:10100"]'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
```

Le service lit le secret depuis `service-api-token`; le plist ou l’unité systemd ne contient pas sa valeur.

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` ne prouve que la vie du processus. Validez aussi `/readyz`, `GET /v1/catalog` authentifié et une vraie réponse routée. Le port de gestion doit écouter uniquement sur `127.0.0.1`. Pour un proxy TLS privé, utilisez `tailscale cert hub-name.tailnet-name.ts.net` et ne fabriquez jamais d’en-têtes `Tailscale-User-*`; utilisez l’association à usage unique.

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
- HTTP non local exige `--allow-insecure-http`; un jeton admin n’est jamais envoyé en HTTP.
- Déconnexion/expiration de session navigateur n’affecte pas la clé de données.
- Avant `tailscale serve reset`, inspectez `tailscale serve status`, car reset supprime tous les mappages.
