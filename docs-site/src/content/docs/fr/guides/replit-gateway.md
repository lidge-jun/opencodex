---
title: Compagnon passerelle Replit
description: Associez opencodex à votre propre déploiement Replit qui relaie OpenAI Chat et Anthropic Messages via Replit AI Integrations — un flux personnalisé opt-in, pas un préréglage canonique du registre.
---

Le **compagnon passerelle Replit** est un service Bun que vous déployez dans
[`integrations/replit-gateway`](https://github.com/lidge-jun/opencodex/tree/dev/integrations/replit-gateway)
et qui s’exécute **dans votre Repl Replit**. Il lit les identifiants Replit AI Integrations depuis
l’environnement du Repl et expose deux points de terminaison natifs à opencodex :

```text
opencodex (local)
  -> HTTPS + votre clé passerelle
  -> votre déploiement Replit (integrations/replit-gateway)
  -> amont Replit AI Integrations (OpenAI Chat / Anthropic Messages)
```

opencodex ne reçoit jamais les secrets `AI_INTEGRATIONS_*`. Vous fournissez une **clé passerelle**
distincte (`REPLIT_GATEWAY_KEY`) qu’opencodex stocke localement et envoie en
`Authorization: Bearer …` sur chaque requête.

> **Flux personnalisé uniquement.** `replit` et `replit-anthropic` ne sont **pas** des préréglages
> canoniques du registre. opencodex ne revendique pas un fournisseur Replit officiel, et la
> promotion dans le registre reste bloquée tant qu’une autorisation écrite de Replit n’existe pas
> (voir [Porte d’évidence](#porte-dévidence) ci-dessous).

> **Expérimental — déploiement non vérifié.** Le code et le contrat v1 existent (`experimental-pending-canary`), mais le **déploiement Replit réel n’est pas vérifié** face au contrat d’injection Replit. Traitez ce compagnon comme expérimental jusqu’à canari Repl jetable et confirmation officielle ou runtime.

## Prérequis

- Un **forfait Replit payant** avec [Replit AI Integrations](https://docs.replit.com/features/integrations/replit-ai-integrations)
  disponible pour votre compte ou organisation.
- Une **approbation manuelle** lorsque Replit Agent demande d’attacher les intégrations gérées OpenAI
  et Anthropic à votre Repl. opencodex n’automatise ni la connexion Replit, ni la facturation, ni les
  dialogues d’intégration.
- Le paquet passerelle déployé et accessible sur une origine **HTTPS** publique (en général
  `https://<repl>.replit.app`).
- Un proxy opencodex actif (`ocx start`) pour l’assistant du tableau de bord ou l’installation CLI.

Déployez et configurez la passerelle avec le
[`README du paquet`](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md).

## Déployer la passerelle (résumé)

1. Copiez `integrations/replit-gateway/` dans un Repl Bun (ou exécutez-le depuis un clone).
2. Ajoutez `server.ts` qui appelle `loadGatewayConfigFromEnv()` et `createGatewayServer()`, puis
   `Bun.serve({ fetch: gateway.fetch, port, hostname: "0.0.0.0" })`.
3. Approuvez les intégrations gérées **OpenAI** et **Anthropic** dans l’interface Replit.
4. **Confirmez les noms `AI_INTEGRATIONS_*` observés** (convention non vérifiée) sans afficher les valeurs — voir ci-dessous.
5. Définissez les secrets : `REPLIT_GATEWAY_KEY` (**32–512** caractères ASCII imprimables), `REPLIT_GATEWAY_PUBLIC_ORIGIN`, listes de modèles, et les quatre variables d’intégration à noms exacts.
6. Vérifiez que `GET /healthz` et `GET /v1/models` authentifié réussissent.

### Noms d’environnement Replit (convention observée non vérifiée)

Noms exacts requis : `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`. Convention **observée**, non publiée comme contrat hors plateforme par Replit. **Support Replit réel en attente de canari.**

Inspecter les noms sans exposer les valeurs :

```bash
printenv | grep '^AI_INTEGRATIONS_' | cut -d= -f1 | sort -u
```

Générez une clé **32–512** caractères ASCII imprimables :

```bash
openssl rand -base64 48 | tr -d '\n'
```

Stockez-la uniquement dans les secrets Replit et lors de l’appairage opencodex — jamais dans git.

## Associer opencodex

L’installation écrit **deux** fournisseurs personnalisés dérivés de l’origine de déploiement :

| Id fournisseur | Adaptateur | URL de base | Notes |
| --- | --- | --- | --- |
| `replit` | `openai-chat` | `<origin>/v1` | Découverte via `GET /v1/models` |
| `replit-anthropic` | `anthropic` | `<origin>` | Transport bearer ; `liveModels: false` |

Les deux partagent la même clé passerelle. Les champs non dérivés que vous aviez déjà définis
(sélection de modèles, pacing, en-têtes personnalisés hors identifiants) sont conservés lors d’un
remplacement de paire.

### CLI — `ocx provider install-replit`

```bash
export REPLIT_GATEWAY_KEY='votre-clé-passerelle'
ocx provider install-replit --origin https://mon-app.replit.app
```

Sources de la clé (une seule) : variable `REPLIT_GATEWAY_KEY`, `--stdin`, ou
`--gateway-key-file <chemin>`. La clé **ne doit pas** figurer sur la ligne de commande.

Drapeaux utiles : `--allow-custom-domain`, `--replace`, `--set-default`, `--json`.

Avant toute écriture de configuration, opencodex sonde uniquement des points **non facturables** :
`GET <origin>/healthz` et `GET <origin>/v1/models` (clé bearer).

### Assistant du tableau de bord

Sur **Fournisseurs**, cliquez sur **Replit gateway…** :

1. Saisissez l’**origine HTTPS** et la **clé passerelle**.
2. Activez éventuellement **Autoriser le domaine personnalisé** si l’hôte n’est pas `.replit.app`.
3. Définissez éventuellement **replit** comme fournisseur par défaut.
4. En cas de succès, l’assistant affiche les durées des sondes health et models.

Si la paire existe déjà, une confirmation explicite est demandée avant **Remplacer la paire**.
L’assistant rappelle qu’il ne s’agit **pas** d’un préréglage canonique.

## Opt-in domaine personnalisé

Par défaut, seules les origines HTTPS se terminant par `.replit.app` sont acceptées. L’opt-in **ne prouve pas** la propriété du nom d’hôte et **n’élimine pas** la responsabilité DNS/rebinding/TLS après installation. opencodex **applique** la syntaxe HTTPS, une évaluation destination/DNS avant installation et des sondes HTTPS — contrôles **ponctuels**, pas une garantie de contrôle continu.

## Démarrages à froid

Les déploiements Replit peuvent s’endormir. La première requête après inactivité peut être lente ou
renvoyer `upstream_error` / `upstream_timeout`. Les sondes d’installation ont un délai de 8 s ;
réessayez lorsque le déploiement est réveillé. Aucune nouvelle tentative facturable automatique.

## Limites de la passerelle (contrat v1)

| Limite | Défaut |
| --- | --- |
| Corps de requête max | 32 Mio |
| En-têtes max | 32 Kio |
| Requêtes concurrentes max | 10 |
| Délai amont | 300 s |
| Délai client | 310 s |

Les redirections HTTP amont sont rejetées. Plages autorisées des surcharges : voir le README du paquet (`1024`–`64 MiB` corps, `1`–`100` concurrence, etc.).

## Catégories d'erreur

La passerelle renvoie des catégories d'erreur JSON stables (sans jamais renvoyer de secrets ni de corps de requête) :

`auth_failed`, `config_invalid`, `request_too_large`, `headers_too_large`,
`unsupported_content_encoding`, `model_not_allowed`, `concurrency_limited`, `upstream_timeout`,
`client_timeout`, `client_aborted`, `redirect_rejected`, `upstream_error`, `internal`.

Correspondances HTTP courantes : `401` authentification, `400` modèle non autorisé, `413` corps trop volumineux, `415` corps encodé, `429` concurrence, `408` délai client, `504` délai amont, `502` échec amont/redirection.

## Capacités natives (v1)

**Pris en charge** — relais natifs en flux d’octets pour OpenAI Chat et Anthropic Messages. Pour SSE, commentaires `: heartbeat\n\n` sur **frontières de ligne complètes** uniquement.

**Politique LF retardé :** si un CRLF est coupé entre chunks et `\r` arrive sans `\n` immédiat, un heartbeat peut être injecté après traitement de `\r` comme fin de ligne si `\n` tarde au-delà de l’intervalle. **Les octets de charge utile ne sont pas modifiés** ; le **timing** des fins de ligne peut différer dans de rares cas CRLF scindés. Ne pas supposer une équivalence temporelle SSE totale.

## Non pris en charge en v1

- Préréglage canonique ou tuile du sélecteur Replit
- Google Gemini, OpenRouter ou autres intégrations via cette passerelle
- OpenAI Responses, image, audio ou transcription
- Traduction de protocole OpenAI ↔ Anthropic
- Nouvelles tentatives amont automatiques, cache ou normalisation
- CORS navigateur vers la passerelle
- `Content-Encoding` autre qu’identité
- Découverte live sur `replit-anthropic`
- Automatisation des actions de compte ou d’approbation Replit

## Confidentialité, crédits et conditions

- **Frontière des identifiants :** seule la clé passerelle est stockée dans `~/.opencodex/config.json`.
- **Facturation :** crédits Replit aux tarifs API publics.
- **Conditions :** **conditions Replit applicables** à votre forfait. [CGU Replit](https://replit.com/terms-of-service) (**Replit, Inc.**) ; les ToS indiquent que **Pro et Enterprise** relèvent du [Commercial Agreement](https://replit.com/commercial-agreement). **Autorisation de routage hors plateforme non établie.**
- **Journaux :** métadonnées uniquement.

## Porte d’évidence

opencodex ne maintient des préréglages fournisseur qu’avec des preuves de source primaire
([Contribuer — Preuves requises](/contributing/#evidence-required-for-a-canonical-preset)).
Le compagnon Replit **n’atteint pas** ce niveau aujourd’hui.

| Élément | Statut (vérifié le 2026-08-22) |
| --- | --- |
| Points OpenAI Chat + Anthropic Messages pour clients **hors plateforme** | **Non établi.** |
| Noms `AI_INTEGRATIONS_*` | **Convention observée non vérifiée** ; canari Repl en attente. |
| CGU et entité juridique | [CGU Replit](https://replit.com/terms-of-service) — **Replit, Inc.** ; Pro/Enterprise : [Commercial Agreement](https://replit.com/commercial-agreement). |
| Autorisation routage hors plateforme | **Non obtenue.** |
| Responsable maintenance | **opencodex :** [@lidge-jun](https://github.com/lidge-jun), [@Ingwannu](https://github.com/Ingwannu). **Replit :** non partenaire. |
| Date de vérification | **2026-08-22** |

**Promotion registre bloquée.** `replit` / `replit-anthropic` restent absents de
`src/providers/registry.ts` tant que l’autorisation écrite et les preuves complètes n’existent pas.

## Voir aussi

- README du paquet : [`integrations/replit-gateway/README.md`](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)
- Spécification : [`2026-08-22-replit-gateway-design.md`](https://github.com/lidge-jun/opencodex/blob/dev/docs/superpowers/specs/2026-08-22-replit-gateway-design.md)
- [Fournisseurs](/guides/providers/)
- [Tableau de bord web](/guides/web-dashboard/)
