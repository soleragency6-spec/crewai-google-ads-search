# Deux agents CrewAI pour Google Ads Search

`main.py` contient toute la logique : API FastAPI, deux agents utilisant l'API OpenAI avec `gpt-4o`, contrats Pydantic, validation métier et sérialisation JSON. Aucun YAML ni accès direct à Google Ads n'est nécessaire. Les agents ne disposent d'aucun outil de modification du compte.

## Pilotage par exception et email Resend

Le serveur reste silencieux côté humain lorsque tout est nominal : HTTP 200 avec `silent=true`, `summary=""`, aucune analyse rédigée ni email, et les ordres automatiques autorisés. La réponse JSON reste nécessaire au Google Ads Script : c'est lui qui applique les ordres au compte. FastAPI n'a pas d'accès direct en écriture à Google Ads.

En cas d'exception, le serveur répond avec `requires_attention=true`, la liste `alerts` et `notification_status`. Il envoie immédiatement l'email via l'API HTTPS Resend avant le LLM pour les anomalies connues. Les campagnes concernées sont exclues des modifications automatiques ; les autres continuent. Les propositions stratégiques de l'agent et les variations budgétaires supérieures à 10 % déclenchent aussi une alerte et restent à examiner manuellement.

### Configurer l'email dans Render

Une seule nouvelle clé est obligatoire : **`RESEND_API_KEY`**. Ajouter sa vraie valeur dans **Render → Environment**, puis enregistrer et redéployer. La clé reste exclusivement côté serveur et ne doit figurer ni dans Google Ads Scripts ni dans GitHub. Le fichier `.env.example` documente les variables sans clé réelle.

Expéditeur et destinataire par défaut : **contact@soler-agency.com**. Les variables facultatives `ALERT_EMAIL_FROM` et `ALERT_EMAIL_TO` permettent de les changer. Le domaine **soler-agency.com doit être vérifié dans Resend**, conformément à la [documentation des domaines](https://resend.com/docs/dashboard/domains/introduction). La clé seule ne remplace pas cette vérification.

L'envoi utilise uniquement la bibliothèque standard Python (`urllib.request`) vers [POST https://api.resend.com/emails](https://resend.com/docs/api-reference/emails/send-email), sans dépendance Resend supplémentaire. HTTPS fonctionne sur Render Free, contrairement aux ports SMTP 25/465/587 bloqués sur cette offre ([documentation Render](https://render.com/docs/free)).

Après configuration, appeler `POST /alerts/test` avec le même en-tête Bearer que `/optimize` pour envoyer un email de test fixe. `GET /alerts/config` (authentifié) liste les variables manquantes sans retourner de secret. `GET /alerts/recent` (authentifié) expose les 100 dernières exceptions du journal local.

Une clé absente donne `notification_status="unconfigured"`. Un refus Resend, domaine non vérifié, timeout ou autre échec donne `"failed"` : aucun de ces cas n'est annoncé comme un email envoyé. Le Script s'arrête alors avant d'appliquer des ordres. Les échecs sont retentés à la prochaine observation de la même anomalie. `"sent"` signifie que Resend a accepté le message, pas une preuve de réception en boîte de réception.

### Critères d'exception

| Exception | Règle |
|---|---|
| tCPA manquant | `platform_target_cpa_micros=null`, même si un CPA métier manuel existe. L'absence peut être volontaire : l'email demande un examen, sans changer d'enchères. |
| Objectif manquant | `target_cpa_micros=null`. La campagne est envoyée pour alerte, au lieu d'être ignorée par le Script. |
| ROAS en baisse | ROAS de la période courante comparé à la période précédente de même durée : baisse strictement **>20 %**, jamais exactement 20 %. Les périodes doivent être adjacentes. |
| Budget consommé trop vite | Après 6 h dans le fuseau du compte, dépense du jour >50 % du budget quotidien ET >1,5 fois la consommation linéaire attendue à cet instant. C'est un signal à vérifier, pas un dépassement réglementaire : Google utilise un budget quotidien moyen. |
| Stratégie majeure | `strategic_changes` de l'agent : enchères, restructuration, réallocation majeure, ou proposition budgétaire >10 %. Aucun ordre stratégique automatique. |
| Surveillance incomplète | tCPA réel, dépenses du jour, fuseau ou données ROAS absents/non comparables. Le serveur ne déclare pas une campagne nominale faute de données. |
| Suivi non fiable / analyse échouée | Déclaration de suivi non fiable ou échec de l'optimisation : alerte technique et pas d'ordre partiel. |

Si les valeurs de conversion ne sont pas pertinentes pour votre activité, définir explicitement `ROAS_MONITORING_ENABLED=false` dans le Script. Sinon, l'absence d'une base de ROAS comparable déclenche une alerte de données manquantes.

### Deux fréquences dans Google Ads

Installer la nouvelle version du Script : l'ancienne n'envoie pas les valeurs de conversion ni la dépense du jour et ignore les campagnes sans CPA. Un simple redéploiement Python ne peut pas créer ces données.

- Première copie : **`CONFIG.MODE='OPTIMIZE'`**, une fois par semaine. Les agents analysent la semaine complète arrivée à maturité et renvoient les optimisations de routine, sans rapport nominal.
- Seconde copie : **`CONFIG.MODE='MONITOR'`**, chaque heure. Elle appelle `/monitor`, sans appel OpenAI et sans modification Google Ads, pour détecter les exceptions à chaque réception. Le ROAS porte sur 7 jours glissants arrivés à maturité ; la dépense budgétaire est celle du jour courant.

Le délai de conversion reste `CONVERSION_LAG_DAYS=7` par défaut pour les deux copies. Les alertes ROAS reflètent donc les périodes mûries, pas le ROAS intrajournalier non attribué. Le contrôle du budget du jour est effectué à chaque passage. « Immédiat » signifie dès réception des données : avec une planification horaire, le délai comprend jusqu'à une heure, la latence des statistiques Google et le réveil éventuel de Render Free. Sans appel du Script, le serveur ne surveille pas le compte.

Les deux copies doivent utiliser le même compte Google et le même propriétaire Drive pour partager le journal. Une exception de même type/compte/campagne est notifiée au plus une fois sur 24 h dans le fonctionnement normal. La déduplication locale utilise SQLite ; le Script conserve également les accusés d'envoi dans son journal Drive et les transmet au serveur, car [Render Free perd les fichiers locaux au redémarrage](https://render.com/docs/free). Une réponse perdue après acceptation email ou un lancement concurrent peut encore produire un doublon : éviter de lancer plusieurs copies du même mode en parallèle. Aucun email de « tout va bien » ou de résolution n'est envoyé.

Le mode Aperçu ne modifie pas Google Ads ni le journal Drive. Les appels HTTP externes sont réels : une exception détectée peut donc envoyer un email de test métier même en Aperçu.

### Validation locale

```bash
pip install -r requirements-dev.txt
pytest tests/ -q
```

Les tests du dépôt couvrent le silence nominal, les seuils ROAS, le budget du jour, le tCPA absent, les décisions majeures bloquées, les erreurs Resend et la déduplication après perte du journal Render. Les tests utilisent des transports simulés et n'envoient aucun email réel.

## Google Ads Script hebdomadaire — API 1.1

Le fichier [`google_ads_script.js`](google_ads_script.js) est le Script complet à coller dans un compte Google Ads individuel. Le token est volontairement remplacé par un emplacement dans cette version publique : renseigner `CONFIG.WEBHOOK_TOKEN` dans la copie privée de l'éditeur Google Ads uniquement.

1. Dans Google Ads, ouvrir **Outils → Actions groupées → Scripts**, créer un Script et coller le contenu du fichier.
2. Vérifier `CONFIG.DEFAULT_TARGET_CPA` ou `TARGET_CPA_BY_CAMPAIGN_ID`, exprimés dans la devise du compte. Sans valeur métier explicite, le Script utilise le tCPA de la campagne ; si aucun CPA n'est disponible, il transmet la campagne avec un objectif nul pour déclencher une alerte.
3. Confirmer que les conversions primaires correspondent à l'objectif métier (`CONVERSION_TRACKING_CONFIRMED`). Le Script ne peut pas diagnostiquer à lui seul la fiabilité du suivi.
4. Autoriser les accès demandés. Lancer **Aperçu** : l'appel au serveur OpenAI est réel et peut être facturé, mais les ordres ne modifient ni Google Ads ni le journal Drive.
5. Pour appliquer, définir `DRY_RUN=false` dans Render et conserver `CONFIG.DRY_RUN=false` dans le Script. Le drapeau serveur et le mode Aperçu restent prioritaires. Les alertes par email sont indépendantes de DRY_RUN.
6. Planifier **une seule instance du Script par compte**, une fois par semaine. Ne pas lancer simultanément plusieurs copies : le journal Drive ne constitue pas un verrou transactionnel.

La période est la dernière semaine complète lundi–dimanche dont tous les jours respectent `CONVERSION_LAG_DAYS` (7 par défaut). Exemple : une exécution le 20 octobre 2026 analyse le 5–11 octobre, afin de laisser mûrir les conversions. Les dates sont journalisées dans le fuseau horaire du compte. Ce choix évite de confondre conversions retardées et gaspillage.

Les performances viennent de `campaign`, `keyword_view` et `search_term_view` via [AdsApp.search et GAQL](https://developers.google.com/google-ads/scripts/docs/concepts/reports). Les limites sont de 50 campagnes et 500 mots-clés dépensiers par lot ; au-delà, le Script s'arrête avant toute modification et demande de réduire `CAMPAIGN_IDS`. Les 300 termes de recherche visibles les plus dépensiers sont envoyés. Certains termes restent masqués par Google : l'analyse de termes n'est pas exhaustive.

Le serveur choisit les négatifs uniquement parmi les termes observés à zéro conversion, au moins 30 clics et au moins deux CPA cibles dépensés. Il renvoie `ADD_AD_GROUP_NEGATIVE_KEYWORD`, avec le texte exact et `match_type=EXACT`. Le Script appelle [`adGroup.createNegativeKeyword('[texte]')`](https://developers.google.com/google-ads/scripts/docs/reference/adsapp/adsapp_adgroup) après avoir vérifié le groupe, les métriques source, les doublons et l'absence de conflit textuel avec un mot-clé positif actif. Il applique au maximum 20 nouveaux négatifs par exécution. Aucun négatif large, expression ou au niveau campagne n'est généré.

Le Script boucle également sur `SET_CAMPAIGN_DAILY_BUDGET`. Les budgets partagés sont exclus ; les optimisations automatiques restent limitées à ±10 %. Les propositions plus importantes sont réservées à une alerte stratégique. Par défaut, le plafond du lot est la somme des budgets actuels : les hausses doivent donc être financées par des baisses, appliquées en premier. `MAX_TOTAL_DAILY_BUDGET` peut fixer un autre plafond dans la devise du compte. Une hausse nécessite aussi `BUDGET_STABILITY_CONFIRMED=true`, à renseigner seulement après vérification de la stabilité des budgets sur la période. Une valeur `false` autorise l'analyse, les négatifs et les baisses, mais bloque les hausses.

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
  "period_start": "2026-10-07",
  "period_end": "2026-10-13",
  "reference_period_start": "2026-09-30",
  "reference_period_end": "2026-10-06",
  "account_timezone": "Europe/Paris",
  "today_spend_date": "2026-10-20",
  "roas_monitoring_enabled": true,
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
      "platform_target_cpa_micros": 30000000,
      "cost_micros": 500000000,
      "conversions": 10,
      "conversion_value_micros": 1000000000,
      "previous_cost_micros": 500000000,
      "previous_conversion_value_micros": 1000000000,
      "today_cost_micros": 5000000,
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

Le délai de conversion est choisi selon votre cycle réel. Le serveur exige au moins 7 jours et exclut les derniers jours indiqués par `conversion_lag_days`. Le snapshot doit dater de moins de 24 heures pour `/optimize`, ou de moins de 15 minutes pour `/monitor`. Déclarer honnêtement `conversion_tracking_ok` : une valeur fausse déclenche une alerte et bloque la campagne. `budget_unchanged_during_period` est une déclaration métier vérifiée : s'il est faux, aucune hausse n'est permise. Le budget historique stable permet de calculer le taux d'utilisation budgétaire.

Cette version traite les campagnes Search activées avec un budget quotidien individuel. Les campagnes avec budget partagé ou total sont rejetées. `max_total_daily_budget_micros` est le plafond de la **somme des budgets quotidiens du lot envoyé** ; il ne représente pas un plafond de facturation Google Ads, ni celui du compte entier si des campagnes sont absentes.

## Décisions et ordres

L'analyste identifie tous les mots-clés qui cumulent zéro conversion, au moins 30 clics et un coût d'au moins deux CPA cibles. Python vérifie sa liste exacte.

Le strategist décide librement de conserver le budget ou propose une variation entière comprise entre -10 % et +10 % pour les ordres automatiques (au-delà, alerte stratégique), dans ces limites déterministes :

- Baisse : les mots-clés signalés représentent au moins 30 % du coût campagne, et la campagne n'a aucune conversion ou son CPA dépasse la cible.
- Hausse : budget stable sur la période, au moins 5 conversions, CPA inférieur ou égal à la cible, au moins 10 % d'impressions perdues pour cause de budget et utilisation d'au moins 80 % du budget quotidien multiplié par le nombre de jours.
- Le total de tous les budgets du lot, campagnes inchangées incluses, doit respecter le plafond transmis.

Ces seuils sont des choix de départ configurés dans le code ; ils ne constituent pas un test statistique de rentabilité. Un mot-clé signalé peut rester actif. Les nouvelles exclusions concernent les termes observés et sont appliquées au groupe source, uniquement en correspondance exacte.

Extrait d'un ordre de routine possible pour le cas ci-dessus, si le strategist choisit -10 % :

```json
{
  "action": "SET_CAMPAIGN_DAILY_BUDGET",
  "campaign_id": "111",
  "budget_id": "222",
  "expected_current_budget_micros": 100000000,
  "new_daily_budget_micros": 90000000,
  "reason": "40 % du coût vient de mots-clés signalés ; le CPA campagne dépasse la cible."
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

Conserver durablement les `order_id` exécutés et limiter les modifications à une par campagne et par jour dans votre Script. Réutiliser le même `request_id` lors d'une reprise, puis exécuter les baisses avant les hausses. La mise à jour de plusieurs budgets n'est pas transactionnelle : vérifier le plafond sur les budgets réels avant chaque hausse. Le serveur ne stocke pas les requêtes ; il ne garantit pas une réponse identique sur nouvelle génération ni la déduplication. Une limite de ±10 % s'applique aux optimisations automatiques ; le journal limite également les répétitions.

Le traitement HTTP est synchrone. Configurer le délai de l'hébergeur pour couvrir les deux tâches et leurs éventuelles reprises ; tester la latence réelle avec vos lots. Une erreur d'authentification renvoie 401, une entrée invalide 422, un échec d'analyse/validation 502 sans ordre partiel. Les données envoyées aux agents sont transmises à OpenAI via CrewAI.

## Références vérifiées

Les tests de régression incluent CrewAI réel avec LLM simulés, les reprises de validation et le contrat du payload JavaScript. Les appels OpenAI réels, l'exécution dans Google Ads et l'envoi Resend réel nécessitent les clés de production et n'ont pas été exécutés pendant les tests locaux. Commencer par le test d'email puis Aperçu dans Google Ads.

- [CrewAI : sorties structurées des tâches](https://docs.crewai.com/en/concepts/tasks)
- [CrewAI : intégration native des LLM](https://docs.crewai.com/en/concepts/llms)
- [OpenAI : modèle GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o)
- [Google Ads Scripts : budgets et setAmount](https://developers.google.com/google-ads/scripts/docs/reference/adsapp/adsapp_budget)
