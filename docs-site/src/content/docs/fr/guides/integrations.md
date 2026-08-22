---
title: Intégrations
description: Connectez opencodex à OpenCode, Pi, OMP, Hermes, OpenClaw, Kimi Code, Gajae Code, DeepSeek Harness et MiniMax Code depuis le tableau de bord — un commutateur par client, avec une sauvegarde avant chaque écriture.
---

L'onglet **Intégrations** écrit le bloc fournisseur d'opencodex dans le fichier de configuration du client,
puis peut le retirer. Neuf clients fonctionnent ainsi, chacun avec son propre commutateur :

| Client | Fichier de configuration | Format | Prise d'effet de la modification | Identifiant |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | au prochain lancement direct | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | dans les nouvelles sessions | valeur fictive de bouclage |
| OMP | `~/.omp/agent/models.yml` | YAML | après le redémarrage d'OMP | valeur fictive `opencodex-loopback` |
| Hermes | `~/.hermes/config.yaml` | YAML | dans les nouvelles sessions | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | immédiatement, sur une passerelle en cours d'exécution | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | au redémarrage ou avec `/reload` | valeur fictive de bouclage |
| Gajae Code | `~/.gjc/agent/models.yml` | YAML | dans les nouvelles sessions ou à l'ouverture de `/model` |`OPENCODEX_GAJAE_API_KEY` |
| DeepSeek Harness (DSH) | `$DSH_HOME/settings.yaml` (`~/.dsh/settings.yaml` par défaut) | YAML | rechargement à chaud | jeton porteur fictif et non secret pour le bouclage |
| MiniMax Code | `~/.minimax/config.yaml` | YAML | dans les nouvelles sessions ou après l’ouverture du sélecteur de modèles | valeur fictive de bouclage |

La prise en charge gérée de DSH exige au minimum **DSH 0.1.0-rc.6**. OpenCodex ne possède que le fragment
`llm-pi-ai.providers.opencodex` : **Appliquer** et **Actualiser** remplacent ce fragment, **Désactiver** ne
supprime que ce fragment, et **Restaurer** rétablit un instantané enregistré. DSH recharge à chaud les
modifications de fournisseurs. Ces opérations ne changent ni le modèle par défaut de l'utilisateur ni le
fournisseur natif `deepseek-official`. L'intégration DSH gérée est actuellement limitée au bouclage et
n'écrit jamais de véritable identifiant.

MiniMax Code recherche d’abord `MINIMAX_DATA_DIR`, puis `MAVIS_DATA_DIR`, avant de se rabattre sur
`~/.minimax`. Son bloc géré ne possède que `custom_provider.opencodex`. Il ne modifie ni `defaultModel`, ni
la source d’identification MiniMax sélectionnée, ni la connexion MiniMax de l’utilisateur. Après l’avoir
connecté, choisissez dans MCode une entrée `custom_provider:opencodex/<provider/model>`.
L’actualisation de l’intégration met également à jour les fenêtres de contexte par modèle et les choix
d’effort de raisonnement faisant autorité ; les capacités inconnues sont omises et l’effort courant,
qui appartient à la session MCode, est préservé.

Les chemins respectent les variables de remplacement propres à chaque client, lorsqu'elles existent. Pour
OMP, la présence de `OMP_PROFILE` l'emporte sur `PI_PROFILE`, même si sa valeur est explicitement vide. Un
profil nommé emploie `PI_CONFIG_DIR` comme nom de répertoire relatif au dossier personnel de l'utilisateur
et ignore `PI_CODING_AGENT_DIR` ; en l'absence de profil nommé, `PI_CODING_AGENT_DIR` l'emporte. OMP prend
en charge les en-têtes au niveau du fournisseur, mais cette première intégration est volontairement limitée
au bouclage ; la configuration distante de `x-opencodex-api-key` est reportée. Les chemins déplacés définis
par `HERMES_HOME`, `KIMI_CODE_HOME` et `XDG_CONFIG_HOME` sont eux aussi suivis au lieu d'être devinés. Le
tableau indique la valeur par défaut de chaque client.

Pour les modèles OpenAI natifs, le bloc OMP généré sélectionne leur API Responses au niveau du modèle et
préserve l'entrée d'images ainsi que les réglages de l'effort de raisonnement. Les modèles routés conservent
le dialecte Chat Completions de leur fournisseur afin que leurs adaptateurs existants restent compatibles.

OpenClaw possède plusieurs variables, aux rôles différents. `OPENCLAW_CONFIG_PATH` sélectionne le fichier ;
`OPENCLAW_STATE_DIR`, `OPENCLAW_PROFILE` et `OPENCLAW_HOME` sélectionnent le répertoire d'état, sur lequel
porte également la détection. Un profil ou un dossier personnel déplacé est donc toujours reconnu comme une
installation, tandis qu'un remplacement du chemin de configuration ne déplace que le fichier. L'ancienne
arborescence `.clawdbot` est elle aussi détectée : le répertoire moderne l'emporte lorsqu'il existe, et
l'ancien n'est utilisé que s'il est le seul présent.

Ces chemins doivent être **absolus** ou commencer par `~`. Un chemin relatif est refusé plutôt que résolu,
car il désignerait le répertoire depuis lequel chaque processus aurait été lancé. Comme ce chemin est
enregistré avec la sauvegarde, il doit désigner demain le même fichier qu'aujourd'hui.

opencodex lit ces variables dans son propre environnement. Si votre passerelle utilise un profil ou un
dossier personnel déplacé, lancez opencodex avec les mêmes variables ; sinon, il suivra correctement une
autre installation.

## Les quatre autres surfaces ne sont pas des commutateurs

**Clés API** gère les propres identifiants d'opencodex et n'est donc pas un client. **Codex CLI** est relié
par le service du proxy lui-même : démarrer opencodex applique ce routage et l'arrêter restaure le routage
natif ; aucun fichier ne doit donc être activé ou désactivé séparément. **Claude** conserve son propre
indicateur d'activation et le flux **Enregistrer/Appliquer** de Desktop, tandis que **Grok Build** conserve
sa barrière « sélectionner, puis appliquer » pour les modèles. Ces règles sont antérieures à cette
fonctionnalité et restent inchangées.

## Restauration

Avant chaque écriture réussie, un instantané de votre fichier est créé ; votre état antérieur reste donc
toujours récupérable :

- **Annuler** apparaît sur l'opération la plus récente lorsque votre fichier correspond toujours à ce qui a été écrit.
- **Restaurer ce point…** apparaît sur les opérations plus anciennes, ou lorsque le fichier a changé depuis l'opération. Une restauration malgré une telle modification demande une deuxième confirmation avant de remplacer vos changements récents et les sauvegarde elle aussi, afin que la restauration puisse être annulée.
- Dix sauvegardes sont conservées par client. Au-delà, les fichiers d'instantanés les plus anciens sont supprimés et leurs lignes d'historique affichent **Sauvegarde expirée**.

La désactivation ne supprime que les entrées enregistrées par opencodex comme lui appartenant. Si votre
fichier a changé après l'écriture, le comportement dépend de l'intégrité de ces entrées et du format du
fichier. Pour les configurations JSON strictes (OpenCode et Pi), une modification **à côté** du bloc géré —
par exemple l'ajout d'un serveur MCP ou de votre propre fournisseur — affiche **Mise à jour nécessaire** :
l'actualisation fusionne les changements autour de vos entrées et les conserve, même si le formatage peut
être normalisé. Font exception les valeurs que JSON ne peut pas réécrire exactement : un nombre non fini
comme `1e999`, un nombre qu'une réécriture arrondirait (un très grand entier ou une valeur si petite qu'elle
deviendrait zéro), `-0`, une même clé écrite deux fois dans un objet ou une imbrication de plus de 1000
niveaux. Dans ces cas, le commutateur est verrouillé afin que rien ne soit modifié ou supprimé silencieusement.
**OMP** n'est pas affecté non plus par les modifications voisines, mais pour une autre raison : son outil
d'écriture ne modifie, octet par octet, que sa propre plage `providers.opencodex` ; le reste du fichier
n'est jamais réécrit. Pour les autres formats susceptibles de contenir des commentaires (Hermes, OpenClaw,
Kimi Code, Gajae Code et MiniMax Code — documents YAML, JSON5 et TOML réécrits en entier), ou lorsque les propres entrées
d'opencodex ont été modifiées, le commutateur se verrouille et la désactivation est refusée plutôt que de
deviner quelles modifications vous appartiennent.

## À quoi s'attendre, en toute transparence

**Le formatage n'est généralement pas préservé.** L'application analyse une configuration avant de la
réécrire ; JSON, JSON5 et TOML peuvent donc être reformatés, et les commentaires JSON5 ou TOML sont perdus.
OMP et DSH font exception : leurs outils d'écriture YAML ne modifient que `providers.opencodex` et
`llm-pi-ai.providers.opencodex`, respectivement, tout en préservant octet par octet les commentaires et le
formatage des fournisseurs sans rapport. Si la plage source exacte ne peut pas être identifiée de manière
sûre, l'opération est refusée. Pour les autres clients, utilisez **Restaurer** lorsque vous avez besoin des
octets précédents du fichier : l'instantané en est une copie exacte.

**Si une valeur ne peut pas être réécrite fidèlement, le commutateur refuse l'opération.** L'aller-retour
couvre les types de valeurs que ces formats emploient en pratique. Lorsqu'il ne le peut pas — par exemple
pour un fichier TOML utilisant `inf` ou `nan`, que l'analyseur disponible ne peut relire avec exactitude —
l'application s'arrête et le signale au lieu d'écrire une valeur modifiée en prétendant que l'opération a
réussi. Le fichier concerné est indiqué et rien n'est déplacé sur le disque. Vous pouvez toujours modifier
ce fichier manuellement ; seule la réécriture automatique est refusée.

**Pi, Kimi Code, Gajae Code, MiniMax Code et l'intégration DSH gérée fonctionnent uniquement avec une adresse de
bouclage.** Les quatre premiers n'ont aucun champ de configuration pour l'en-tête `x-opencodex-api-key`
qu'exige une liaison hors bouclage. DSH possède une table d'en-têtes générique, mais rc.6 ne documente pas
cet en-tête d'admission dédié comme contrat d'intégration pris en charge ; l'outil d'écriture géré échoue
donc de façon fermée plutôt que d'improviser. Donnez-leur accès au bouclage par un tunnel SSH ou par un
relais local qui ajoute l'en-tête.

**L'intégration OMP générée est elle aussi volontairement limitée au bouclage.** OMP prend en charge les
en-têtes au niveau du fournisseur, mais cette première intégration n'écrit pas les identifiants distants
`x-opencodex-api-key`. Pour l'instant, la configuration manuelle d'OMP à distance sort du périmètre de
l'intégration gérée.

**Kimi Code ne peut pas contenir de référence à une variable d'environnement** ; sa configuration reçoit
donc la valeur fictive `opencodex-loopback` plutôt qu'une clé. Aucun véritable identifiant n'est écrit dans
une configuration cliente.

**Pour `ocx opencode`, le bloc fournisseur du lanceur l'emporte.** Le lanceur injecte
`provider.opencodex` par `OPENCODE_CONFIG_CONTENT`, qui est prioritaire sur la même entrée enregistrée sur
le disque ; le reste de votre configuration opencode continue de s'appliquer normalement. Le commutateur
décrit ici est celui qui compte lorsque vous lancez directement `opencode`.

## Depuis le terminal

Les mêmes opérations sont disponibles sans interface graphique :

```bash
ocx integration client status
ocx integration client enable --client hermes
ocx integration client disable --client hermes
ocx integration client history --client hermes
ocx integration client restore --op <opId> [--confirm-drift]
```

Pour MiniMax Code, connectez une fois le fournisseur puis utilisez l’enveloppe qui vérifie la connexion :

```bash
ocx integration client enable --client mcode
ocx mcode
```

Une fois l’intégration connectée, `ocx sync` actualise également le bloc MCode géré avec les fenêtres de
contexte et les niveaux d’effort de raisonnement actuels. Les blocs absents, modifiés par un tiers, non sûrs
ou jamais gérés restent intacts ; réactivez explicitement l’intégration lorsque vous souhaitez la reconnecter.

Le CLI distinct de la plateforme MiniMax (`mmx`) n’est pas une intégration à commutateur de fichier. Ses
commandes textuelles utilisent le point de terminaison compatible avec Anthropic de MiniMax ; OpenCodex
fournit donc un lanceur isolant les identifiants et limité à l’adresse locale :

```bash
ocx mmx text chat --model anthropic/claude-opus-5 --message "Hello"
ocx mmx text repl --model openai/gpt-5.6-sol
```

Seules les commandes `mmx text chat` et `mmx text repl` passent par le proxy. Utilisez directement `mmx`
pour les commandes MiniMax natives d’image, de vidéo, de parole, de musique, de vision, de recherche, de
quota, d’authentification, de configuration, de fichier et de mise à jour. L’enveloppe emploie une
configuration temporaire qui ne contient qu’une valeur fictive locale et non secrète ; elle ne charge
jamais les identifiants OAuth ou de clé d’API de `~/.mmx`, et refuse les remplacements `--api-key`,
`--base-url` et `--region`. Consultez [Clients MiniMax](/fr/guides/minimax/) pour connaître le flux complet
et ses limites.

`--confirm-drift` n'est jamais présumé. Si le fichier a changé depuis l'opération que vous restaurez, la
commande refuse et vous l'indique : remplacer vos modifications plus récentes relève de votre décision.

Les détails des clients ont été vérifiés par rapport au format de configuration propre à chaque projet ;
consultez les notes de recherche dans
`devlog/_fin/260802_client_toggle_api/002_client_toggle_matrix.md` pour savoir ce qui a été contrôlé et quand.
