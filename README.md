# Deux agents CrewAI pour Google Ads Search

`main.py` contient toute la logique : API FastAPI, deux agents utilisant l'API OpenAI avec `gpt-4o`, contrats Pydantic, validation métier et sérialisation JSON. Aucun YAML ni accès direct à Google Ads n'est nécessaire. Les agents ne disposent d'aucun outil de modification du compte.

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

Le délai de conversion est choisi selon votre cycle réel. Le serveur exige au moins 14 jours et exclut les derniers jours indiqués par `conversion_lag_days`. Le snapshot doit dater de moins de 24 heures. Les champs `conversion_tracking_ok` et `budget_unchanged_during_period` sont des préconditions à vérifier avant envoi, pas des valeurs à renseigner aveuglément. Le budget historique stable permet de calculer le taux d'utilisation budgétaire.

Cette version traite les campagnes Search activées avec un budget quotidien individuel. Les campagnes avec budget partagé ou total sont rejetées. `max_total_daily_budget_micros` est le plafond de la **somme des budgets quotidiens du lot envoyé** ; il ne représente pas un plafond de facturation Google Ads, ni celui du compte entier si des campagnes sont absentes.

## Décisions et ordres

L'analyste identifie tous les mots-clés qui cumulent zéro conversion, au moins 30 clics et un coût d'au moins deux CPA cibles. Python vérifie sa liste exacte.

Le strategist décide librement de conserver le budget ou propose une variation entière comprise entre -20 % et +20 %, dans ces limites déterministes :

- Baisse : les mots-clés signalés représentent au moins 30 % du coût campagne, et la campagne n'a aucune conversion ou son CPA dépasse la cible.
- Hausse : au moins 5 conversions, CPA inférieur ou égal à la cible, au moins 10 % d'impressions perdues pour cause de budget et utilisation d'au moins 80 % du budget quotidien multiplié par le nombre de jours.
- Le total de tous les budgets du lot, campagnes inchangées incluses, doit respecter le plafond transmis.

Ces seuils sont des choix de départ configurés dans le code ; ils ne constituent pas un test statistique de rentabilité. Un mot-clé signalé peut rester actif. Cette version ajuste uniquement les budgets campagne.

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

La réponse complète inclut aussi `schema_version`, `request_id`, `customer_id`, `currency`, `dry_run`, `generated_at`, `expires_at`, `analysis`, `summary`, `orders`, et un `order_id` pour chaque ordre. `orders: []` est un résultat normal lorsqu'aucun changement n'est justifié. Les montants finaux sont calculés par Python et arrondis à 0,01 unité de devise.

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

Validation locale : 15 tests passent sur les schémas, seuils, calculs, plafond, authentification HTTP et erreurs, avec le runtime CrewAI remplacé pour les tests. Les paramètres utilisés ont aussi été contrôlés dans le code source de CrewAI 1.15.28. L'installation complète des dépendances a échoué faute d'espace disque : l'orchestration CrewAI réelle et les appels OpenAI n'ont pas été exécutés. Il faut donc effectuer un essai en simulation sur l'hébergement avant d'activer l'application des ordres.

- [CrewAI : sorties structurées des tâches](https://docs.crewai.com/en/concepts/tasks)
- [CrewAI : intégration native des LLM](https://docs.crewai.com/en/concepts/llms)
- [OpenAI : modèle GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o)
- [Google Ads Scripts : budgets et setAmount](https://developers.google.com/google-ads/scripts/docs/reference/adsapp/adsapp_budget)
