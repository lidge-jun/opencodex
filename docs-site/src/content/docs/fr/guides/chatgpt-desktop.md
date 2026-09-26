---
title: Déblocage de l'envoi dans ChatGPT Desktop
description: Garder utilisable la zone de saisie de l'application ChatGPT de bureau quand le quota d'utilisation du compte est épuisé (macOS, sur activation).
---

Quand le compte ChatGPT connecté épuise son quota d'utilisation, l'application de bureau ChatGPT
grise son bouton d'envoi, même pour les conversations dont opencodex route les appels de modèle vers
d'autres fournisseurs. Cette intégration macOS, à activer explicitement, garde la zone de saisie
utilisable. Elle est désactivée par défaut.

## Ce qu'elle modifie

opencodex exécute un écouteur TLS local pour `chatgpt.com`. L'application est lancée avec une option
Chromium qui envoie `chatgpt.com` vers cet écouteur ; tous les autres hôtes, sous-domaines compris,
gardent leur route habituelle. Les requêtes sont relayées vers le vrai `chatgpt.com` avec les
identifiants de l'application, et les WebSockets (comme la dictée vocale) sont relayés aussi. Rien
n'est journalisé ni stocké.

Les réponses passent sans modification, sauf pour deux points de terminaison :

- les métadonnées de conversation (`/backend-api/conversation/init` et le flux de conversation) : les
  verrous d'envoi dus au quota d'utilisation sont retirés ;
- l'instantané d'utilisation (`/backend-api/wham/usage`) : la barrière « limite atteinte » est ouverte.

Les verrous d'envoi ayant une autre raison, comme un abonnement requis, sont conservés et listés par
`ocx chatgpt status`. L'utilisation affichée (pourcentages, heures de réinitialisation, bannières)
n'est jamais modifiée, et les serveurs d'OpenAI appliquent toujours toutes les limites à leurs propres
requêtes.

## Configuration

1. Activez la fonctionnalité dans `~/.opencodex/config.json` puis redémarrez opencodex :

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   L'écouteur utilise le port du proxy plus 200 (`10300` par défaut). Définissez
   `chatgptDesktop.port` pour choisir un autre port.

2. Faites confiance une fois à l'autorité de certification locale. La commande demande votre mot de
   passe de session ; exécutez-la vous-même :

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   Sans cette confiance, l'application ne peut pas charger les pages de compte, d'utilisation ni de
   réglages. Si vous utilisez un répertoire opencodex personnalisé, `ocx chatgpt status` affiche la
   commande exacte pour votre configuration.

3. Lancez l'application via opencodex :

   ```bash
   ocx chatgpt launch
   ```

4. Facultatif : faire utiliser la route aussi aux lancements normaux depuis le Dock ou Spotlight :

   ```bash
   ocx chatgpt install-watcher
   ```

   Le surveillant s'exécute à chaque démarrage de l'application. Si l'application a été ouverte
   normalement pendant qu'opencodex tourne, il la quitte juste après son lancement et la rouvre avec
   la route. Il n'agit jamais sur une application déjà en cours d'utilisation et ne fait rien quand
   opencodex ne tourne pas. La commande demande une confirmation ; `--yes` confirme sans interaction.

## Configurations réseau

Aucune règle de VPN ou de proxy n'est nécessaire. En mode par défaut, les arguments de lancement sont
choisis d'après le proxy système à chaque démarrage de l'application :

| Configuration | Arguments de lancement de l'application |
|---|---|
| Sans proxy | La route `chatgpt.com` seule. |
| VPN en mode proxy système | La route, le proxy système avec repli direct, et un contournement pour `chatgpt.com` seulement. |
| VPN en mode TUN | La route seule ; le trafic de boucle locale n'entre jamais dans le tunnel. |
| Fichier PAC | La route seule. Le fichier PAC peut laisser `chatgpt.com` sur le proxy, la zone de saisie peut donc rester verrouillée, mais rien d'autre ne casse. |

opencodex joint le vrai `chatgpt.com` via son propre réglage `proxy`, comme tout son autre trafic
sortant.

## Garder l'application utilisable quand opencodex s'arrête

En mode par défaut, une application routée dépend de l'écouteur : tant qu'opencodex est arrêté, ses
requêtes vers `chatgpt.com` échouent. Le repli PAC lance plutôt l'application avec un fichier PAC
généré, pour qu'elle se replie d'elle-même :

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` n'a d'effet qu'avec `unblockSend`. opencodex écoute alors aussi sur le port de
l'écouteur plus un (`10301` par défaut) et réécrit `chatgpt-unblock.pac` dans son répertoire à chaque
démarrage. Le PAC envoie `chatgpt.com` d'abord vers opencodex, et tous les autres hôtes selon le
routage du système :

| Configuration | Autres hôtes, et `chatgpt.com` tant qu'opencodex est arrêté |
|---|---|
| Aucun proxy, ou VPN en mode TUN | Direct. |
| VPN en mode proxy système | Le proxy système, puis direct. |
| Fichier PAC | Le PAC système, intégré au fichier généré. |

Quand opencodex s'arrête, l'application continue de fonctionner par ce chemin, sans redémarrage ;
seul le déblocage de l'envoi est suspendu jusqu'au retour d'opencodex. Le routage est capturé au
démarrage d'opencodex : après un changement de mode du VPN, redémarrez opencodex et lancez
`ocx chatgpt launch`. Si un PAC système est configuré mais illisible à ce moment, les autres hôtes
passent en direct et opencodex affiche un avertissement.

Après avoir activé ou désactivé `pacFallback`, redémarrez opencodex, lancez `ocx chatgpt launch`, et
relancez `ocx chatgpt install-watcher` si vous utilisez le surveillant.

## Vérifier l'état

```bash
ocx chatgpt status
```

La commande indique si la fonctionnalité est active, si l'écouteur du port est celui d'opencodex, si
le certificat est de confiance, l'état du surveillant, si l'application en cours porte la route, et
les verrous d'envoi conservés volontairement.

## Désactiver

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore` rouvre une application routée avec le réseau natif. Réglez ensuite
`chatgptDesktop.unblockSend` sur `false` et redémarrez opencodex. L'autorité de certification est
partagée avec les intégrations Claude d'opencodex ; ne retirez sa confiance que si vous n'utilisez
ni l'une ni l'autre.

## Dépannage

- **Les pages de compte, d'utilisation ou de réglages ne se chargent pas :** le certificat n'est pas
  de confiance. Refaites l'étape 2 ; `ocx chatgpt status` affiche l'état de confiance.
- **Le bouton d'envoi reste grisé :** consultez `ocx chatgpt status`. L'application tourne peut-être
  sans la route (lancez `ocx chatgpt launch`), ou le verrou a une raison autre que le quota
  d'utilisation, listée sous « send blocks kept ».
- **L'application ne charge plus rien après l'arrêt d'opencodex :** en mode par défaut, une
  application routée dépend de l'écouteur. Redémarrez opencodex ou lancez `ocx chatgpt restore`, ou
  activez le repli PAC pour que l'application se replie d'elle-même.
