/**
 * Google Ads Scripts, compte individuel, moteur JavaScript V8.
 * Planifier une seule instance par compte et par mode.
 * Version publique : renseigner le token dans votre copie privée uniquement.
 * Nécessite l'API /capabilities schema_version=1.1.
 */
const CONFIG = {
  BASE_URL: 'https://mon-expert-google-ads.onrender.com',
  WEBHOOK_TOKEN: 'COLLER_VOTRE_TOKEN_ICI', // Token brut ; le Script ajoute Bearer.
  ALERT_EMAIL: 'soleragency6@gmail.com',
  MODE: 'MONITOR', // OPTIMIZE : chaque semaine ; MONITOR : copie séparée chaque heure.
  ROAS_MONITORING_ENABLED: true, // false seulement si les valeurs de conversion ne sont pas applicables.
  DRY_RUN: false, // Le mode Aperçu et dry_run du serveur sont aussi respectés.
  CONVERSION_LAG_DAYS: 7,
  CONVERSION_TRACKING_CONFIRMED: true, // À confirmer pour vos conversions métier.
  CAMPAIGN_IDS: [], // [] = toutes les campagnes Search classiques activées.
  DEFAULT_TARGET_CPA: null, // Devise du compte : à renseigner si pas de tCPA.
  TARGET_CPA_BY_CAMPAIGN_ID: {}, // Exemple : {'123456789': 30}.
  BUDGET_STABILITY_CONFIRMED: false, // true seulement si stable sur la période.
  MAX_TOTAL_DAILY_BUDGET: null, // null = somme actuelle des budgets sélectionnés.
  MAX_NEGATIVES_PER_RUN: 20,
  ZERO_IMPRESSIONS_BASELINE: 100, // Impressions cumulées des 7 jours précédant hier.
  MAX_CHANGE_PCT: 10
};

function main() {
  authorizationHeaders_(); // Valider la configuration sans journaliser le secret.
  if (!['OPTIMIZE', 'MONITOR'].includes(CONFIG.MODE)) throw new Error('MODE invalide.');
  requireCapabilities_();
  const account = AdsApp.currentAccount();
  const customerId = account.getCustomerId().replace(/-/g, '');
  const timeZone = account.getTimeZone();
  const period = CONFIG.MODE === 'MONITOR'
    ? monitoringPeriod_(new Date(), timeZone, CONFIG.CONVERSION_LAG_DAYS)
    : weekPeriod_(new Date(), timeZone, CONFIG.CONVERSION_LAG_DAYS);
  const periodKey = period.start + ':' + period.end;
  const preview = AdsApp.getExecutionInfo().isPreview();
  const store = readState_(customerId);
  const state = store.state;
  // L'authentification du serveur est vérifiée avant l'analyse distante.
  fetchJson_('/alerts/config', {method: 'get'});
  let localAlerts;
  try { localAlerts = collectGoogleCriticalAlerts_(timeZone); }
  catch (error) {
    sendCriticalMail_([{code: 'LOCAL_MONITORING_FAILED', severity: 'critical',
      message: 'Contrôle local Google Ads impossible : ' + String(error.message || error).slice(0, 300),
      suggested_action: 'Vérifier les autorisations et les journaux du Script.'}],
      store, state, customerId, preview);
    throw error;
  }
  sendCriticalMail_(localAlerts, store, state, customerId, preview);
  if (CONFIG.MODE === 'OPTIMIZE' && state.completedPeriods[periodKey]) {
    return;
  }
  const snapshot = collectData_(period, account, CONFIG.MODE === 'MONITOR');
  if (!snapshot.campaigns.length) {
    Logger.log('Aucune campagne Search avec budget quotidien individuel.');
    return;
  }
  snapshot.recommendations = CONFIG.MODE === 'OPTIMIZE'
    ? collectRecommendations_(snapshot.campaigns, customerId) : [];
  snapshot.request_id = CONFIG.MODE === 'MONITOR' ? Utilities.getUuid() : state.requestIds[periodKey] || Utilities.getUuid();
  snapshot.customer_id = customerId;
  snapshot.currency = account.getCurrencyCode();
  snapshot.snapshot_at = new Date().toISOString();
  snapshot.period_start = period.start;
  snapshot.period_end = period.end;
  snapshot.conversion_lag_days = CONFIG.CONVERSION_LAG_DAYS;
  snapshot.conversion_tracking_ok = CONFIG.CONVERSION_TRACKING_CONFIRMED;
  snapshot.account_timezone = timeZone;
  snapshot.today_spend_date = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  const reference = previousPeriod_(period);
  snapshot.reference_period_start = reference.start;
  snapshot.reference_period_end = reference.end;
  snapshot.roas_monitoring_enabled = CONFIG.ROAS_MONITORING_ENABLED;
  snapshot.mailapp_delivery = true;
  snapshot.alert_receipts = {};
  Object.keys(state.alertReceipts).forEach(function(key) {
    if (state.alertReceipts[key] >= Date.now() / 1000 - 86400) snapshot.alert_receipts[key] = state.alertReceipts[key];
  });
  snapshot.max_total_daily_budget_micros = CONFIG.MAX_TOTAL_DAILY_BUDGET === null
    ? snapshot.campaigns.reduce(function(sum, c) { return sum + c.daily_budget_micros; }, 0)
    : moneyToMicros_(CONFIG.MAX_TOTAL_DAILY_BUDGET);
  const body = JSON.stringify(snapshot);
  if (body.length > 100000) {
    throw new Error('Lot trop volumineux. Réduire CAMPAIGN_IDS, sans dupliquer les campagnes entre Scripts.');
  }
  if (preview) Logger.log('Analyse ' + period.start + ' → ' + period.end + ', devise ' + snapshot.currency
    + ', ' + snapshot.campaigns.length + ' campagnes, ' + snapshot.keywords.length
    + ' mots-clés, ' + snapshot.search_terms.length + ' termes de recherche.');
  let result;
  try {
    result = fetchJson_(CONFIG.MODE === 'MONITOR' ? '/monitor' : '/optimize', {
      method: 'post', contentType: 'application/json', payload: body
    });
  } catch (error) {
    sendCriticalMail_([{code: 'API_ANALYSIS_FAILED', severity: 'critical',
      message: 'Analyse serveur indisponible : ' + String(error.message || error).slice(0, 300),
      suggested_action: 'Contrôler Render et relancer le Script après correction.'}],
      store, state, customerId, preview);
    throw error;
  }
  validateResponse_(result, snapshot, CONFIG.MODE);
  sendCriticalMail_(result.alerts || [], store, state, customerId, preview);
  const receipts = result.notification_receipts || {};
  let receiptsChanged = false;
  Object.keys(receipts).forEach(function(key) {
    if (state.alertReceipts[key] !== receipts[key]) receiptsChanged = true;
    state.alertReceipts[key] = receipts[key];
  });
  if (!preview && receiptsChanged) saveState_(store, state);
  if (CONFIG.MODE === 'MONITOR') {
    if (!result.silent) Logger.log('Exception(s) détectée(s), canal Gmail MailApp.');
    return;
  }
  const simulate = preview || CONFIG.DRY_RUN || result.dry_run;
  // Valider TOUT le plan avant la première modification.
  const plan = preparePlan_(result.orders, snapshot, state, timeZone);
  const recommendationPlan = prepareRecommendationPlan_(result.recommendation_orders || [], snapshot, state);
  if (!result.silent || preview) Logger.log((simulate ? 'SIMULATION — ' : '') + result.summary);
  if (simulate) {
    plan.forEach(function(item) { Logger.log(JSON.stringify(item.order)); });
    recommendationPlan.forEach(function(item) { Logger.log(JSON.stringify(item.order)); });
    Logger.log('Aucun changement Google Ads ni écriture de journal en simulation.');
    return;
  }
  state.requestIds[periodKey] = snapshot.request_id;
  saveState_(store, state);
  // Les baisses financent les hausses ; les négatifs sont appliqués ensuite.
  plan.sort(function(a, b) { return priority_(a.order) - priority_(b.order); });
  plan.forEach(function(item) {
    if (new Date(result.expires_at).getTime() <= Date.now()) {
      throw new Error('Plan expiré pendant son application.');
    }
    const order = item.order;
    if (state.appliedOrders[order.order_id]) return;
    if (order.action === 'SET_CAMPAIGN_DAILY_BUDGET') {
      const budget = checkedBudget_(item.campaign, order);
      const today = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
      if (state.budgetChanges[order.campaign_id] === today) {
        throw new Error('Budget déjà modifié ou réservé aujourd’hui : ' + order.campaign_id);
      }
      // Recalcul sur les budgets réels, pas sur les seules intentions du plan.
      const liveTotal = snapshot.campaigns.reduce(function(sum, c) {
        return sum + moneyToMicros_(getCampaign_(c.campaign_id).getBudget().getAmount());
      }, 0);
      const old = moneyToMicros_(budget.getAmount());
      const next = order.new_daily_budget_micros;
      if (next > old && liveTotal - old + next > snapshot.max_total_daily_budget_micros) {
        throw new Error('Hausse refusée : plafond du lot dépassé sur les budgets réels.');
      }
      // Réservation AVANT mutation : un échec ambigu nécessite une vérification manuelle.
      state.budgetChanges[order.campaign_id] = today;
      state.budgetPeriods[order.campaign_id] = periodKey;
      saveState_(store, state);
      budget.setAmount(next / 1e6);
      const applied = moneyToMicros_(budget.getAmount());
      if (Math.abs(applied - next) > 10000) {
        throw new Error('Budget appliqué différent du montant demandé. Vérifier la campagne.');
      }
      Logger.log('Budget ' + order.campaign_id + ' : ' + old / 1e6 + ' → ' + next / 1e6);
    } else {
      const group = getAdGroup_(order.campaign_id, order.ad_group_id);
      assertNoPositiveConflict_(group, order.text);
      if (!hasExactNegative_(group, order.text)) {
        group.createNegativeKeyword('[' + order.text + ']');
        Logger.log('Négatif exact ajouté, groupe ' + order.ad_group_id + ' : [' + order.text + ']');
      }
    }
    state.appliedOrders[order.order_id] = Date.now();
    saveState_(store, state);
  });
  recommendationPlan.forEach(function(item) {
    if (new Date(result.expires_at).getTime() <= Date.now()) throw new Error('Plan expiré avant recommandation.');
    if (state.appliedOrders[item.order.order_id]) return;
    // Une réponse ambiguë de Google ne doit pas réappliquer la recommandation au prochain passage.
    state.appliedOrders[item.order.order_id] = Date.now();
    saveState_(store, state);
    item.recommendation.apply();
    Logger.log('Recommandation appliquée : ' + item.order.recommendation_type
      + ', campagne ' + item.order.campaign_id);
  });
  // Une campagne bloquée par exception pourra être réévaluée après correction.
  if (!result.requires_attention) state.completedPeriods[periodKey] = new Date().toISOString();
  saveState_(store, state);
  Logger.log('Période terminée. Journal Drive : ' + store.file.getUrl());
}

function requireCapabilities_() {
  let caps;
  try { caps = fetchJson_('/capabilities', {method: 'get'}); }
  catch (error) {
    throw new Error('Déployer la mise à jour API 1.1 (7 jours et négatifs) avant ce Script. ' + error.message);
  }
  if (caps.schema_version !== '1.1' || caps.min_period_days > 7 || !caps.exception_monitoring) {
    throw new Error('Serveur incompatible : version avec surveillance par exception requise.');
  }
}

function authorizationHeaders_(existingHeaders) {
  if (typeof CONFIG.WEBHOOK_TOKEN !== 'string') {
    throw new Error('Renseigner WEBHOOK_TOKEN dans cette copie privée du Script.');
  }
  // Tolérer un collage avec espaces externes ou avec un unique préfixe Bearer.
  const token = CONFIG.WEBHOOK_TOKEN.trim().replace(/^Bearer[ \t]+/i, '').trim();
  if (!token || token === 'COLLER_VOTRE_TOKEN_ICI' || /^Bearer$/i.test(token)
      || /\s/.test(token)) {
    throw new Error('WEBHOOK_TOKEN invalide : coller le token sur une seule ligne, sans espace interne.');
  }
  const headers = {};
  Object.keys(existingHeaders || {}).forEach(function(name) {
    if (name.toLowerCase() !== 'authorization') headers[name] = existingHeaders[name];
  });
  // main.py utilise HTTPBearer : aucun header X-Token ou WEBHOOK_TOKEN n'est attendu.
  headers['Authorization'] = 'Bearer ' + token;
  return headers;
}

function fetchJson_(path, options) {
  options = Object.assign({}, options || {});
  options.headers = authorizationHeaders_(options.headers);
  options.muteHttpExceptions = true;
  options.followRedirects = false;
  const response = UrlFetchApp.fetch(CONFIG.BASE_URL.replace(/\/$/, '') + path, options);
  const code = response.getResponseCode();
  if (code === 401) {
    // Ne pas recopier une réponse qui pourrait contenir un secret réfléchi.
    throw new Error('API HTTP 401 sur ' + path + ' : authentification refusée par le service ciblé. '
      + 'En-tête envoyé : Authorization: Bearer <masqué>. '
      + 'Le format attendu est appliqué ; contrôler la version du Script et le service indiqué par BASE_URL.');
  }
  if (code !== 200) {
    // Ne pas afficher les en-têtes ni la requête contenant le secret.
    throw new Error('API HTTP ' + code + ' sur ' + path + ' : '
      + response.getContentText().slice(0, 1200));
  }
  try { return JSON.parse(response.getContentText()); }
  catch (error) { throw new Error('La réponse API n’est pas un JSON valide.'); }
}

function sendCriticalMail_(alerts, store, state, customerId, preview) {
  if (!Array.isArray(alerts)) throw new Error('Liste d’alertes invalide.');
  state.gmailAlertReceipts = state.gmailAlertReceipts || {};
  const now = Date.now();
  const pending = [];
  alerts.forEach(function(alert) {
    if (!alert || typeof alert.code !== 'string') return;
    const key = String(alert.campaign_id || 'account') + ':' + alert.code;
    if (state.gmailAlertReceipts[key] && now - state.gmailAlertReceipts[key] < 86400000) return;
    pending.push({key: key, alert: alert});
  });
  if (!pending.length) return;
  if (preview) {
    Logger.log('Aperçu : ' + pending.length + ' alerte(s) Gmail à envoyer, aucun email expédié.');
    return;
  }
  const lines = ['Compte Google Ads : ' + customerId, 'Détection : ' + new Date(now).toISOString(),
    'Contrôler les problèmes ci-dessous dans Google Ads.', ''];
  pending.forEach(function(item) {
    const a = item.alert;
    lines.push('[' + String(a.severity || 'warning').toUpperCase() + '] ' + item.key);
    lines.push(String(a.message || '').slice(0, 500));
    lines.push('Action : ' + String(a.suggested_action || 'Vérifier dans Google Ads.').slice(0, 500));
    lines.push('');
  });
  MailApp.sendEmail(CONFIG.ALERT_EMAIL,
    '[Google Ads] ' + pending.length + ' alerte(s) — compte ' + customerId,
    lines.join('\n').slice(0, 15000));
  pending.forEach(function(item) { state.gmailAlertReceipts[item.key] = now; });
  saveState_(store, state);
  Logger.log(pending.length + ' alerte(s) transmises par MailApp.');
}

function collectGoogleCriticalAlerts_(timeZone) {
  const alerts = [];
  let rows = AdsApp.search('SELECT customer.id, customer.status FROM customer LIMIT 1');
  if (!rows.hasNext()) throw new Error('Statut du compte introuvable.');
  const account = rows.next().customer;
  if (account.status === 'SUSPENDED') {
    alerts.push({code: 'ACCOUNT_SUSPENDED', severity: 'critical',
      message: 'Le compte Google Ads est suspendu. La cause peut être la facturation ou une règle Google ; le Script ne peut pas la déterminer.',
      suggested_action: 'Ouvrir Google Ads > Notifications et Facturation, puis consulter le motif exact.'});
  }
  try {
    rows = AdsApp.search('SELECT billing_setup.status FROM billing_setup LIMIT 50');
    const statuses = [];
    while (rows.hasNext()) statuses.push(rows.next().billingSetup.status);
    if (statuses.includes('CANCELLED') && !statuses.includes('APPROVED')
        && !statuses.includes('APPROVED_HELD')) {
      alerts.push({code: 'BILLING_SETUP_CANCELLED', severity: 'critical',
        message: 'Aucun paramétrage de facturation approuvé trouvé ; un paramétrage est annulé. Ce signal ne prouve pas un paiement refusé.',
        suggested_action: 'Vérifier immédiatement Facturation > Paramètres et les notifications Google Ads.'});
    }
  } catch (error) {
    alerts.push({code: 'BILLING_CHECK_UNAVAILABLE', severity: 'critical',
      message: 'Le paramétrage de facturation n’a pas pu être consulté par le Script. Aucun défaut de paiement n’est confirmé.',
      suggested_action: 'Vérifier la page Facturation et les notifications du compte Google Ads.'});
  }
  let query = "SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, "
    + "campaign.primary_status_reasons FROM campaign WHERE campaign.advertising_channel_type = 'SEARCH' "
    + "AND campaign.status IN ('ENABLED', 'PAUSED')";
  if (CONFIG.CAMPAIGN_IDS.length) query += ' AND campaign.id IN ('
    + CONFIG.CAMPAIGN_IDS.map(safeIdNumber_).join(',') + ')';
  rows = AdsApp.search(query + ' LIMIT 501');
  const enabled = {}, names = {};
  let count = 0;
  while (rows.hasNext()) {
    if (++count > 500) throw new Error('Plus de 500 campagnes Search à surveiller ; renseigner CAMPAIGN_IDS.');
    const c = rows.next().campaign;
    const id = String(c.id), name = String(c.name || id);
    names[id] = name;
    if (c.status === 'PAUSED') {
      alerts.push({code: 'CAMPAIGN_PAUSED', campaign_id: id, severity: 'critical',
        message: 'Campagne Search en pause : ' + name,
        suggested_action: 'Vérifier si la mise en pause est volontaire.'});
      continue;
    }
    enabled[id] = true;
    const reasons = Array.isArray(c.primaryStatusReasons) ? c.primaryStatusReasons : [];
    if (reasons.includes('HAS_ADS_DISAPPROVED')
        || ['NOT_ELIGIBLE', 'PAUSED'].includes(c.primaryStatus)) {
      alerts.push({code: 'CAMPAIGN_NOT_SERVING', campaign_id: id, severity: 'critical',
        message: 'Campagne Search refusée ou non éligible : ' + name + '. Statut : '
          + String(c.primaryStatus || 'inconnu') + ' ; motifs : ' + reasons.join(', '),
        suggested_action: 'Vérifier la colonne État et les détails des annonces dans Google Ads.'});
    }
  }
  const ids = Object.keys(enabled);
  if (!ids.length) return alerts;
  const yesterday = new Date(Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd') + 'T12:00:00Z');
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const baselineStart = new Date(yesterday);
  baselineStart.setUTCDate(baselineStart.getUTCDate() - 7);
  const baselineEnd = new Date(yesterday);
  baselineEnd.setUTCDate(baselineEnd.getUTCDate() - 1);
  const date = function(d) { return d.toISOString().slice(0, 10); };
  const impressions = function(start, end) {
    const totals = {};
    const q = 'SELECT campaign.id, metrics.impressions FROM campaign WHERE campaign.id IN ('
      + ids.join(',') + ") AND segments.date BETWEEN '" + start + "' AND '" + end + "'";
    const report = AdsApp.search(q);
    while (report.hasNext()) {
      const row = report.next(), id = String(row.campaign.id);
      totals[id] = safeInteger_(row.metrics.impressions);
    }
    return totals;
  };
  const baseline = impressions(date(baselineStart), date(baselineEnd));
  const current = impressions(date(yesterday), date(yesterday));
  ids.forEach(function(id) {
    if ((baseline[id] || 0) >= CONFIG.ZERO_IMPRESSIONS_BASELINE && (current[id] || 0) === 0) {
      alerts.push({code: 'IMPRESSIONS_ZERO', campaign_id: id, severity: 'critical',
        message: 'Campagne active sans impression hier : ' + names[id] + '. Elle avait '
          + baseline[id] + ' impressions sur les sept jours précédents.',
        suggested_action: 'Vérifier diffusion, enchères, budget, refus et facturation.'});
    }
  });
  return alerts;
}

function weekPeriod_(now, timeZone, lag) {
  if (!Number.isInteger(lag) || lag < 1 || lag > 90) throw new Error('Délai de conversion invalide.');
  const local = Utilities.formatDate(now, timeZone, 'yyyy-MM-dd');
  const cutoff = new Date(local + 'T12:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - lag);
  // Dernière semaine lundi–dimanche entièrement antérieure au délai de conversion.
  const end = new Date(cutoff);
  end.setUTCDate(end.getUTCDate() - end.getUTCDay());
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return {start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10)};
}

function previousPeriod_(period) {
  const end = new Date(period.start + 'T12:00:00Z');
  end.setUTCDate(end.getUTCDate() - 1);
  const length = Math.round((Date.parse(period.end) - Date.parse(period.start)) / 86400000) + 1;
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - length + 1);
  return {start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10)};
}

function monitoringPeriod_(now, timeZone, lag) {
  if (!Number.isInteger(lag) || lag < 1 || lag > 90) throw new Error('Délai de conversion invalide.');
  const end = new Date(Utilities.formatDate(now, timeZone, 'yyyy-MM-dd') + 'T12:00:00Z');
  end.setUTCDate(end.getUTCDate() - lag);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return {start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10)};
}

function collectData_(period, account, monitorOnly) {
  const campaigns = [];
  let selector = AdsApp.campaigns()
    .withCondition("campaign.status = 'ENABLED'")
    .withCondition("campaign.advertising_channel_type = 'SEARCH'");
  if (CONFIG.CAMPAIGN_IDS.length) {
    selector = selector.withIds(CONFIG.CAMPAIGN_IDS.map(safeIdNumber_));
  }
  const iterator = selector.get();
  while (iterator.hasNext()) {
    const campaign = iterator.next();
    const budget = campaign.getBudget();
    const id = String(campaign.getId());
    if (budget.isExplicitlyShared() || budget.getType() !== 'DAILY') {
      Logger.log('Campagne ignorée, budget partagé ou non quotidien : ' + id);
      continue;
    }
    const nativeCpa = campaign.bidding().getTargetCpa();
    let cpa = CONFIG.TARGET_CPA_BY_CAMPAIGN_ID[id];
    if (cpa === undefined || cpa === null) cpa = CONFIG.DEFAULT_TARGET_CPA;
    if (cpa === null || cpa === undefined) cpa = nativeCpa;
    campaigns.push({
      campaign_id: id, name: campaign.getName(), channel_type: 'SEARCH', status: 'ENABLED',
      budget_id: String(budget.getId()), budget_type: 'DAILY', budget_shared: false,
      daily_budget_micros: moneyToMicros_(budget.getAmount()),
      budget_unchanged_during_period: CONFIG.BUDGET_STABILITY_CONFIRMED === true,
      target_cpa_micros: Number(cpa) > 0 ? moneyToMicros_(cpa) : null,
      platform_target_cpa_micros: Number(nativeCpa) > 0 ? moneyToMicros_(nativeCpa) : null,
      cost_micros: 0, conversions: 0, conversion_value_micros: 0,
      previous_cost_micros: 0, previous_conversion_value_micros: 0, today_cost_micros: 0,
      search_budget_lost_impression_share: null
    });
  }
  if (!campaigns.length) return {campaigns: [], keywords: [], search_terms: []};
  if (campaigns.length > 50) throw new Error('Plus de 50 campagnes. Renseigner CAMPAIGN_IDS.');
  const ids = campaigns.map(function(c) { return c.campaign_id; }).join(',');
  const range = "segments.date BETWEEN '" + period.start + "' AND '" + period.end + "'";
  const where = 'campaign.id IN (' + ids + ') AND ' + range;
  const byId = {};
  campaigns.forEach(function(c) { byId[c.campaign_id] = c; });
  let rows = AdsApp.search(
    'SELECT campaign.id, metrics.cost_micros, metrics.conversions, metrics.conversions_value, '
    + 'metrics.search_budget_lost_impression_share FROM campaign WHERE ' + where);
  while (rows.hasNext()) {
    const row = rows.next();
    const c = byId[String(row.campaign.id)];
    c.cost_micros = safeInteger_(row.metrics.costMicros);
    c.conversions = finiteNumber_(row.metrics.conversions);
    c.conversion_value_micros = row.metrics.conversionsValue === null || row.metrics.conversionsValue === undefined
      ? null : valueToMicros_(row.metrics.conversionsValue);
    const share = row.metrics.searchBudgetLostImpressionShare;
    c.search_budget_lost_impression_share = share === null || share === undefined
      ? null : finiteNumber_(share);
  }
  const reference = previousPeriod_(period);
  rows = AdsApp.search('SELECT campaign.id, metrics.cost_micros, metrics.conversions_value FROM campaign WHERE '
    + 'campaign.id IN (' + ids + ") AND segments.date BETWEEN '" + reference.start + "' AND '" + reference.end + "'");
  while (rows.hasNext()) {
    const row = rows.next();
    const c = byId[String(row.campaign.id)];
    c.previous_cost_micros = safeInteger_(row.metrics.costMicros);
    c.previous_conversion_value_micros = row.metrics.conversionsValue === null || row.metrics.conversionsValue === undefined
      ? null : valueToMicros_(row.metrics.conversionsValue);
  }
  rows = AdsApp.search('SELECT campaign.id, metrics.cost_micros FROM campaign WHERE '
    + 'campaign.id IN (' + ids + ') AND segments.date DURING TODAY');
  while (rows.hasNext()) {
    const row = rows.next();
    byId[String(row.campaign.id)].today_cost_micros = safeInteger_(row.metrics.costMicros);
  }
  if (monitorOnly) return {campaigns: campaigns, keywords: [], search_terms: []};
  const keywords = [];
  rows = AdsApp.search(
    'SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, '
    + 'ad_group_criterion.keyword.text, metrics.clicks, metrics.cost_micros, metrics.conversions '
    + 'FROM keyword_view WHERE ' + where
    + " AND ad_group.status = 'ENABLED' AND ad_group_criterion.status = 'ENABLED'"
    + ' AND ad_group_criterion.negative = FALSE AND metrics.cost_micros > 0 LIMIT 501');
  while (rows.hasNext()) {
    const row = rows.next();
    keywords.push({campaign_id: String(row.campaign.id), ad_group_id: String(row.adGroup.id),
      keyword_id: String(row.adGroupCriterion.criterionId), text: row.adGroupCriterion.keyword.text,
      clicks: safeInteger_(row.metrics.clicks), cost_micros: safeInteger_(row.metrics.costMicros),
      conversions: finiteNumber_(row.metrics.conversions)});
  }
  if (keywords.length > 500) throw new Error('Plus de 500 mots-clés dépensiers. Réduire CAMPAIGN_IDS.');
  const terms = [];
  rows = AdsApp.search(
    'SELECT campaign.id, ad_group.id, search_term_view.search_term, metrics.clicks, '
    + 'metrics.cost_micros, metrics.conversions FROM search_term_view WHERE ' + where
    + " AND ad_group.status = 'ENABLED' AND metrics.cost_micros > 0"
    + ' ORDER BY metrics.cost_micros DESC LIMIT 301');
  while (rows.hasNext()) {
    const row = rows.next();
    if (terms.length === 300) {
      Logger.log('Analyse des 300 termes visibles les plus dépensiers ; couverture partielle des termes.');
      break;
    }
    terms.push({campaign_id: String(row.campaign.id), ad_group_id: String(row.adGroup.id),
      text: row.searchTermView.searchTerm, clicks: safeInteger_(row.metrics.clicks),
      cost_micros: safeInteger_(row.metrics.costMicros), conversions: finiteNumber_(row.metrics.conversions)});
  }
  return {campaigns: campaigns, keywords: keywords, search_terms: terms};
}

function collectRecommendations_(campaigns, customerId) {
  const ids = {};
  campaigns.forEach(function(c) { ids[c.campaign_id] = true; });
  const output = [];
  const iterator = AdsApp.recommendations().withLimit(51).get();
  while (iterator.hasNext()) {
    const recommendation = iterator.next();
    const campaign = recommendation.getCampaign();
    if (!campaign || !ids[String(campaign.getId())]) continue;
    const name = recommendation.getResourceName();
    if (!new RegExp('^customers/' + customerId + '/recommendations/[0-9]+$').test(name)) continue;
    const base = recommendation.getBaseStats();
    const potential = recommendation.getPotentialStats();
    output.push({resource_name: name, campaign_id: String(campaign.getId()),
      type: recommendation.getType(),
      base_cost_micros: base ? moneyToMicros_(base.getCost()) : null,
      potential_cost_micros: potential ? moneyToMicros_(potential.getCost()) : null,
      base_conversions: base ? finiteNumber_(base.getConversions()) : null,
      potential_conversions: potential ? finiteNumber_(potential.getConversions()) : null});
  }
  if (output.length > 50) throw new Error('Plus de 50 recommandations ; réduire CAMPAIGN_IDS.');
  return output;
}

function prepareRecommendationPlan_(orders, input, state) {
  if (!Array.isArray(orders)) throw new Error('Liste de recommandations invalide.');
  const candidates = {};
  input.recommendations.forEach(function(r) { candidates[r.resource_name] = r; });
  const seen = {}, plan = [];
  orders.forEach(function(order) {
    const source = candidates[order.resource_name];
    if (order.action !== 'APPLY_GOOGLE_RECOMMENDATION'
        || !/^[a-f0-9]{64}$/.test(order.order_id || '') || seen[order.order_id]
        || !source || source.campaign_id !== order.campaign_id
        || source.type !== order.recommendation_type
        || !['SITELINK_ASSET', 'OPTIMIZE_AD_ROTATION'].includes(source.type)
        || source.base_cost_micros <= 0 || source.potential_cost_micros > source.base_cost_micros
        || source.base_conversions < 5
        || source.potential_conversions < source.base_conversions * 1.05) {
      throw new Error('Recommandation hors contrat : type, campagne ou gain estimé invalide.');
    }
    seen[order.order_id] = true;
    if (state.appliedOrders[order.order_id]) return;
    const iterator = AdsApp.recommendations().withResourceNames([order.resource_name]).get();
    if (!iterator.hasNext()) return; // Google l'a déjà retirée ou appliquée.
    const live = iterator.next();
    const campaign = live.getCampaign();
    const base = live.getBaseStats(), potential = live.getPotentialStats();
    if (!campaign || String(campaign.getId()) !== order.campaign_id
        || live.getType() !== source.type || !base || !potential
        || moneyToMicros_(base.getCost()) <= 0
        || moneyToMicros_(potential.getCost()) > moneyToMicros_(base.getCost())
        || finiteNumber_(base.getConversions()) < 5
        || finiteNumber_(potential.getConversions()) < finiteNumber_(base.getConversions()) * 1.05) {
      throw new Error('Recommandation modifiée depuis son évaluation.');
    }
    plan.push({order: order, recommendation: live});
  });
  return plan;
}

function validateResponse_(result, input, mode) {
  if (result.schema_version !== '1.1' || result.request_id !== input.request_id
      || result.customer_id !== input.customer_id) {
    throw new Error('Réponse incompatible avec la requête ou le compte.');
  }
  if (mode === 'MONITOR') return;
  if (result.currency !== input.currency
      || typeof result.dry_run !== 'boolean' || !Array.isArray(result.orders)) {
    throw new Error('Réponse incompatible avec la requête ou le compte.');
  }
  const expires = Date.parse(result.expires_at);
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('Plan absent ou expiré.');
}

function preparePlan_(orders, input, state, timeZone) {
  const campaigns = {};
  const totals = {};
  input.campaigns.forEach(function(c) { campaigns[c.campaign_id] = c; totals[c.campaign_id] = c.daily_budget_micros; });
  const terms = {};
  input.search_terms.forEach(function(t) { terms[t.campaign_id + '/' + t.ad_group_id + '/' + t.text] = t; });
  const seen = {}, budgets = {}, negatives = {};
  let negativeCount = 0;
  const today = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  const plan = [];
  orders.forEach(function(order) {
    if (!order || typeof order.order_id !== 'string' || !/^[a-f0-9]{64}$/.test(order.order_id)
        || seen[order.order_id] || !campaigns[order.campaign_id]) {
      throw new Error('Ordre invalide, campagne inconnue ou doublon.');
    }
    seen[order.order_id] = true;
    if (state.appliedOrders[order.order_id]) return;
    const campaign = getCampaign_(order.campaign_id);
    const source = campaigns[order.campaign_id];
    if (order.action === 'SET_CAMPAIGN_DAILY_BUDGET') {
      if (budgets[order.campaign_id]) throw new Error('Deux ordres de budget pour la même campagne.');
      budgets[order.campaign_id] = true;
      const next = safeInteger_(order.new_daily_budget_micros);
      if (next <= 0 || order.budget_id !== source.budget_id
          || order.expected_current_budget_micros !== source.daily_budget_micros
          || Math.abs(next - source.daily_budget_micros) * 100 > CONFIG.MAX_CHANGE_PCT * source.daily_budget_micros) {
        throw new Error('Budget hors contrat ou variation excessive.');
      }
      if (state.budgetChanges[order.campaign_id] === today) {
        // Une reprise ne réapplique pas les budgets déjà réservés aujourd'hui.
        Logger.log('Budget déjà réservé aujourd’hui, ignoré : ' + order.campaign_id);
        totals[order.campaign_id] = moneyToMicros_(campaign.getBudget().getAmount());
        return;
      }
      if (state.budgetPeriods[order.campaign_id] === input.period_start + ':' + input.period_end) {
        totals[order.campaign_id] = moneyToMicros_(campaign.getBudget().getAmount());
        return;
      }
      checkedBudget_(campaign, order);
      totals[order.campaign_id] = next;
    } else if (order.action === 'ADD_AD_GROUP_NEGATIVE_KEYWORD') {
      const text = order.text;
      if (order.match_type !== 'EXACT' || typeof text !== 'string' || text.length > 80
          || !text.trim() || text.trim().split(/\s+/).length > 10 || /[\[\]"\\\r\n]/.test(text)) {
        throw new Error('Seuls les négatifs exacts avec une syntaxe valide sont acceptés.');
      }
      const key = order.campaign_id + '/' + order.ad_group_id + '/' + text;
      const term = terms[key];
      if (negatives[key] || !term || term.conversions !== 0 || term.clicks < 30
          || term.cost_micros < 2 * source.target_cpa_micros) {
        throw new Error('Négatif absent des données ou sans preuve de gaspillage.');
      }
      negatives[key] = true;
      const group = getAdGroup_(order.campaign_id, order.ad_group_id);
      assertNoPositiveConflict_(group, text);
      if (hasExactNegative_(group, text)) return;
      negativeCount++;
      if (negativeCount > CONFIG.MAX_NEGATIVES_PER_RUN) {
        Logger.log('Limite de négatifs atteinte, proposition ignorée : ' + key);
        return;
      }
    } else {
      throw new Error('Action inconnue : ' + order.action);
    }
    plan.push({order: order, campaign: campaign});
  });
  const total = Object.keys(totals).reduce(function(sum, id) { return sum + totals[id]; }, 0);
  if (total > input.max_total_daily_budget_micros) throw new Error('Plafond des budgets du lot dépassé.');
  return plan;
}

function checkedBudget_(campaign, order) {
  const budget = campaign.getBudget();
  if (!campaign.isEnabled() || budget.isExplicitlyShared() || budget.getType() !== 'DAILY'
      || String(budget.getId()) !== order.budget_id
      || moneyToMicros_(budget.getAmount()) !== order.expected_current_budget_micros) {
    throw new Error('Budget ou état modifié depuis l’extraction, campagne ' + order.campaign_id);
  }
  return budget;
}

function getCampaign_(id) {
  const iterator = AdsApp.campaigns().withIds([safeIdNumber_(id)])
    .withCondition("campaign.advertising_channel_type = 'SEARCH'").get();
  if (!iterator.hasNext()) throw new Error('Campagne Search introuvable : ' + id);
  const campaign = iterator.next();
  if (!campaign.isEnabled()) throw new Error('Campagne désactivée : ' + id);
  return campaign;
}

function getAdGroup_(campaignId, groupId) {
  const iterator = getCampaign_(campaignId).adGroups().withIds([safeIdNumber_(groupId)]).get();
  if (!iterator.hasNext()) throw new Error('Groupe introuvable : ' + groupId);
  const group = iterator.next();
  if (!group.isEnabled()) throw new Error('Groupe désactivé : ' + groupId);
  return group;
}

function normalize_(text) { return text.trim().toLowerCase(); }

function assertNoPositiveConflict_(group, text) {
  const iterator = group.keywords().withCondition("ad_group_criterion.status = 'ENABLED'").get();
  while (iterator.hasNext()) {
    const keyword = iterator.next();
    // getText peut inclure les symboles de correspondance : les enlever pour comparer.
    const positive = keyword.getText().replace(/^\[(.*)\]$/, '$1').replace(/^"(.*)"$/, '$1');
    if (normalize_(positive) === normalize_(text)) {
      throw new Error('Négatif en conflit avec un mot-clé positif actif : ' + text);
    }
  }
}

function hasExactNegative_(group, text) {
  const iterator = group.negativeKeywords().get();
  while (iterator.hasNext()) {
    const keyword = iterator.next();
    const bare = keyword.getText().replace(/^\[(.*)\]$/, '$1');
    if (keyword.getMatchType() === 'EXACT' && normalize_(bare) === normalize_(text)) return true;
  }
  return false;
}

function priority_(order) {
  if (order.action !== 'SET_CAMPAIGN_DAILY_BUDGET') return 2;
  return order.new_daily_budget_micros < order.expected_current_budget_micros ? 0 : 1;
}

function safeIdNumber_(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('Identifiant invalide.');
  return safeInteger_(value);
}

function finiteNumber_(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('Métrique invalide.');
  return number;
}

function safeInteger_(value) {
  const number = finiteNumber_(value);
  if (!Number.isSafeInteger(number)) throw new Error('Entier absent, fractionnaire ou trop grand.');
  return number;
}

function moneyToMicros_(amount) { return safeInteger_(Math.round(finiteNumber_(amount) * 1e6)); }

function valueToMicros_(amount) {
  const micros = Math.round(Number(amount) * 1e6);
  if (!Number.isSafeInteger(micros)) throw new Error('Valeur de conversion invalide.');
  return micros;
}

function readState_(customerId) {
  const name = 'CrewAI_Search_State_' + customerId + '.json';
  const files = DriveApp.getFilesByName(name);
  let file = null;
  if (files.hasNext()) file = files.next();
  if (files.hasNext()) throw new Error('Plusieurs journaux Drive portent le même nom : ' + name);
  const state = file ? JSON.parse(file.getBlob().getDataAsString('UTF-8'))
    : {customerId: customerId, completedPeriods: {}, requestIds: {}, appliedOrders: {}, budgetChanges: {}};
  if (state.customerId !== customerId || !state.completedPeriods || !state.requestIds
      || !state.appliedOrders || !state.budgetChanges) throw new Error('Journal Drive invalide.');
  state.alertReceipts = state.alertReceipts || {};
  state.budgetPeriods = state.budgetPeriods || {};
  return {file: file, name: name, state: state};
}

function saveState_(store, state) {
  if (store.file) store.file.setContent(JSON.stringify(state));
  else store.file = DriveApp.createFile(store.name, JSON.stringify(state), 'application/json');
}
