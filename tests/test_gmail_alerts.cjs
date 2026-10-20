// node --test tests/test_gmail_alerts.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function iterator(items) { let i = 0; return {hasNext: () => i < items.length, next: () => items[i++]}; }
function setup(filename) {
  const mails = [], queries = [], logs = [], writes = [];
  const context = {
    Logger: {log: value => logs.push(value)},
    MailApp: {sendEmail: (to, subject, body) => mails.push({to, subject, body})},
    DriveApp: {createFile: (name, content) => {
      writes.push(content);
      return {setContent: value => writes.push(value)};
    }},
    Utilities: {formatDate: () => '2026-10-20'},
    AdsApp: {search: query => {
      queries.push(query);
      if (query.includes('FROM customer')) return iterator([{customer: {id: '1234567890', status: 'SUSPENDED'}}]);
      if (query.includes('FROM billing_setup')) return iterator([{billingSetup: {status: 'CANCELLED'}}]);
      if (query.includes('campaign.primary_status_reasons FROM campaign')) return iterator([
        {campaign: {id: '11', name: 'En pause', status: 'PAUSED', primaryStatus: 'PAUSED', primaryStatusReasons: []}},
        {campaign: {id: '22', name: 'Refusée', status: 'ENABLED', primaryStatus: 'NOT_ELIGIBLE',
          primaryStatusReasons: ['HAS_ADS_DISAPPROVED']}},
        {campaign: {id: '33', name: 'Sans diffusion', status: 'ENABLED', primaryStatus: 'ELIGIBLE', primaryStatusReasons: []}}
      ]);
      if (query.includes('metrics.impressions FROM campaign')) {
        const match = query.match(/BETWEEN '([^']+)' AND '([^']+)'/);
        const baseline = match[1] !== match[2];
        return iterator(['22', '33'].map(id => ({campaign: {id}, metrics: {impressions: baseline ? '150' : '0'}})));
      }
      throw new Error('Unexpected query: ' + query);
    }}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context);
  return {context, mails, queries, logs, writes};
}

for (const filename of ['google_ads_script.js', 'google_ads_monitor.js']) {
  test(filename + ': signaux locaux critiques et email unique dédupliqué', () => {
    const s = setup(filename);
    const alerts = s.context.collectGoogleCriticalAlerts_('Europe/Paris');
    assert.deepEqual(Array.from(alerts.map(a => a.code)).sort(),
      ['ACCOUNT_SUSPENDED', 'BILLING_SETUP_CANCELLED', 'CAMPAIGN_PAUSED',
        'CAMPAIGN_NOT_SERVING', 'IMPRESSIONS_ZERO', 'IMPRESSIONS_ZERO'].sort());
    const store = {file: null, name: 'test.json'}, state = {gmailAlertReceipts: {}};
    s.context.sendCriticalMail_(alerts, store, state, '1234567890', false);
    assert.equal(s.mails.length, 1);
    assert.equal(s.mails[0].to, 'soleragency6@gmail.com');
    assert.match(s.mails[0].body, /BILLING_SETUP_CANCELLED/);
    assert.match(s.mails[0].body, /IMPRESSIONS_ZERO/);
    s.context.sendCriticalMail_(alerts, store, state, '1234567890', false);
    assert.equal(s.mails.length, 1);
    assert.equal(s.writes.length, 1);
  });

  test(filename + ': ROAS et tCPA du serveur partent via MailApp, jamais en Aperçu', () => {
    const s = setup(filename), state = {gmailAlertReceipts: {}}, store = {file: null, name: 'test.json'};
    const alerts = [{code: 'ROAS_DROP', campaign_id: '22', severity: 'critical', message: 'Baisse > 20 %'},
      {code: 'MISSING_TCPA', campaign_id: '33', severity: 'warning', message: 'tCPA absent'}];
    s.context.sendCriticalMail_(alerts, store, state, '1234567890', true);
    assert.equal(s.mails.length, 0);
    s.context.sendCriticalMail_(alerts, store, state, '1234567890', false);
    assert.equal(s.mails.length, 1);
    assert.match(s.mails[0].body, /ROAS_DROP/);
    assert.match(s.mails[0].body, /MISSING_TCPA/);
  });
}
