# Deux agents CrewAI pour Google Ads Search

`main.py` contient toute la logique : API FastAPI, deux agents utilisant l'API OpenAI avec `gpt-4o`, contrats Pydantic, validation métier et sérialisation JSON. Aucun YAML ni accès direct à Google Ads n'est nécessaire. Les agents ne disposent d'aucun outil de modification du compte.

## Google Ads Script hebdomadaire — API 1.1

Le fichier [`google_ads_script.js`](google_ads_script.js) est le Script complet à coller dans un compte Google Ads individuel. Le token est volontairement remplacé par un emplacement dans cette version publique : renseigner `CONFIG.WEBHOOK_TOKEN` dans la copie privée de l'éditeur Google Ads uniquement.

1. Dans Google Ads, ouvrir **Outils → Actions groupées → Scripts**, créer un Script et coller le contenu du fichier.
2. Vérifier `CONFIG.DEFAULT_TARGET_CPA` ou `TARGET_CPA_BY_CAMPAIGN_ID`, exprimés dans la devise du compte. Sans valeur métier explicite, le Script utilise le tCPA de la campagne ; si aucun CPA n'est disponible, il ignore la campagne et l'indique dans les journaux.
3. Confirmer que les conversions primaires correspondent à l'objectif métier (`CONVERSION_TRACKING_CONFIRMED`). Le Script ne peut pas diagnostiquer à lui seul la fiabilité du suivi.
4. Autoriser les accès demandés. Lancer **Aperçu** : l'appel au serveur OpenAI est réel et peut être facturé, mais les ordres ne modifient ni Google Ads ni le journal Drive.
5. Pour appliquer, définir `DRY_RUN=false` dans Render et conserver `CONFIG.DRY_RUN=false` dans le Script. Le drapeau serveur et le mode Aperçu restent prioritaires.
6. Planifier **une seule instance du Script par compte**, une fois par semaine. Ne pas lancer simultanément plusieurs copies : le journal Drive ne constitue pas un verrou transactionnel.

La période est la dernière semaine complète lundi–dimanche dont tous les jours respectent `CONVERSION_LAG_DAYS` (7 par défaut). Exemple : une exécution le 20 octobre 2026 analyse le 5–11 octobre, afin de laisser mûrir les conversions. Les dates sont journalisées dans le fuseau horaire du compte. Ce choix évite de confondre conversions retardées et gaspillage.

Les performances viennent de `campaign`, `keyword_view` et `search_term_view` via [AdsApp.search et GAQL](https://developers.google.com/google-ads/scripts/docs/concepts/reports). Les limites sont de 50 campagnes et 500 mots-clés dépensiers par lot ; au-delà, le Script s'arrête avant toute modification et demande de réduire `CAMPAIGN_IDS`. Les 300 termes de recherche visibles les plus dépensiers sont envoyés. Certains termes restent masqués par Google : l'analyse de termes n'est pas exhaustive.

Le serveur choisit les négatifs uniquement parmi les termes observés à zéro conversion, au moins 30 clics et au moins deux CPA cibles dépensés. Il renvoie `ADD_AD_GROUP_NEGATIVE_KEYWORD`, avec le texte exact et `match_type=EXACT`. Le Script appelle [`adGroup.createNegativeKeyword('[texte]')`](https://developers.google.com/google-ads/scripts/docs/reference/adsapp/adsapp_adgroup) après avoir vérifié le groupe, les métriques source, les doublons et l'absence de conflit textuel avec un mot-clé positif actif. Il applique au maximum 20 nouveaux négatifs par exécution. Aucun négatif large, expression ou au niveau campagne n'est généré.

Le Script boucle également sur `SET_CAMPAIGN_DAILY_BUDGET`. Les budgets partagés sont exclus ; les variations restent limitées à ±20 %. Par défaut, le plafond du lot est la somme des budgets actuels : les hausses doivent donc être financées par des baisses, appliquées en premier. `MAX_TOTAL_DAILY_BUDGET` peut fixer un autre plafond dans la devise du compte. Une hausse nécessite aussi `BUDGET_STABILITY_CONFIRMED=true`, à renseigner seulement après vérification de la stabilité des budgets sur la période. Une valeur `false` autorise l'analyse, les négatifs et les baisses, mais bloque les hausses.

Un fichier JSON `CrewAI_Search_State_<compte>.json` est conservé dans votre Drive via [DriveApp](https://developers.google.com/google-ads/scripts/docs/examples/driveapp). Il contient les périodes terminées, identifiants de requêtes/ordres et dates de modification des budgets, sans token. Un budget est réservé dans le journal avant mutation : après un échec ambigu, vérifier manuellement l'état avant de supprimer une réservation. La même période terminée n'est pas réappliquée.

Le Script vérifie `/capabilities` avant l'extraction. Il s'arrête avec une erreur explicite si la version 1.1 n'est pas déployée ; il ne tente pas d'envoyer des données sur sept jours à l'ancienne version.

## Déployer sur Render depuis GitHub

1. Dans [Render](https://dashboard.render.com/), choisir **New → Web Service**.
2. Connecter GitHub et sélectionner le dépôt `soleragency6-spec/crewai-google-ads-search` (ou utiliser son URL publique).
3. Sélectionner la branche `main`, laisser le répertoire racine vide et choisir le langage **Docker**. Le Dockerfile se trouve à la racine (`./Dockerfile`).
4. Ajouter les variables d'environnement `OPENAI_API_KEY`, `WEBHOOK_TOKEN` (secret aléatoire d'au moins 32 caractères) et `DRY_RUN=true`. Les valeurs des secrets doivent être définies dans Render, pas dans le dépôt GitHub.
5. Définir **Health Check Path** sur `/health`. Conserver la commande Docker par défaut : `python main.py`. Le code lit automatiquement le port fourni par Render.
6. Choisir l'instance adaptée, puis cliquer sur **Create Web Service**. La création du dépôt GitHub ne lance pas le déploiement Render.
7. Une fois le service démarré, ouvrir `https://VOTRE-SERVICE.onrender.com/health` puis `/docs`. L'URL à utiliser dans Google Ads Scripts est `https://VOTRE-SERVICE.onrender.com/optimize`.

Render construit l'image à partir du Dockerfile ; il n'y a pas de commande Build Python à saisir pour ce mode. Voir la [documentation Docker de Render](https://render.com/docs/docker) et celle des [Web Services](https://render.com/docs/web-services).

Le Dockerfile utilise Python 3.12, installe les dépendances et exécute l'application avec un utilisateur non privilégié. Sa construction locale n'a pas été exécutée : Docker n'est pas installé dans cet environnement.

## Démarrage

Python **3.12 ou 3.13**. CrewAI 1.15.28 ne prend pas en charge Python 3.14.

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY='votre-cle-openai'
export WEBHOOK_TOKEN='votre-secret-aleatoire-de-32-caracteres-minimum'
python main.py
```

`PORT` vaut 8000 par défaut. L'hébergement doit installer les dépendances et lancer `python main.py`. Utiliser une URL HTTPS publique pour le webhook. Injecter les secrets dans les variables d'environnement de l'hébergeur. Le serveur refuse de démarrer si les deux secrets obligatoires sont absents ou invalides.

- `GET /health` : disponibilité du serveur, sans appel OpenAI.
- `GET /docs` : schémas complets et interface de test.
- `POST /optimize` : données Google Ads → analyse → stratégie → ordres JSON.
- En-tête : `Authorization: Bearer <WEBHOOK_TOKEN>`.
- Corps : `Content-Type: application/json`.

`DRY_RUN=true` par défaut : les ordres sont renvoyés à des fins de simulation. Pour l'exécution, définir `DRY_RUN=false` sur le serveur ; le Script doit lui aussi respecter ce champ.

## Contrat d'entrée

Exemple structurel à envoyer depuis votre Google Ads Script ; remplacer `snapshot_at`, les dates et les identifiants par ceux de l'extraction réelle :

```json
{
  "request_id": "3898148e-186c-4c81-90eb-0dbbb330d1f5",
  "customer_id": "1234567890",
  "currency": "EUR",
  "snapshot_at": "2026-10-20T12:00:00Z",
  "period_start": "2026-09-20",
  "period_end": "2026-10-13",
  "conversion_lag_days": 7,
  "conversion_tracking_ok": true,
  "max_total_daily_budget_micros": 100000000,
  "campaigns": [
    {
      "campaign_id": "111",
      "channel_type": "SEARCH",
      "status": "ENABLED",
      "budget_id": "222",
      "budget_type": "DAILY",
      "budget_shared": false,
      "daily_budget_micros": 100000000,
      "budget_unchanged_during_period": true,
      "target_cpa_micros": 30000000,
      "cost_micros": 500000000,
      "conversions": 0,
      "search_budget_lost_impression_share": 0.15
    }
  ],
  "keywords": [
    {
      "campaign_id": "111",
      "ad_group_id": "333",
      "keyword_id": "444",
      "text": "exemple mot-clé",
      "clicks": 100,
      "cost_micros": 200000000,
      "conversions": 0
    }
  ]
}
```

Toutes les statistiques doivent concerner exactement la même période, le même compte et la même définition de conversion. Utiliser les conversions de votre objectif métier, pas un mélange avec les microconversions. Les conversions fractionnelles sont acceptées.

Les coûts et budgets utilisent des **micros de la devise du compte** : 30 EUR = 30 000 000 micros. Si vous utilisez `getBudget().getAmount()`, convertir avec `Math.round(amount * 1e6)`. Une extraction GAQL de `metrics.cost_micros` est déjà en micros. Ne pas convertir deux fois. Envoyer les identifiants sous forme de chaînes ; l'identité d'un mot-clé est le triplet campagne/groupe/mot-clé.

Fournir les totaux complets des campagnes, même si le lot de mots-clés est partiel. Chaque ligne de mot-clé doit être agrégée sur la période, sans segmentation journalière ni doublon. Les mots-clés absents du lot ne seront pas analysés. Pour une couverture complète, fractionner les campagnes en lots contenant tous leurs mots-clés : maximum 50 campagnes et 500 mots-clés par requête. Pour une campagne dépassant 500 mots-clés, adapter explicitement les limites et le traitement par lots avant usage.

`target_cpa_micros` est le CPA cible **métier** de la campagne, y compris si elle utilise des enchères manuelles. `search_budget_lost_impression_share` est une fraction entre 0 et 1, ou `null` si indisponible ; ne pas remplacer une valeur absente par zéro.

Le délai de conversion est choisi selon votre cycle réel. Le serveur exige au moins 7 jours et exclut les derniers jours indiqués par `conversion_lag_days`. Le snapshot doit dater de moins de 24 heures. `conversion_tracking_ok=true` est une précondition à vérifier avant envoi. `budget_unchanged_during_period` est une déclaration métier vérifiée : s'il est faux, aucune hausse n'est permise. Le budget historique stable permet de calculer le taux d'utilisation budgétaire.

Cette version traite les campagnes Search activées avec un budget quotidien individuel. Les campagnes avec budget partagé ou total sont rejetées. `max_total_daily_budget_micros` est le plafond de la **somme des budgets quotidiens du lot envoyé** ; il ne représente pas un plafond de facturation Google Ads, ni celui du compte entier si des campagnes sont absentes.

## Décisions et ordres

L'analyste identifie tous les mots-clés qui cumulent zéro conversion, au moins 30 clics et un coût d'au moins deux CPA cibles. Python vérifie sa liste exacte.

Le strategist décide librement de conserver le budget ou propose une variation entière comprise entre -20 % et +20 %, dans ces limites déterministes :

- Baisse : les mots-clés signalés représentent au moins 30 % du coût campagne, et la campagne n'a aucune conversion ou son CPA dépasse la cible.
- Hausse : budget stable sur la période, au moins 5 conversions, CPA inférieur ou égal à la cible, au moins 10 % d'impressions perdues pour cause de budget et utilisation d'au moins 80 % du budget quotidien multiplié par le nombre de jours.
- Le total de tous les budgets du lot, campagnes inchangées incluses, doit respecter le plafond transmis.

Ces seuils sont des choix de départ configurés dans le code ; ils ne constituent pas un test statistique de rentabilité. Un mot-clé signalé peut rester actif. Les nouvelles exclusions concernent les termes observés et sont appliquées au groupe source, uniquement en correspondance exacte.

Extrait d'un ordre possible pour le cas ci-dessus, si le strategist choisit -20 % :

```json
{
  "action": "SET_CAMPAIGN_DAILY_BUDGET",
  "campaign_id": "111",
  "budget_id": "222",
  "expected_current_budget_micros": 100000000,
  "new_daily_budget_micros": 80000000,
  "reason": "40 % du coût vient de mots-clés signalés, sans conversion campagne."
}
```

La réponse complète inclut aussi `schema_version` (1.1), `request_id`, `customer_id`, `currency`, `dry_run`, `generated_at`, `expires_at`, `analysis`, `summary`, `orders`, et un `order_id` pour chaque ordre. `orders` peut contenir des budgets et des négatifs ; `orders: []` est un résultat normal lorsqu'aucun changement n'est justifié. `search_terms` est un champ d'entrée facultatif ; sans lui, aucun négatif ne peut être produit. Les montants finaux sont calculés par Python et arrondis à 0,01 unité de devise.

## Appel depuis Google Ads Scripts

Une fois votre objet `payload` construit selon le contrat :

```javascript
const response = UrlFetchApp.fetch('https://VOTRE-SERVICE/optimize', {
  method: 'post',
  contentType: 'application/json',
  headers: {Authorization: 'Bearer ' + WEBHOOK_TOKEN},
  payload: JSON.stringify(payload),
  muteHttpExceptions: true
});
if (response.getResponseCode() !== 200) {
  throw new Error('Analyse échouée : HTTP ' + response.getResponseCode());
}
const result = JSON.parse(response.getContentText());
Logger.log(JSON.stringify(result));
```

`WEBHOOK_TOKEN` doit être fourni par votre configuration Script, sans embarquer votre clé OpenAI. L'action `SET_CAMPAIGN_DAILY_BUDGET` est le protocole de cette API : votre Script doit la traduire en `campaign.getBudget().setAmount(new_daily_budget_micros / 1e6)`.

Avant d'appliquer les ordres, votre Script doit vérifier le compte, la devise, le `request_id`, la version de schéma, l'expiration et `dry_run`. Il doit retrouver la campagne activée et son budget quotidien individuel, vérifier le `budget_id` et comparer le budget courant à `expected_current_budget_micros`. Si le budget a changé, ignorer l'ordre et refaire une extraction.

Conserver durablement les `order_id` exécutés et limiter les modifications à une par campagne et par jour dans votre Script. Réutiliser le même `request_id` lors d'une reprise, puis exécuter les baisses avant les hausses. La mise à jour de plusieurs budgets n'est pas transactionnelle : vérifier le plafond sur les budgets réels avant chaque hausse. Le serveur ne stocke pas les requêtes ; il ne garantit pas une réponse identique sur nouvelle génération ni la déduplication. Une limite de ±20 % s'applique à chaque décision, pas à une série d'appels répétés.

Le traitement HTTP est synchrone. Configurer le délai de l'hébergeur pour couvrir les deux tâches et leurs éventuelles reprises ; tester la latence réelle avec vos lots. Une erreur d'authentification renvoie 401, une entrée invalide 422, un échec d'analyse/validation 502 sans ordre partiel. Les données envoyées aux agents sont transmises à OpenAI via CrewAI.

## Références vérifiées

Validation locale de la version 1.1 : 27 tests Python (dont l'orchestration CrewAI réelle avec des LLM simulés, les reprises de validation, l'API HTTP et le contrat du payload JavaScript) et 11 tests JavaScript avec doubles Google Ads/Drive passent. Ils couvrent les deux types d'ordres, les négatifs inventés ou conflictuels, les périodes, les budgets, l'authentification, l'expiration, la simulation et la non-répétition. Une incompatibilité d'annotations de retour dans les guardrails de la version initiale a été corrigée et vérifiée avec CrewAI 1.15.28. Les appels OpenAI réels, l'exécution dans Google Ads et la construction locale Docker n'ont pas été testés ; commencer par Aperçu avant application.

- [CrewAI : sorties structurées des tâches](https://docs.crewai.com/en/concepts/tasks)
- [CrewAI : intégration native des LLM](https://docs.crewai.com/en/concepts/llms)
- [OpenAI : modèle GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o)
- [Google Ads Scripts : budgets et setAmount](https://developers.google.com/google-ads/scripts/docs/reference/adsapp/adsapp_budget)
