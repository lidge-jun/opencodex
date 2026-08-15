---
title: Tableau de bord web
description: L'interface graphique d'opencodex pour l'état du proxy, les fournisseurs, les modèles, les consignes de délégation, les groupes d'authentification, l'utilisation et les journaux.
---

opencodex fournit un tableau de bord web local — une application Vite/React située sous `gui/` — servi par
le proxy. C'est le moyen le plus direct de gérer les fournisseurs, les comptes Codex/ChatGPT, les modèles du
catalogue, les services auxiliaires, les réglages des sous-agents et le trafic des requêtes.

## Ouverture

```bash
ocx gui
```

Cette commande ouvre `http://localhost:<port>` dans votre navigateur et démarre d'abord automatiquement le
proxy si nécessaire. En développement, vous pouvez lancer séparément le serveur de développement de
l'interface contre un proxy déjà actif :

```bash
ocx start
bun run dev:gui
```

## Connexion

Avec la liaison de bouclage par défaut (`localhost` / `127.0.0.1`), le tableau de bord ne demande jamais de
jeton : le proxy insère dans la page servie des sessions d'interface graphique de courte durée et les
renouvelle silencieusement à leur expiration ou au redémarrage du proxy. Seul un tableau de bord lié à un
nom d'hôte hors bouclage exige le jeton administrateur (`OPENCODEX_ADMIN_AUTH_TOKEN`, ou le fichier généré
automatiquement `~/.opencodex/admin-api-token`).

Lorsqu'un tableau de bord distant exige cet identifiant, il présente un formulaire de mot de passe standard,
ce qui permet au gestionnaire de mots de passe du navigateur de proposer son enregistrement et son
remplissage automatique. Le tableau de bord lui-même ne conserve le jeton qu'en mémoire et ne l'écrit ni
dans `localStorage` ni dans `sessionStorage` ; son enregistrement dépend entièrement du navigateur ou du
gestionnaire de mots de passe.

## Fonctions disponibles

| Zone | Fonction |
| --- | --- |
| **Résumé du tableau de bord** | Mode multi-agent, état en ligne, version, durée de fonctionnement, nombre de fournisseurs, total de jetons sur 30 jours, fournisseurs actifs et modèles natifs/routés disponibles. |
| **Délégation de sous-agent** | Choisissez un modèle natif ou routé et, facultativement, un effort de raisonnement partagés entre les consignes de délégation OpenCodex et l'option distincte de valeurs par défaut natives. Il ne s'agit pas d'un routeur par création de sous-agent côté proxy ; voir ci-dessous. |
| **Services auxiliaires** | Choisissez le modèle et l'effort de recherche web, ainsi que le modèle de description visuelle. Les modifications s'appliquent à la requête suivante. |
| **Maintenance** | Resynchronisez le catalogue de modèles Codex, examinez les avertissements de contournement par une configuration locale au projet, recherchez la dernière version stable ou préliminaire et lancez une mise à jour avec redémarrage facultatif du proxy. |
| **Sécurité au démarrage** | Vérifiez si le routage Codex injecté résiste à un redémarrage, avec des états distincts pour le service et le lanceur intermédiaire, ainsi que les commandes de réparation exactes. |
| **Zone de notification Windows** | Installez au niveau de l'utilisateur un contrôleur lancé à la connexion pour démarrer, arrêter ou redémarrer le proxy en un clic, ouvrir le tableau de bord et consulter l'état. Ce contrôleur n'est pas un service de redémarrage du proxy. |
| **Démarrage automatique de Codex** | Autorisez un lanceur intermédiaire Codex déjà installé à exécuter `ocx ensure`. Ce commutateur n'installe ni lanceur ni service d'arrière-plan. |
| **Fournisseurs** | Ajoutez, modifiez, activez, désactivez ou supprimez des fournisseurs, définissez le fournisseur par défaut parmi ceux activés et gérez, lorsqu'ils sont pris en charge, les groupes de comptes OAuth et de clés API. Si le fournisseur par défaut actuel est supprimé, le premier fournisseur activé restant prend sa place ; s'il n'en reste aucun, la suppression est refusée et le fournisseur par défaut actuel est conservé. Les réglages d'un fournisseur peuvent désactiver la découverte dynamique pour les points de terminaison dont le catalogue `/models` est absent, lent ou trop volumineux. Pour les groupes OAuth Claude (Anthropic), chaque compte connecté affiche ses propres barres de limites sur 5 heures et une semaine — l'utilisation est propre à chaque identifiant. En cas d'échec d'une sonde, les dernières barres connues sont conservées et marquées indisponibles jusqu'à la prochaine actualisation réussie. |
| **Ajouter un fournisseur** | Recherchez dans les préréglages du registre une connexion par compte, un service à clé API, un serveur local ou un point de terminaison personnalisé. |
| **Authentification Codex** | Ajoutez des comptes ChatGPT/Codex au groupe, sélectionnez le compte de la prochaine session, actualisez les quotas sur 5 h, une semaine et 30 jours, activez ou désactivez le changement automatique selon les quotas, réglez son seuil de 1 à 100 % et configurez le basculement en cas de défaillance transitoire. |
| **Sous-agents** | Mettez en avant jusqu'à cinq modèles natifs non qualifiés ou modèles routés avec espace de noms dans la liste des remplacements de `spawn_agent`. |
| **Modèles** | Activez ou désactivez les modèles GPT natifs et routés, définissez les listes d'autorisation et les plafonds de contexte des fournisseurs, choisissez v1/base/v2 et configurez la limite de fils v2. Les fournisseurs configurés restent visibles sous forme de groupes sans modèle lorsque la découverte est désactivée ou ne renvoie aucune ligne. |
| **Journaux** | Actualisez automatiquement les requêtes récentes et consultez les jetons, l'effort demandé et, lorsqu'il est disponible, l'effort sortant effectif, le modèle résolu, le fournisseur, l'état, l'identifiant de requête, la durée et les détails de l'erreur. La vue détaillée inclut le champ exact de raisonnement transmis lorsque l'adaptateur en émet un. Filtrez par identifiant opaque de conversation ou de session — si le client en fournit un — afin d'obtenir le total des jetons et le coût estimé au tarif catalogue pour l'anneau de journaux actuellement chargé. |
| **Utilisation / Débogage** | Examinez la couverture et les tendances d'utilisation des jetons, ou activez à la demande les diagnostics de transport et d'extraction de l'utilisation propres aux fournisseurs. |
| **Stockage** | Consultez en lecture seule la répartition du disque de CODEX_HOME — sessions, archives, bases de données et pièces jointes. Pour le nettoyage facultatif des archives, prévisualisez les N % les plus anciennes, puis placez-les en quarantaine dans `CODEX_HOME/.trash` (par défaut) ou supprimez-les définitivement après avoir coché une case explicite. **La stratégie de nettoyage automatique** est facultative et **désactivée par défaut** (`storageCleanupPolicy.enabled`) ; configurez son seuil, sa cible, sa planification et son mode sur la page **Stockage**, ou lancez **Exécuter maintenant**. Les entrées mises en quarantaine peuvent être restaurées depuis cette page (JSONL et fils). Les sessions actives restent en lecture seule. Le nettoyage et la restauration sont refusés tant que Codex verrouille le fichier `state_*.sqlite` le plus récent ou actif. |
| **Arrêter** | Arrêtez proprement le proxy et le service d'arrière-plan installé, restaurez Codex natif et quittez (`POST /api/stop`). |

### Liens directs vers une section

Il n'existe qu'une seule mise en page, donc aucun commutateur de disposition n'est à configurer. Les sections
du tableau de bord possèdent plutôt leur propre adresse : `#dashboard` ouvre **Vue d'ensemble**, tandis que
`#dashboard/providers` et `#dashboard/models` ouvrent les deux autres sections. Le rechargement, les favoris
et le bouton **Précédent** conservent la section affichée. **Journaux** fonctionne de la même manière avec
`#logs` et `#logs/debug`. Un ancien favori `#providers/workspace` ouvre désormais `#providers`.

Les coûts affichés dans **Journaux** et **Utilisation** sont des équivalents au tarif catalogue de l'API,
calculés à partir des jetons signalés. Ils ne constituent ni des reçus de facturation ni la preuve d'une
dépense réelle ; un abonnement ou des crédits du fournisseur peuvent s'appliquer à la place.

## Visibilité des modèles

Les commutateurs de la page **Modèles** reflètent la visibilité Codex finale : un modèle routé est actif
uniquement si la liste d'autorisation de son fournisseur l'inclut — ou si aucune liste n'est définie — et
s'il n'est pas désactivé. Activer un modèle réconcilie atomiquement les deux filtres ; **Tout activer** efface
la liste d'autorisation du fournisseur afin que les modèles découverts ultérieurement soient eux aussi actifs.

## Sélecteur de délégation et routage des créations de sous-agents

Le sélecteur **Délégation de sous-agent** du tableau de bord enregistre `injectionModel` et, facultativement,
`injectionEffort`. L'option **Consignes multi-agents OpenCodex** contrôle indépendamment les instructions de
délégation qui emploient ces valeurs. Pendant les tours v2 admissibles, ces consignes indiquent à l'agent
parent le modèle exact et l'effort de raisonnement à transmettre à `spawn_agent` ; effacer le modèle efface
aussi l'effort enregistré.

Le commutateur **Utiliser comme valeurs par défaut des sous-agents Codex natifs**, désactivé par défaut,
applique la même sélection aux valeurs par défaut `[agents]` natives de Codex lors de la synchronisation ou du
redémarrage suivant, lorsque OpenCodex gère le routage Codex actif. Les configurations de fournisseurs externes
gérées par l'utilisateur restent intactes. Ces valeurs par défaut concernent les nouvelles tâches Codex et ne
provoquent pas à elles seules une délégation. Les valeurs `[agents]` existantes appartenant à l'utilisateur
sont préservées au lieu d'être remplacées et peuvent donc continuer à primer sur celles demandées.

:::caution
Aucun de ces contrôles n'est un routeur intermodèle de création de sous-agents côté proxy. Les consignes
OpenCodex demandent à Codex de transmettre les remplacements à `spawn_agent` ; les valeurs par défaut natives
`[agents]` ne s'appliquent que lorsque Codex crée une nouvelle tâche après leur synchronisation. Consultez
[Surface des sous-agents](/fr/guides/sub-agent-surface/) pour le comportement canonique v1/base/v2.
:::

La garantie de remplacement lors d'une création de sous-agent s'applique au texte de consignes v2 **intégré**.
Un `injectionPrompt` personnalisé remplace entièrement ce texte et doit contenir les espaces réservés
`{{model}}` et `{{effort}}` — et facultativement `{{roster}}` — sans quoi ces valeurs n'apparaîtront pas dans
les consignes injectées.

Le sélecteur propose les modèles natifs et routés activés, ainsi que l'échelle globale d'effort de Codex.
L'API valide globalement l'effort choisi ; Codex continue de valider l'effort de création d'un sous-agent par
rapport à l'entrée cible du catalogue.

## Authentification Codex et groupes de comptes

La page **Authentification Codex** gère la route ChatGPT/Codex native.

Le mode Pool sélectionne parmi le compte Codex principal et les comptes ajoutés ; Direct utilise uniquement
la connexion du compte appelant/principal. Les requêtes en cours conservent les identifiants qu'elles ont
capturés. Une réauthentification 401/403 ou un temps de recharge 429 peut effacer l'affinité et faire passer
la route à un autre compte Pool admissible. Ce mécanisme est distinct d'`openai-apikey` et des autres fournisseurs.

- Choisir manuellement un compte s'applique immédiatement : un fil déjà associé y passe à sa prochaine requête, et seules les requêtes déjà en cours conservent le compte capturé. Le choix manuel est aussi épinglé : la fiche affiche le badge **ÉPINGLÉ**, et un ordre de sélection supérieur ne peut pas prendre la priorité sur ce compte avant son épuisement, la sélection d'un autre compte ou la modification de l'ordre de sélection de n'importe quel compte.
- Chaque fiche de compte possède un contrôle **Ordre de sélection** (**Premier**, **Plus tôt**, **Normal**, **Plus tard**, **Dernier**). Les ordres supérieurs sont utilisés en premier ; le pool ne descend à un ordre inférieur qu'une fois tous les comptes supérieurs épuisés ou indisponibles. Un changement d'ordre s'applique dès la prochaine requête sans association et ne déplace jamais un fil déjà associé. Le compte Codex Desktop principal est ordonné comme les autres : il peut être placé en **Dernier** et conservé comme réserve. Un ordre défini avec `ocx account priority` en dehors de ces cinq préréglages reste visible et sélectionnable sur la fiche.
- L'affinité des fils évite les changements à chaque requête. Lorsque le changement automatique selon les quotas est activé, un fil de longue durée est réévalué périodiquement et peut être réassocié quand son utilisation pertinente atteint le seuil et qu'il existe un compte admissible dont l'utilisation est strictement inférieure.
- Les nouvelles sessions peuvent choisir le compte admissible le moins utilisé. Pour les forfaits payants, le score retient la fenêtre connue la plus sollicitée parmi 5 h, une semaine et 30 jours ; les forfaits Go/Free utilisent uniquement la fenêtre de 30 jours.
- Lorsque WHAM fournit `limit_window_seconds`, **Authentification Codex** classe une fenêtre principale d'au moins 28 jours comme une fenêtre de 30 jours au lieu de supposer que toute fenêtre principale est hebdomadaire. Les réponses sans durée conservent l'ancienne interprétation hebdomadaire.
- **Actualiser les quotas** relit immédiatement l'utilisation des comptes afin que le routage et les fiches utilisent les mêmes valeurs.
- Les journaux des requêtes du pool utilisent des libellés opaques comme `p3fa91c`, jamais les adresses courriel des comptes.
- Chaque fiche affiche aussi ce libellé stable de journal, le total de jetons observé sur 30 jours, un coût approximatif équivalent à l'API selon les tarifs d'affichage actuellement configurés et la proportion de tentatives dont l'utilisation a été mesurée. Les remplacements `modelCosts` actifs de l'utilisateur priment sur le catalogue vérifié fourni et les tarifs de secours ; l'utilisation historique est réestimée d'après les tarifs actifs au moment de la lecture du résumé. Ce coût sert au rapprochement et reste une estimation, pas une facture d'abonnement ChatGPT Plus/Pro. Les anciennes lignes `openai` non qualifiées antérieures à l'attribution explicite restent ambiguës au lieu d'être affectées au compte principal actuel.
- **Cibler un compte Codex précis depuis le sélecteur de modèles** est une option explicite. Lorsqu'elle est activée, les lignes GPT ordinaires prises en charge sont remplacées par une entrée par sélecteur public de compte. En choisir une verrouille cette conversation sur le compte associé : elle ne change pas de compte, ne se rabat pas et ne modifie pas le compte Pool actif. La connexion intégrée de Codex App possède son propre sélecteur ; les tables générées utilisent normalement `main`, avec un suffixe sans collision comme `main-2` si nécessaire. Les comptes ajoutés reçoivent des libellés stables qui préservent la confidentialité, et les libellés personnalisés existants sont conservés. Les conversations existantes et les sélections de modèles enregistrées continuent d'être routées. Désactiver le réglage masque les entrées générées sans supprimer les comptes, les sélecteurs ni les routes exactes. Les identifiants GPT non qualifiés continuent d'employer le comportement Pool ou Direct configuré.
- Les changements d'ajout, de suppression et de réglage des sélecteurs de compte sont enregistrés avant l'actualisation du catalogue de modèles. Si cette actualisation limitée dans le temps n'aboutit pas, le tableau de bord affiche un avis orange indiquant la réussite et la procédure de récupération ; exécutez `ocx sync` pour réessayer. Le changement de compte ou de réglage reste enregistré.

La vue d'ensemble des **Fournisseurs** résume séparément l'utilisation du mode Pool sous forme d'une estimation
pondérée de la capacité destinée uniquement à l'affichage, avec le quota brut du compte effectif et la
prochaine récupération de capacité. Consultez
[Capacité du pool dans la vue d'ensemble des fournisseurs](/fr/guides/providers/#aperçu-de-la-capacité-du-pool-des-fournisseurs)
pour les champs affichés, la signification d'une couverture incomplète et la limite de cette information au routage.

## Mettre le dépôt en vedette relève de votre choix, pas de celui d'un agent

Le bouton étoile de la barre latérale — et la question unique posée par `ocx start` dans un terminal
interactif — utilise **votre propre connexion `gh`**. opencodex ne détient aucun jeton GitHub et apprend
uniquement votre réponse affirmative ou négative.

Comme cette action écrit dans votre compte GitHub, les appels pilotés par un agent sont refusés au lieu
d'être autorisés à répondre à votre place :

- `ocx start` et `ocx service install` **ignorent entièrement la question** lorsqu'ils sont pilotés par un agent ou un environnement CI (`CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_TRACE_ID`, `CI` et équivalents). Le marqueur unique n'est pas écrit : la véritable question apparaîtra encore lors de votre prochaine exécution manuelle. L'agent reçoit l'instruction de vous la poser directement, sous la forme d'un choix clair **Oui/Non** exigeant votre réponse, et non d'une remarque discrète qu'il pourrait contourner. Si vous ne répondez pas, il doit vous la poser de nouveau plutôt que d'interpréter votre silence comme un refus.
- `POST /api/github/star` répond `403` avec `code: "agent_consent_required"` lorsque le proxy s'exécute dans une session d'agent et que la requête ne possède aucune session de navigateur du tableau de bord. Détenir le jeton administrateur ne vaut pas consentement : un agent sur votre machine peut lire ce fichier.
- Le bouton du tableau de bord continue de fonctionner normalement. Un véritable clic apporte la preuve d'une session de même origine ; il est donc reconnu comme provenant de vous, même si un agent a démarré le proxy.
- Un refus met fin à la demande. Rien n'est conservé et rien n'est ajouté à une invite de modèle pour vous inciter à accepter plus tard.

## Communication entre le tableau de bord et le proxy

L'interface graphique est un client léger de l'API JSON de gestion du proxy. Parmi les points de terminaison utiles :

| Point de terminaison | Fonction |
| --- | --- |
| `GET` / `PUT /api/settings` | Lire les réglages ou modifier le démarrage automatique de Codex, les paramètres de flux et de mémoire, ainsi que la visibilité du sélecteur ciblant les comptes. |
| `GET` / `POST /api/github/star` | Lire l'état de mise en vedette dérivé de `gh` ou mettre le dépôt en vedette. Le POST est refusé avec `403` et `agent_consent_required` pour les appels pilotés par un agent sans session de tableau de bord. |
| `GET /api/startup-health` | Lire, sans secrets, les diagnostics de routage, de service, de lanceur intermédiaire et de sécurité au redémarrage. |
| `POST /api/startup-action` | Installer le service d'arrière-plan ou le lanceur intermédiaire Codex au moyen d'actions fixes et autorisées. |
| `GET` / `POST /api/windows-tray` | Lire ou modifier l'installation de la zone de notification Windows et l'état du processus visible. POST accepte `install`, `start`, `stop` ou `uninstall`. |
| `POST /api/sync` | Reconstruire le catalogue de modèles partagé et rendre obsolète le cache de modèles Codex. |
| `GET /api/update/check` · `POST /api/update/run` · `GET /api/update/status` | Rechercher, exécuter et surveiller les tâches d'auto-mise à jour. Les PID des processus sont conservés pour qu'une tâche interrompue récupère automatiquement ; les anciennes tâches sans PID récupèrent après dix minutes. |
| `GET` / `PUT /api/sidecar-settings` | Lire ou définir les modèles des services auxiliaires de recherche et de vision. |
| `GET` / `PUT /api/injection-model` | Lire ou définir le choix partagé du modèle et de l'effort du sous-agent, ainsi que les commutateurs indépendants de consignes et de valeurs par défaut natives. |
| `GET` / `PUT /api/v2` | Lire ou définir le mode de surface, l'indicateur de fonctionnalité Codex et la limite de fils v2. |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | Répertorier, ajouter/remplacer, activer/désactiver, définir par défaut ou supprimer des fournisseurs. `PATCH` emploie seul `{ "setDefault": true }` sur un fournisseur activé ; `POST` peut inclure `setDefault` lors d'une création ou d'un remplacement, également sur un fournisseur activé uniquement. Supprimer le fournisseur par défaut actuel affecte le premier fournisseur activé restant, s'il en existe un ; sinon, l'API renvoie `409` avec `code: "last_provider"` et conserve le fournisseur par défaut actuel. |
| `GET /api/models` · `PUT /api/disabled-models` | Répertorier les lignes de modèles natifs/routés et mettre à jour l'ensemble partagé des modèles désactivés. |
| `GET /api/selected-models` · `PUT /api/model-visibility` | Lire les listes d'autorisation des fournisseurs et modifier atomiquement la visibilité finale d'un modèle ou d'un groupe de fournisseurs. |
| `GET /api/key-providers` · `GET /api/oauth/providers` | Lire les catalogues de fournisseurs à clé API et OAuth. |
| `POST /api/oauth/login` · `GET /api/oauth/status` | Démarrer le flux OAuth d'un fournisseur et interroger son état jusqu'à son achèvement. |
| `GET /api/codex-auth/accounts?refresh=1` | Répertorier le compte principal et les comptes du pool, forcer l'actualisation des quotas et signaler les états `hasCredential` du compte principal et `needsReauth` définitif. |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | Sélectionner le compte de la prochaine requête et configurer le routage du pool. |
| `GET /api/codex-auth/active` · `PUT /api/codex-auth/accounts/priority` | Lire le compte effectif — notamment `pinned` et le compte désigné par `pinnedAccountId` — et définir l'ordre de sélection d'un compte. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | Ajouter un compte au groupe au moyen d’une connexion dans le navigateur. |
| `GET /api/logs?tail=50&limit=20&offset=0&provider=...&status=5xx` | Lire les métadonnées des requêtes récentes avec des filtres facultatifs de fin de journal, de fournisseur et d'état exact ou par classe. Avec `limit`/`offset`, la pagination remonte depuis la ligne la plus récente (`offset=0` renvoie la dernière page). Forme de la réponse : `{ timeZone, total, logs }`, où `total` est le nombre de lignes filtrées avant pagination. |
| `GET` / `PUT /api/subagent-models` | Lire ou définir les cinq modèles de remplacement `spawn_agent` mis en avant. |
| `POST /api/stop` | Arrêter le proxy et le service, restaurer Codex natif et quitter. |

:::tip
L'ajout d'**Ollama Cloud** ou d'un autre fournisseur doté d'un catalogue depuis le tableau de bord copie sa
classification texte/vision dans la configuration enregistrée du fournisseur. Le
[service auxiliaire de vision](/fr/guides/sidecars/) est ainsi correctement conditionné sans classification manuelle.
:::
