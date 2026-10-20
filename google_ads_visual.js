/** Google Ads Scripts V8 : visuels PMax manquants et groupes Display explicitement ciblés. */
const CONFIG = {
  BASE_URL: 'https://mon-expert-google-ads.onrender.com',
  WEBHOOK_TOKEN: 'COLLER_VOTRE_TOKEN_ICI', // Token brut, sans le mot Bearer.
  DRY_RUN: false,
  BRAND_NAME: '', // Nom de marque réel validé par le client.
  PRODUCT_OR_SERVICE: '', // Offre réelle, sans promesse inventée.
  AUDIENCE: '', // Public réel de la campagne.
  REQUIRED_RESOURCES: [], // Ex. ['OFFICIAL_LOGO'] ou ['EXACT_BRAND_GUIDELINES'].
  MAX_VISUALS_PER_RUN: 3, // Limite les appels OpenAI et les mutations à chaque exécution.
  PMAX_CAMPAIGN_IDS: [], // [] = toutes les campagnes PMax actives du compte.
  DISPLAY_AD_GROUP_IDS: [], // Groupes Display à créer uniquement si aucune annonce image active.
  DISPLAY_FINAL_URL: '' // URL HTTPS réelle indispensable à une annonce Display.
};

function main() {
  const token = String(CONFIG.WEBHOOK_TOKEN || '').trim().replace(/^Bearer[ \t]+/i, '').trim();
  if (!token || token === 'COLLER_VOTRE_TOKEN_ICI' || /\s/.test(token)) {
    throw new Error('WEBHOOK_TOKEN invalide.');
  }
  const accountId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
  fetchApi_('/alerts/config', {method: 'get'}, token); // Échec avant tout appel OpenAI ou mutation.
  const preview = AdsApp.getExecutionInfo().isPreview() || CONFIG.DRY_RUN;
  const candidates = findPmaxNeeds_().concat(findDisplayNeeds_())
    .slice(0, Math.max(0, Math.min(10, Number(CONFIG.MAX_VISUALS_PER_RUN) || 0)));
  candidates.forEach(function(item) {
    const missing = CONFIG.REQUIRED_RESOURCES.slice();
    if (!CONFIG.BRAND_NAME || !CONFIG.PRODUCT_OR_SERVICE || !CONFIG.AUDIENCE) missing.push('BRAND_BRIEF');
    const request = {
      request_id: Utilities.getUuid(), customer_id: accountId,
      campaign_id: item.campaignId, campaign_type: item.kind,
      brand_name: CONFIG.BRAND_NAME || 'Marque à préciser',
      product_or_service: CONFIG.PRODUCT_OR_SERVICE || 'Offre de la campagne à préciser',
      audience: CONFIG.AUDIENCE || 'Public cible à préciser',
      required_resources: Array.from(new Set(missing))
    };
    const result = fetchApi_('/assets/generate', {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(request)
    }, token);
    if (result.status === 'blocked') {
      Logger.log('Asset bloqué, campagne ' + item.campaignId + ' : ' + result.reason
        + '. WhatsApp=' + result.whatsapp_status + ', email=' + result.email_status);
      return;
    }
    if (result.status !== 'generated' || !result.image_png_base64 ||
        ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'].indexOf(result.image_model) < 0) {
      throw new Error('Réponse de génération inattendue : ' + item.campaignId);
    }
    if (preview) {
      Logger.log('Aperçu : visuel généré pour ' + item.campaignId + ', sans ajout Google Ads.');
      return;
    }
    // Vérifier une seconde fois pour éviter les doublons après un appel réseau lent.
    if (item.kind === 'PERFORMANCE_MAX' && hasPmaxImage_(item.group)) return;
    if (item.kind === 'DISPLAY' && hasDisplayAd_(item.groupId, item.campaignId)) return;
    const blob = Utilities.newBlob(Utilities.base64Decode(result.image_png_base64), 'image/png',
      'google-ads-' + item.campaignId + '.png');
    const operation = AdsApp.adAssets().newImageAssetBuilder()
      .withName('CrewAI original ' + item.campaignId + ' ' + item.groupId)
      .withData(blob).withSyntheticContentAttestation('IS_SYNTHETIC').build();
    const asset = operation.getResult();
    if (!asset) throw new Error('Google Ads a refusé le nouvel asset.');
    if (item.kind === 'PERFORMANCE_MAX') {
      item.group.addAsset(asset, 'MARKETING_IMAGE');
    } else {
      const finalUrl = CONFIG.DISPLAY_FINAL_URL.trim();
      if (!/^https:\/\/[^\s/]+\.[^\s/]+/.test(finalUrl)) throw new Error('DISPLAY_FINAL_URL invalide.');
      const displayUrl = finalUrl.match(/^https:\/\/([^/]+)/)[1];
      const ad = item.group.newAd().imageAdBuilder()
        .withName('CrewAI original ' + item.campaignId + ' ' + item.groupId)
        .withImage(asset).withDisplayUrl(displayUrl).withFinalUrl(finalUrl)
        .withSyntheticContentAttestation('IS_SYNTHETIC').build();
      if (!ad.getResult()) throw new Error('Google Ads a refusé l’annonce Display.');
    }
    Logger.log('Visuel ajouté, campagne ' + item.campaignId + ', groupe ' + item.groupId);
  });
}

function fetchApi_(path, options, token) {
  options.headers = {Authorization: 'Bearer ' + token};
  options.muteHttpExceptions = true;
  options.followRedirects = false;
  const response = UrlFetchApp.fetch(CONFIG.BASE_URL.replace(/\/$/, '') + path, options);
  if (response.getResponseCode() !== 200) {
    throw new Error('API HTTP ' + response.getResponseCode() + ' sur ' + path + ', vérifier Render.');
  }
  return JSON.parse(response.getContentText());
}

function findPmaxNeeds_() {
  const results = [];
  let selector = AdsApp.performanceMaxCampaigns().withCondition("campaign.status = 'ENABLED'");
  if (CONFIG.PMAX_CAMPAIGN_IDS.length) selector = selector.withIds(CONFIG.PMAX_CAMPAIGN_IDS);
  const campaigns = selector.get();
  while (campaigns.hasNext()) {
    const campaign = campaigns.next();
    const groups = campaign.assetGroups().get();
    while (groups.hasNext()) {
      const group = groups.next();
      if (group.isEnabled() && !hasPmaxImage_(group)) {
        results.push({kind: 'PERFORMANCE_MAX', campaignId: String(campaign.getId()),
          groupId: String(group.getId()), group: group});
      }
    }
  }
  return results;
}

function hasPmaxImage_(group) {
  const resource = group.getResourceName();
  if (!/^customers\/[0-9]+\/assetGroups\/[0-9]+$/.test(resource)) {
    throw new Error('Nom de groupe PMax invalide.');
  }
  const rows = AdsApp.search("SELECT asset_group_asset.field_type FROM asset_group_asset WHERE "
    + "asset_group.resource_name = '" + resource + "' AND asset_group_asset.status = 'ENABLED'");
  while (rows.hasNext()) {
    if (rows.next().assetGroupAsset.fieldType === 'MARKETING_IMAGE') return true;
  }
  return false;
}

function findDisplayNeeds_() {
  if (!CONFIG.DISPLAY_AD_GROUP_IDS.length) return [];
  if (!/^https:\/\/[^\s/]+\.[^\s/]+/.test(CONFIG.DISPLAY_FINAL_URL.trim())) {
    throw new Error('DISPLAY_FINAL_URL HTTPS obligatoire pour les groupes Display ciblés.');
  }
  const results = [];
  const groups = AdsApp.adGroups().withIds(CONFIG.DISPLAY_AD_GROUP_IDS)
    .withCondition("campaign.advertising_channel_type = 'DISPLAY'")
    .withCondition("ad_group.status = 'ENABLED'").get();
  while (groups.hasNext()) {
    const group = groups.next();
    const campaign = group.getCampaign();
    if (!campaign || !campaign.isEnabled()) continue;
    const campaignId = String(campaign.getId()), groupId = String(group.getId());
    if (!hasDisplayAd_(groupId, campaignId)) {
      results.push({kind: 'DISPLAY', campaignId: campaignId, groupId: groupId, group: group});
    }
  }
  return results;
}

function hasDisplayAd_(groupId, campaignId) {
  if (!/^[0-9]+$/.test(groupId) || !/^[0-9]+$/.test(campaignId)) throw new Error('ID Display invalide.');
  const rows = AdsApp.search('SELECT ad_group_ad.ad.id FROM ad_group_ad WHERE campaign.id = '
    + campaignId + ' AND ad_group.id = ' + groupId
    + " AND ad_group_ad.status = 'ENABLED'"
    + " AND ad_group_ad.ad.type IN ('IMAGE_AD', 'RESPONSIVE_DISPLAY_AD') LIMIT 1");
  return rows.hasNext();
}
