// node --test tests/test_visual_script.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'google_ads_visual.js'), 'utf8');
function iterator(items) { let i = 0; return {hasNext: () => i < items.length, next: () => items[i++]}; }
function sandbox({response, preview = false} = {}) {
  const requests = [], changes = [], logs = [], mails = [];
  let imageExists = false;
  const group = {getId: () => 222, getResourceName: () => 'customers/1234567890/assetGroups/222',
    isEnabled: () => true, addAsset: (asset, kind) => {changes.push({asset, kind}); imageExists = true;}};
  const campaign = {getId: () => 111, assetGroups: () => ({get: () => iterator([group])})};
  const selector = {withCondition: () => selector, withIds: () => selector, get: () => iterator([campaign])};
  const context = {Logger: {log: text => logs.push(text)},
    MailApp: {sendEmail: (to, subject, body) => mails.push({to, subject, body})},
    Utilities: {getUuid: () => '7faed8c4-190b-47c9-9d35-a2ba4bb3e458',
      base64Decode: value => Buffer.from(value, 'base64'), newBlob: bytes => bytes},
    UrlFetchApp: {fetch: (url, options) => {
      requests.push({url, options});
      const result = url.endsWith('/alerts/config') ? {configured: true} : response;
      return {getResponseCode: () => 200, getContentText: () => JSON.stringify(result)};
    }},
    AdsApp: {currentAccount: () => ({getCustomerId: () => '123-456-7890'}),
      getExecutionInfo: () => ({isPreview: () => preview}),
      performanceMaxCampaigns: () => selector,
      adGroups: () => ({withIds: () => {throw new Error('Display non ciblé');}}),
      search: () => iterator(imageExists ? [{assetGroupAsset: {fieldType: 'MARKETING_IMAGE'}}] : []),
      adAssets: () => ({newImageAssetBuilder: () => ({withName() {return this;},
        withData() {return this;}, withSyntheticContentAttestation() {return this;},
        build: () => ({getResult: () => ({id: 'asset-1'})})})})}};
  vm.createContext(context);
  vm.runInContext(code, context);
  vm.runInContext("CONFIG.WEBHOOK_TOKEN='test-only-token'; CONFIG.BRAND_NAME='Marque validée';"
    + " CONFIG.PRODUCT_OR_SERVICE='Produit validé'; CONFIG.AUDIENCE='Audience validée';", context);
  return {context, requests, changes, logs, mails};
}

test('ressource officielle manquante : bloque et n’ajoute aucun asset', () => {
  const s = sandbox({response: {status: 'blocked', reason: 'Logo requis',
    whatsapp_status: 'unconfigured', email_status: 'sent'}});
  vm.runInContext("CONFIG.REQUIRED_RESOURCES=['OFFICIAL_LOGO']; main();", s.context);
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[1].options.headers.Authorization, 'Bearer test-only-token');
  assert.deepEqual(JSON.parse(s.requests[1].options.payload).required_resources, ['OFFICIAL_LOGO']);
  assert.equal(s.changes.length, 0);
  assert.equal(s.mails.length, 1);
  assert.equal(s.mails[0].to, 'soleragency6@gmail.com');
});

test('PMax : applique une image générée et déclare son origine synthétique', () => {
  const s = sandbox({response: {status: 'generated', image_model: 'gpt-image-2.5-flare',
    image_png_base64: Buffer.from('fake-png').toString('base64')}});
  vm.runInContext('main()', s.context);
  assert.equal(s.requests.length, 2);
  assert.equal(s.changes.length, 1);
  assert.equal(s.changes[0].kind, 'MARKETING_IMAGE');
});

test('Aperçu : génère la proposition sans modification Google Ads', () => {
  const s = sandbox({preview: true, response: {status: 'generated', image_model: 'gpt-image-2.5-flare',
    image_png_base64: Buffer.from('fake-png').toString('base64')}});
  vm.runInContext('main()', s.context);
  assert.equal(s.changes.length, 0);
  assert.match(s.logs.join(' '), /Aperçu/);
});
