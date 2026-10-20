// Hors réseau : node --test tests/test_script_auth.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const files = ['google_ads_script.js', 'google_ads_monitor.js'];
const token = 'test-only-' + 'x'.repeat(32) + '!';
function sandbox(filename, configuredToken = token, status = 200) {
  const requests = [];
  const context = {
    UrlFetchApp: {fetch(url, options) {
      requests.push({url, options});
      const body = url.endsWith('/capabilities')
        ? {schema_version: '1.1', min_period_days: 7, exception_monitoring: true}
        : {detail: token}; // Un diagnostic 401 ne doit pas recopier cette réponse.
      return {getResponseCode: () => url.endsWith('/capabilities') ? 200 : status,
        getContentText: () => JSON.stringify(body)};
    }},
    AdsApp: {
      currentAccount: () => ({getCustomerId: () => '123-456-7890', getTimeZone: () => 'UTC'}),
      getExecutionInfo: () => ({isPreview: () => true}),
      search: () => {throw new Error('Collecte interdite avant authentification');}
    },
    DriveApp: {getFilesByName: () => ({hasNext: () => false})},
    Utilities: {formatDate: d => d.toISOString().slice(0, 10)}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context);
  vm.runInContext('CONFIG.WEBHOOK_TOKEN=' + JSON.stringify(configuredToken), context);
  return {context, requests};
}

for (const filename of files) {
  for (const value of [token, '  ' + token + '  ', 'Bearer ' + token, 'bearer\t' + token]) {
    test(filename + ': un unique Authorization Bearer après normalisation ' + JSON.stringify(value.slice(0, 8)), () => {
      const {context, requests} = sandbox(filename, value);
      const options = {method: 'post', contentType: 'application/json', payload: '{"test":true}',
        headers: {authorization: 'ancienne-valeur', AUTHORIZATION: 'autre-valeur', 'X-Request-ID': 'test-request'}};
      context.fetchJson_(filename.includes('monitor') ? '/monitor' : '/optimize', options);
      const sent = requests[0].options;
      assert.equal(sent.headers.Authorization, 'Bearer ' + token);
      assert.equal(Object.keys(sent.headers).filter(k => k.toLowerCase() === 'authorization').length, 1);
      assert.equal(sent.headers['X-Request-ID'], 'test-request');
      assert.equal(sent.method, 'post');
      assert.equal(sent.contentType, 'application/json');
      assert.equal(sent.payload, options.payload);
      assert.equal(sent.followRedirects, false);
      assert.equal(options.headers.authorization, 'ancienne-valeur');
    });
  }
  for (const value of ['', '  ', 'Bearer ', 'Bearer Bearer ' + token, 'a\nb', 'a b', null, 'COLLER_VOTRE_TOKEN_ICI']) {
    test(filename + ': configuration invalide refusée avant HTTP ' + JSON.stringify(value), () => {
      const {context, requests} = sandbox(filename, value);
      assert.throws(() => context.fetchJson_('/monitor', {method: 'post'}), /WEBHOOK_TOKEN/);
      assert.equal(requests.length, 0);
    });
  }
  test(filename + ': contrôle authentifié en Aperçu avant les performances et sans secret dans le diagnostic', () => {
    const {context, requests} = sandbox(filename, token, 401);
    assert.throws(() => context.main(), error => {
      assert.match(error.message, /HTTP 401 sur \/alerts\/config/);
      assert.match(error.message, /Authorization: Bearer <masqué>/);
      assert(!error.message.includes(token));
      return true;
    });
    assert.equal(requests.length, 2);
    assert(requests[1].url.endsWith('/alerts/config'));
    assert.equal(requests[1].options.method, 'get');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer ' + token);
  });
}

test('les deux scripts ne diffèrent que par leur mode de planification', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  assert.equal(read(files[1]), read(files[0]).replace("MODE: 'OPTIMIZE',", "MODE: 'MONITOR',"));
});
