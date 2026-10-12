---
title: Profils de connexion principale native
description: Gérez les profils de connexion Codex native enregistrés séparément du routage OpenCodex Pool.
---

## La connexion native ne sélectionne pas le Pool

Dans **Codex Set → Multi-auth**, ouvrez **Manage main login** dans le panneau
**Native main login**, juste sous la carte du compte principal. Le même panneau
figure à côté de cette carte dans l'espace des comptes fournisseurs. Il gère la
connexion physique de Codex, et non le compte choisi pour la prochaine requête
Pool. Il n'ajoute pas d'onglet Integrations et ne remplace pas les contrôles Pool.

Le **Effective CODEX_HOME** affiché appartient au serveur OpenCodex. Avec un
tableau de bord distant, il peut s'agir d'un autre ordinateur que celui du
navigateur. **Registered active profile** désigne le propriétaire enregistré
dans le magasin chiffré des profils ; le serveur vérifie la connexion physique
avant de basculer. Une connexion modifiée hors d'OpenCodex peut ainsi produire
une erreur de propriétaire non concordant, au lieu d'être écrasée en silence.

## Enregistrer et basculer

Utilisez **Save current as profile** pour enregistrer la connexion existante de
l'application. Si la connexion active est déjà enregistrée, cette opération met
à jour son libellé ; elle n'inscrit pas un nouveau compte. Le changement de
profil exige le magasin d'identifiants par fichiers pris en charge et un
trousseau du système d'exploitation disponible. Les codes de diagnostic
expliquent pourquoi les contrôles sont indisponibles ; ne contournez pas une
erreur de trousseau ou de propriété en copiant des identifiants Pool dans le
fichier de connexion native. Le panneau est désactivé pendant la réauthentification
native existante de la carte principale.

Choisissez **Switch** à côté d'un profil enregistré inactif. Vérifiez le libellé
cible et le répertoire personnel côté serveur, arrêtez Codex natif utilisant ce
répertoire, puis cochez la confirmation d'arrêt et validez. Aucun changement
d'identifiants n'est envoyé avant confirmation. Le panneau relit le répertoire,
le propriétaire actif et l'état de récupération juste avant l'envoi. Si cet
état a changé, examinez-le et confirmez de nouveau. Le backend existant reste
la référence pour les verrous, la vérification des processus, la fin des
requêtes en cours, l'activation et le retour arrière.

Après la réussite, suivez l'indication de redémarrage affichée et rouvrez Codex
natif avec ce répertoire. Le panneau relit l'état des profils et actualise le
contrôleur de comptes existant. Il ne déclenche aucune mutation de sélection ou
de configuration Pool et ne modifie ni les clés fournisseur, ni les tâches, ni
l'historique. Le backend continue de rapprocher l'identité native `__main__`,
comme dans le parcours CLI.

## Récupération et profils précédents

Il s'agit d'opérations distinctes :

- **Recover interrupted change** rapproche une transaction backend inachevée.
  **Restore pending transaction** demande son retour arrière. Les deux exigent
  une confirmation d'arrêt distincte. Ces contrôles restent disponibles quand
  une liste de profils endommagée est illisible, mais que les diagnostics
  signalent une récupération en attente.
- **Return to previously displayed**, après un changement réussi, sélectionne
  le profil affiché avant le changement selon le parcours normal avec
  confirmation. Ce raccourci n'existe que dans la mémoire de la page, pour le
  répertoire et le propriétaire actif attendus ; il disparaît si la page est
  rechargée ou si le proxy ou le propriétaire change. L'API ne renvoie pas la
  source de la transaction : ce n'est donc pas un journal d'annulation vérifié
  par le serveur. Un autre opérateur peut avoir changé la connexion entre la
  lecture préalable et votre bascule. Après un rechargement, sélectionnez
  directement le profil enregistré souhaité.

Une erreur réseau ne prouve pas qu'une écriture a échoué ou été annulée. Après
une mutation envoyée, même si la réponse se perd, le panneau relit l'état du
serveur et ne réessaie jamais automatiquement. Si l'actualisation échoue, un
changement réussi n'est pas annoncé comme annulé. Actualisez et consultez les
diagnostics avant toute autre opération. La commande `ocx account main doctor`
fournit des diagnostics côté serveur.

## Périmètre de cette phase

Ce panneau liste, enregistre, active et récupère les profils existants via la
frontière `/api/native-main-profiles`. Il ne lance aucun processus de connexion
et n'expose aucun jeton d'écriture de préparation. L'ajout d'une autre connexion
native reste du ressort de la commande CLI `ocx account main add` ; l'inscription
depuis le navigateur est un suivi distinct de l'issue #3417. La
réauthentification de l'emplacement principal actuel suit un autre parcours,
que ce panneau ne remplace pas.

Les données des profils ne sont pas écrites dans le stockage du navigateur. Le
client ne projette que les champs publics, affiche des codes d'erreur autorisés
plutôt que les messages bruts du serveur et utilise le mécanisme de requêtes
authentifiées existant de l'application. L'authentification de gestion, les
contrôles de session GUI/CSRF et l'admission des routes du backend restent inchangés.
