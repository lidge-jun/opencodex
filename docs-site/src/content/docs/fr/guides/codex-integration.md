---
title: Intégration à Codex
description: Comment opencodex s'intègre à Codex, synchronise le catalogue de modèles, installe des intercepteurs et restaure proprement la configuration d'origine.
---

opencodex fait passer Codex par le proxy en modifiant deux éléments lus par Codex : sa configuration
(`$CODEX_HOME/config.toml`, par défaut `~/.codex/config.toml`) et son catalogue de modèles. Chaque modification
est idempotente et réversible.

Le proxy expose une route non qualifiée `openai` pour la connexion Codex, avec les modes de compte Pool (par
défaut) et Direct, ainsi que `openai-apikey/<model>` pour la clé API configurée. Pool comprend le compte
principal et les comptes ajoutés ; Direct utilise uniquement le jeton Bearer du compte appelant ou principal.
Ces routes ne se rabattent jamais l'une sur l'autre. Les configurations v1 distribuées migrent vers le marqueur
2 et conservent `config.json.pre-openai-tiers-v2.bak` pour une restauration manuelle.

## Injection de configuration

`ocx init`, `ocx start` et `ocx sync` appellent l'injecteur. Sur la liaison de bouclage par défaut, il conserve
l'identifiant du fournisseur `openai` intégré à Codex et fait pointer ce fournisseur vers opencodex :

```toml
# root keys, before the first table
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

# only when fastMode is set; unset adds no [features] table
[features]
fast_mode = true
```

Le `fast_mode` injecté suit le réglage à trois états `fastMode` : `true` écrit `fast_mode = true`, `false`
écrit `fast_mode = false`, et une valeur non définie laisse tout `fast_mode` existant intact sans ajouter de
table `[features]`.

Le proxy écoute sur le port `10100` par défaut et sert `POST /v1/responses`,
`POST /v1/responses/compact`, `POST /v1/images/generations`, `POST /v1/images/edits`,
`GET /v1/models`, `GET /healthz` et la surface de gestion `/api/*`.

### Génération d'images intégrée (`image_gen`)

L'outil `image_gen` intégré à Codex ne passe pas par `/v1/responses` : l'extension codex-rs envoie directement
une requête POST à `{base_url}/images/generations` (ou à `/images/edits` lorsque des images de référence sont
jointes), avec la même authentification Bearer ChatGPT que pour le chat. Comme le `base_url` injecté pointe vers
opencodex, le proxy relaie ces appels au service OpenAI en amont.

Ce mécanisme est distinct de l'[Image Bridge](/fr/guides/image-bridge/), qui ne s'active que lorsqu'un tour
**Responses** déclare l'outil hébergé `image_generation` alors qu'un modèle autre qu'OpenAI est sélectionné.
Les appels autonomes `/images/generations` n'entrent jamais dans ce pont.

- **Un seul candidat au transfert, selon le mode :** Pool sélectionne un compte principal ou ajouté éligible ;
  Direct utilise le jeton Bearer OAuth de l'appelant. Le mode configuré s'applique uniformément à la requête d'image.
- **Fournisseur OpenAI à clé API :** il n'est utilisé que lorsqu'aucun candidat au transfert n'est responsable
  d'un échec d'authentification. Un identifiant Pool défaillant ou expiré n'est jamais masqué par une utilisation
  de l'API facturée séparément.
- **Fournisseur personnalisé explicite :** définissez `images.provider` sur l'identifiant d'un fournisseur
  `openai-responses` personnalisé à clé API dont le point de terminaison implémente l'API OpenAI Images. Une
  sélection explicite échoue sans repli et ne se rabat jamais sur un autre service en amont payant. Les
  identifiants de fournisseur gérés par le registre ne sont pas acceptés ici ; omettez `images.provider` pour
  utiliser les niveaux OpenAI intégrés.
- **Repli Google Antigravity (CCA) :** lorsqu'aucun candidat au transfert OpenAI ni fournisseur à clé n'est
  configuré, `/v1/images/generations` — mais pas `/images/edits` — se rabat sur le point de terminaison
  Antigravity **Cloud Code Assist** avec le modèle `gemini-3.1-flash-image`. Ce repli se déclenche aussi après
  un échec de résolution de l'authentification OpenAI, par exemple en cas d'identifiant ChatGPT absent ou expiré,
  et pas seulement lorsqu'aucun candidat OpenAI n'est configuré. Il nécessite `ocx login google-antigravity` ;
  le jeton OAuth n'est envoyé qu'à l'hôte de registre CCA épinglé, jamais à une substitution `baseUrl` de la
  configuration. La réponse conserve la forme `{created, data:[{b64_json}]}` attendue par Codex.
- **Aucun des deux :** le proxy renvoie une erreur explicite plutôt qu'une erreur 404 générique. Les fournisseurs
  routés (Cursor, Gemini, Kiro, …) ne peuvent pas assurer le relais de l'outil `image_generation`. Si vous ne
  souhaitez pas proposer cet outil, désactivez-le dans Codex avec `codex features disable image_generation`
  (`[features] image_generation = false` dans `config.toml`).

La déclaration de l'outil accompagne toujours la requête Responses du modèle. Pour les fournisseurs Responses à
clé API, opencodex convertit l'espace de noms privé `image_gen` de Codex en un alias accepté en amont,
`image_gen__<inner-name>` (par exemple `image_gen__imagegen`). Lorsque cet alias exploitable remplace la
déclaration du client, opencodex retire toute déclaration hébergée `image_generation` en double. Il remappe
l'appel de fonction vers l'espace de noms explicite `image_gen` avant que Codex ne le reçoive, puis réencode
l'appel natif lorsque l'historique est rejoué ultérieurement en amont. La génération d'images côté client reste
ainsi appelable sur les services compatibles avec l'API publique qui réservent cet espace de noms ou refusent
les noms de fonction contenant un point. Le mode de transfert ChatGPT reste inchangé et conserve sa forme native
Responses Lite.

Pour une passerelle personnalisée compatible OpenAI, configurez un fournisseur dédié et sélectionnez-le uniquement
pour les requêtes Images autonomes :

```json
{
  "providers": {
    "custom-images": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "authMode": "key",
      "apiKey": "${IMAGE_GATEWAY_API_KEY}"
    }
  },
  "images": {
    "provider": "custom-images",
    "timeoutMs": 300000
  }
}
```

Le point de terminaison personnalisé doit accepter `POST /v1/images/generations` et `/v1/images/edits`, puis
renvoyer la structure de réponse OpenAI Images attendue par Codex. La clé configurée pour le fournisseur remplace
le jeton Bearer de l'appelant avant l'envoi de la requête en amont.

> **Remarque :** ce passage concerne uniquement l'outil Codex `image_generation` — le relais
> `/images/generations`. Les modèles Gemini capables de produire des images les génèrent directement dans la
> réponse au moyen de l'adaptateur `google` (avec `responseModalities: ["TEXT", "IMAGE"]`), indépendamment de
> ce relais. Consultez la page
> [Adaptateurs](/fr/reference/adapters/#google).

Lorsque `hostname` ne désigne pas l'interface de bouclage, Codex doit envoyer l'en-tête d'authentification API
généré. L'injecteur utilise donc un fournisseur dédié :

```toml
# root keys
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# appended at the end of the file
# Auto-injected by opencodex
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENCODEX_API_AUTH_TOKEN"
# supports_websockets = true   # only when config.websockets is true
```

Lorsque OpenCodex gère le routage, les deux modes écrivent `$CODEX_HOME/opencodex.config.toml` comme
configuration de référence et de repli. Sur l'interface de bouclage, ce fichier contient les clés racine que
vous pouvez fusionner manuellement si l'injection automatique a été supprimée ; hors bouclage, il contient la
forme avec fournisseur dédié. Le mode de fournisseur externe laisse ce profil intact.

:::caution
Les clés racine telles que `openai_base_url`, `model_provider` et `model_catalog_json` **doivent** précéder le
premier en-tête `[table]`. L'injecteur garantit ce placement, supprime ses propres copies obsolètes ou en double
et n'écrase jamais une clé racine `openai_base_url` appartenant à l'utilisateur. Si cette clé existe, la
synchronisation met le catalogue à jour, mais signale que le routage n'a pas été injecté.
:::

## Catalogue de modèles partagé

La CLI, la TUI, l'application et le SDK Codex utilisent tous le même répertoire personnel Codex. opencodex le
détermine à partir de `CODEX_HOME`, avec `~/.codex` comme valeur de repli, et gère les fichiers suivants :

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

Sous WSL, si `CODEX_HOME` n'est pas défini et que `~/.codex/config.toml` n'existe pas côté Linux, opencodex
recherche également un unique répertoire personnel de Codex Desktop pour Windows à l'emplacement
`/mnt/c/Users/*/.codex/config.toml`. S'il trouve exactement un candidat, il utilise ce répertoire afin que le
mode app-server sous WSL et Codex Desktop sous Windows partagent les mêmes fichiers de configuration et
d'authentification. Définissez explicitement `CODEX_HOME` pour désactiver cette détection.

Codex peut conserver l'état de ses fils dans un répertoire SQLite distinct. Pour les opérations d'historique,
OpenCodex applique le même ordre de priorité que Codex : la clé racine `sqlite_home` de `config.toml`, puis
`CODEX_SQLITE_HOME`, puis le répertoire `CODEX_HOME` effectif. Les chemins SQLite relatifs sont résolus depuis
le répertoire de travail courant. Lorsqu'une valeur explicite de `CODEX_SQLITE_HOME` est présente pendant
l'installation ou la réparation du service, le lanceur persistant enregistre son chemin absolu au moment de
l'installation, afin que le proxy d'arrière-plan continue d'utiliser la même base de données. Si `config.toml`
ou sa clé racine `sqlite_home` est absent, OpenCodex poursuit avec les valeurs de repli de l'environnement et du
répertoire personnel. Si le fichier est illisible ou impossible à analyser, ou si la clé existe mais est vide ou
n'est pas une chaîne, la résolution du répertoire SQLite s'arrête afin de ne pas risquer d'effectuer des
opérations d'historique sur une autre base de données.

Sous Windows, un shell Orca peut définir à la fois `CODEX_HOME` et `ORCA_CODEX_HOME` sur le répertoire personnel
de l'environnement d'exécution intégré à Orca, alors que l'application ChatGPT/Codex continue de lire
`%USERPROFILE%\\.codex`. `ocx status` et `ocx doctor` signalent précisément cette divergence et affichent des
chemins cibles expurgés. Si le service d'arrière-plan a été installé depuis ce shell Orca, désinstallez-le
d'abord depuis le shell d'origine. Définissez ensuite `CODEX_HOME` sur le répertoire de l'application, supprimez
`ORCA_CODEX_HOME`, relancez la synchronisation ou la restauration, puis réinstallez le service.

En mode fournisseur dédié, `requires_openai_auth = true` maintient les surfaces de l'application et de la TUI
Codex soumises à un compte, comme dans Codex natif. opencodex sert également `/v1/responses` par WebSocket. Le
fournisseur dédié n'annonce `supports_websockets = true` que lorsque `"websockets": true`. Sur l'interface de
bouclage, le fournisseur intégré de Codex peut tenter WebSocket en premier ; si cette fonction est désactivée,
le proxy renvoie `426` et Codex se rabat sur HTTP/SSE.

## Identité et historique du fil de discussion

La configuration de bouclage par défaut conserve l'étiquette du fournisseur natif `openai` de Codex sur les
nouveaux fils ; la reprise normale de l'historique ne nécessite donc aucun remappage. La synchronisation et la
restauration n'appliquent qu'un manifeste de sauvegarde correspondant et rétablissent exactement le fournisseur,
la source et l'indicateur d'événement d'origine. Une ligne `opencodex` sans manifeste reste inchangée ; utilisez
`ocx recover-history --legacy-openai --yes` uniquement pour forcer explicitement ce réétiquetage hérité. Cette commande
est volontairement large : elle réétiquette en `openai` chaque fil contenant un message utilisateur et actuellement
marqué `opencodex`, normalise `exec` en `cli` et active l'indicateur d'événement — y compris l'historique légitime
d'un fournisseur dédié. Sauvegardez l'état et ne l'utilisez que si vous souhaitez cette portée complète. Hors bouclage,
le mode fournisseur dédié continue de refléter l'historique sous le fournisseur `opencodex` tant qu'il est actif,
puis restaure les métadonnées sauvegardées lorsqu'il prend fin. Définissez `syncResumeHistory: false` pour ne pas
modifier l'historique.

## Synchronisation du catalogue de modèles

Codex affiche les modèles provenant d'un catalogue sur disque — par défaut
`$CODEX_HOME/opencodex-catalog.json`. Au démarrage et lors de `ocx sync`, opencodex :

1. **Sauvegarde** une fois le catalogue d'origine dans `~/.opencodex/catalog-backup.json`, afin que la mise en
   avant des modèles soit réversible.
2. **Récupère** les catalogues en direct des fournisseurs admissibles — mise en cache pendant ~5 min, puis repli sur
   la dernière liste valide et enfin sur la valeur configurée de `models[]`. L'authentification par transfert ne
   possède aucun point de terminaison de modèles, et Cursor utilise son appel RPC `GetUsableModels` plutôt que
   `/models`.
3. **Fusionne** les modèles routés sous forme d'entrées qualifiées (`provider/model`), clonées depuis un modèle
   de catalogue Codex natif afin que l'analyseur strict de Codex les accepte.
4. **Filtre** `config.disabledModels` et la liste d'autorisation `selectedModels` non vide de chaque fournisseur.
5. **Reclasse** les modèles afin que ceux mis en avant apparaissent en premier — voir ci-dessous — puis réécrit
   le catalogue fusionné.

L'identité GPT-5 des entrées routées du catalogue est également remplacée par le véritable nom du modèle en
amont. Les contrôles de raisonnement proviennent des métadonnées du fournisseur et du modèle selon l'échelle
`low | medium | high | xhigh |
max | ultra` de Codex ; les valeurs non prises en charge sont converties ou
plafonnées avant l'envoi de la requête en amont.

### Outils locaux routés

Les lignes non natives du catalogue routé utilisent `tool_mode: "code_mode_only"`. Codex peut ainsi exposer son
point d'entrée officiel `exec` et les outils MCP imbriqués, notamment Browser et Computer Use, tandis
qu'opencodex ne route que l'appel de fonction ordinaire du modèle. L'exécution des outils, les autorisations et
les confirmations restent locales à Codex ; opencodex n'implémente pas un second navigateur ni un second
exécuteur de contrôle du bureau.

Pour les fournisseurs Responses à clé qui n'acceptent pas la grammaire de l'outil personnalisé `exec` de Codex,
opencodex encode cette déclaration et son historique sous forme d'outil de fonction en amont, puis restaure le
cycle de vie diffusé de l'appel de fonction en `custom_tool_call` avant que Codex ne le reçoive. Le routage natif
par transfert OpenAI et l'outil personnalisé `apply_patch`, qui est pris en charge, restent inchangés.

Le fournisseur sélectionné doit prendre en charge les appels de fonctions ou d'outils. Un fournisseur purement
textuel dépourvu de cette prise en charge ne peut pas utiliser `exec`, Browser ni Computer Use. Les lignes
OpenAI natives conservent leur mode d'outil en amont.

Après toute modification de ces métadonnées par `ocx sync`, redémarrez l'application Codex et ouvrez une nouvelle
tâche. Les processus app-server et les tâches existants peuvent conserver le catalogue et le plan d'outils
chargés au démarrage.

### Noms d'affichage des modèles personnalisés

Un modèle personnalisé peut posséder un **nom d'affichage** lisible qui remplace le libellé présenté par Codex
dans son sélecteur de modèles, sans modifier le routage. Ce nom ne renseigne que le champ `display_name` de
l'entrée du catalogue : l'identifiant de routage (`<provider>/<model>`), l'ordre de résolution des collisions
d'alias, le fournisseur et les noms commerciaux natifs d'OpenAI restent inchangés.

Ajoutez un nom d'affichage depuis la CLI ; si le proxy est actif, il synchronise immédiatement le catalogue :

```bash
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

Les clients Codex distants peuvent récupérer le même catalogue généré avec une clé ordinaire du plan de données — le même identifiant que celui utilisé pour `/v1/responses`, et non un jeton de gestion ou d'administration :

```bash
dest="${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-opencodex-api-key: $OPENCODEX_API_AUTH_TOKEN" \
  "https://proxy.example.com/v1/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
ocx sync-cache
```

La réponse contient le document `opencodex-catalog.json` brut, sans identifiants de fournisseur. Lorsqu'il est
disponible, l'en-tête `x-opencodex-codex-version` indique la version de l'environnement d'exécution Codex du
serveur, afin que les clients puissent détecter un écart de version.

Vous pouvez également définir ou modifier ce nom dans l'API de gestion — `POST /api/custom-models` ou
`PUT /api/custom-models/<id>` avec une chaîne `displayName` — et dans le tableau de bord web. Le caractère `/`
est refusé, car il entrerait en collision avec le séparateur des identifiants de routage.

`GET /v1/catalog` existe pour que la lecture d'une liste de modèles ne coûte pas un jeton d'administration. La route est en lecture seule (`GET` et `HEAD`), accepte `x-opencodex-api-key`, un jeton bearer ou `x-api-key`, et renvoie exactement les mêmes octets que la route de gestion. Les réponses portent un `ETag` fort — renvoyez-le dans `If-None-Match` pour revalider et obtenir un `304` — et `Cache-Control: private, no-cache`. Une clé du plan de données admise ici n'obtient **rien** sur le plan de gestion : `/api/catalog` et toutes les routes `/api/*` exigent toujours le jeton d'administration ou une session du tableau de bord.

Le nom d'affichage sert **uniquement à l'affichage et reste stable entre les régénérations**. À chaque `ocx sync`
et à chaque actualisation du catalogue, opencodex reconstruit les entrées routées depuis `config.json`, y compris
`customModels` ; le nom configuré est donc réappliqué au lieu de revenir à l'identifiant de routage. Un service
géré tente également cette synchronisation peu après le démarrage du proxy. Si cette tentative au démarrage
échoue, par exemple lors d'une connexion hors ligne, le catalogue déjà enregistré est conservé et le prochain
`ocx sync` réussi réapplique le nom configuré. Les véritables noms natifs du service en amont, par exemple
`gpt-5.6-sol` → "GPT-5.6-Sol", proviennent de l'instantané amont épinglé et ne sont jamais remplacés par un nom
d'affichage personnalisé.

### Gestionnaires de fournisseurs externes

Si `config.toml` sélectionne déjà un fournisseur autre que `openai` ou `opencodex`, OpenCodex ne modifie pas le
fichier. Il ignore également l'écriture des profils, l'actualisation du catalogue et du cache, ainsi que la
restauration immédiate ou en arrière-plan des métadonnées de l'historique Codex. Les outils qui gèrent un fournisseur personnalisé
étiquettent souvent les sessions existantes avec son identifiant ; remplacer l'identifiant actif peut faire
disparaître ces sessions pourtant intactes de la vue d'historique de Codex. La même protection s'applique à un
fournisseur externe sélectionné par un ancien profil racine.

Confiez la configuration des fournisseurs Codex à un seul outil. Pour placer OpenCodex derrière un gestionnaire
de fournisseurs existant, faites pointer ce fournisseur vers `http://127.0.0.1:10100/v1` avec un transfert
direct Responses — `wire_api = "responses"` dans le TOML Codex — et non avec une traduction Chat Completions.
Lorsque l'authentification de l'API du proxy est activée, transmettez aussi l'en-tête `x-opencodex-api-key`
depuis `OPENCODEX_API_AUTH_TOKEN`, comme dans la configuration hors bouclage ci-dessus. Pour autoriser OpenCodex
à injecter directement le routage, rétablissez d'abord le fournisseur `openai` intégré de Codex, supprimez toute
clé racine `openai_base_url` appartenant à l'utilisateur, puis relancez `ocx start`.

### Dépannage du catalogue

S'il manque un modèle dans Codex, ou si l'ordre ou la visibilité du catalogue semble incorrect, vérifiez les
éléments suivants dans l'ordre :

1. **`selectedModels`** sur le fournisseur — une liste d'autorisation non vide n'expose que ces identifiants à
   Codex ; une liste vide ou absente expose tous les modèles découverts. Un identifiant absent de la liste
   d'autorisation n'atteint jamais le catalogue.
2. **`disabledModels`** au niveau supérieur — masque les modèles dans le catalogue comme dans `/v1/models`, et
   fait passer les identifiants GPT natifs non qualifiés à `visibility: "hide"`.
3. **`liveModels: false` avec `models` vide** — lorsque la découverte en direct est désactivée et que `models`
   est vide ou absent, opencodex n'expose aucun modèle routé pour ce fournisseur.
4. **Cursor `GetUsableModels`** — l'adaptateur Cursor découvre les modèles par son appel RPC protobuf
   `GetUsableModels`, et non par `/models` ; une modification côté Cursor peut donc changer les identifiants visibles
   indépendamment des autres fournisseurs.
5. **Cache et `ocx sync`** — les catalogues en direct sont mis en cache pendant environ cinq minutes (`modelCacheTtlMs`,
   par défaut `300000`). Exécutez `ocx sync` pour forcer une nouvelle récupération et réécrire le catalogue immédiatement.
6. **Processus Codex `app-server` actif** — réécrire le catalogue sur disque ne suffit pas tant qu'un processus
   Codex `app-server` de longue durée — Codex Desktop ou hôte d'arrière-plan de la CLI — conserve l'ancienne
   liste en mémoire. `ocx sync` et `ocx sync-cache` émettent un avertissement lorsqu'ils détectent ces processus.
   Redémarrez-les avec `ocx sync --restart-codex`, ou arrêtez vous-même les processus `app-server` concernés,
   puis laissez Codex les recréer afin que la nouvelle liste apparaisse.

:::caution[Autres processus d'écriture locaux]
Les écritures du catalogue (`opencodex-catalog.json`, `config.toml`) sont atomiques **au sein** d'opencodex.
Cette garantie évite les fichiers partiellement écrits lorsque deux processus appartenant à opencodex entrent
en concurrence ; elle n'empêche **pas** un autre processus local, un observateur de fichiers ou un agent de
synchronisation de modifier la visibilité ou l'ordre du catalogue après l'écriture d'opencodex. Codex conserve
un fichier `models_cache.json` distinct et peut l'actualiser indépendamment, ce qui modifie la liste visible sans
réécrire `opencodex-catalog.json`. Si la visibilité des modèles change de façon inattendue pendant l'exécution du
proxy, arrêtez ou reconfigurez les autres processus d'écriture, puis exécutez `ocx sync`. Il s'agit d'un risque
lié à un processus d'écriture externe, et non d'un défaut confirmé d'opencodex.
:::

## Erreurs de connexion proxy

Si Codex réessaye puis échoue avec une erreur comme
`stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)`
— ou si Claude Code signale un échec de connexion comparable — le proxy opencodex n'est pas actif : aucun
processus n'écoute sur le port configuré, et le client affiche donc lui-même cette erreur de connexion brute.
Redémarrez le proxy :

```bash
ocx start              # foreground
ocx service install    # persistent: auto-starts on login and respawns on crash
```

`ocx status` indique si le proxy est actif et affiche la même suggestion de redémarrage lorsqu'il ne l'est pas ;
`ocx doctor` évalue la sûreté du redémarrage — couverture par le service ou l'intercepteur.

## Le sélecteur de sous-agents

La synchronisation du catalogue rend les modèles de sous-agents sélectionnés disponibles dans Codex. Consultez
le [sélecteur de modèles de l'application Codex](/fr/guides/codex-app-models/#sélection-des-sous-agents) pour connaître
l'ordre des modèles, et la [surface des sous-agents](/fr/guides/sub-agent-surface/) pour le comportement de la
délégation v1/base/v2 et de ses mécanismes de repli.

## Préchauffage des comptes Codex

Lorsqu'un compte ChatGPT est ajouté au groupe de comptes Codex, opencodex le vérifie avant de l'enregistrer
avec une petite requête en streaming vers le service Codex Responses. La requête utilise un véritable tableau
d'éléments Responses (`input: [{ type: "message", ... }]`), attend `response.completed` et utilise par défaut
`gpt-5.4-mini`. Si ce modèle renvoie HTTP 400, opencodex réessaie avec `gpt-5.5` ; les détails structurés de
l'erreur en amont sont affichés sans exposer le corps brut de la réponse. La revalidation en arrière-plan est
distincte et désactivée par défaut. Elle ne s'exécute que si Token Guardian est actif, si la stratégie
d'actualisation `chatgpt` vaut `proactive` et si `tokenGuardian.codexWarmupEnabled` vaut true.

## Restauration de Codex natif

opencodex ne vous enferme jamais dans sa configuration. **`ocx stop` est l'unique commande qui restaure
entièrement Codex natif** : elle arrête le proxy et le service d'arrière-plan s'il est installé, puis supprime
toutes les lignes injectées et toutes les entrées routées du catalogue. La commande `codex` fonctionne alors
exactement comme si opencodex n'avait jamais été installé :

```bash
ocx stop       # stop the proxy + service, restore native Codex
ocx restore    # restore without stopping  (alias: ocx eject)
ocx restore back # point plain Codex at the running proxy again
```

Lorsque opencodex s'exécute comme [service d'arrière-plan géré](/fr/reference/cli/lifecycle/#ocx-service-installrepairstartstopstatusuninstallremove), il définit
`OCX_SERVICE=1` afin qu'un redémarrage déclenché par le service ne modifie **pas** sans cesse la configuration
Codex. Seule l'exécution explicite de `ocx stop` ou `ocx service stop` restaure Codex natif.
