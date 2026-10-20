"""Tests hors réseau : pytest tests/ après installation des requirements-dev.txt."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main as m


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("ALERT_STATE_DB", str(tmp_path / "alerts.sqlite3"))
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-unused")
    monkeypatch.setenv("WEBHOOK_TOKEN", "test-only-" + "x" * 32)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("ALERT_EMAIL_FROM", raising=False)
    monkeypatch.delenv("ALERT_EMAIL_TO", raising=False)
    def refuse_network(*args, **kwargs):
        raise AssertionError("Un test ne doit pas appeler le réseau")
    monkeypatch.setattr(m, "urlopen", refuse_network)


@pytest.fixture
def data():
    now = datetime.now(timezone.utc)
    end = now.date() - timedelta(days=7)
    return m.AdsInput(
        request_id="3898148e-186c-4c81-90eb-0dbbb330d1f5", customer_id="1234567890", currency="EUR",
        snapshot_at=now, period_start=end-timedelta(days=6), period_end=end,
        reference_period_start=end-timedelta(days=13), reference_period_end=end-timedelta(days=7),
        account_timezone="UTC", today_spend_date=now.date(), conversion_lag_days=7,
        conversion_tracking_ok=True, roas_monitoring_enabled=True, max_total_daily_budget_micros=100_000_000,
        campaigns=[m.Campaign(campaign_id="111", channel_type="SEARCH", status="ENABLED", budget_id="222",
            budget_type="DAILY", budget_shared=False, daily_budget_micros=100_000_000,
            budget_unchanged_during_period=True, target_cpa_micros=30_000_000, platform_target_cpa_micros=30_000_000,
            cost_micros=500_000_000, conversions=10, conversion_value_micros=1_000_000_000,
            previous_cost_micros=500_000_000, previous_conversion_value_micros=1_000_000_000,
            today_cost_micros=0, search_budget_lost_impression_share=.15)],
        keywords=[m.Keyword(campaign_id="111", ad_group_id="333", keyword_id="444", text="couvreur toiture",
                            clicks=100, cost_micros=200_000_000, conversions=0)])


def headers():
    return {"Authorization": "Bearer test-only-" + "x" * 32}


def fake_result(strategy):
    return SimpleNamespace(pydantic=strategy, tasks_output=[SimpleNamespace(pydantic=m.Analysis(
        wasted_keyword_keys=["111/333/444"], summary="Analyse interne jamais envoyée en rapport nominal"))])


def test_nominal_silent_keeps_safe_orders(data, monkeypatch):
    assert m.detect_exceptions(data) == []
    strategy=m.Strategy(decisions=[dict(campaign_id="111",change_pct=-10,reason="Routine")],summary="Rapport interne")
    monkeypatch.setattr(m,"build_crew",lambda d:SimpleNamespace(kickoff=lambda **k:fake_result(strategy)))
    monkeypatch.setattr(m,"send_alert_email",lambda *a:pytest.fail("Aucun email nominal"))
    with TestClient(m.app) as client:
        response=client.post('/optimize',json=data.model_dump(mode='json'),headers=headers())
    assert response.status_code==200, response.text
    body=response.json()
    assert body['silent'] and body['summary']=='' and not body['requires_attention']
    assert 'analysis' not in body and body['orders'][0]['new_daily_budget_micros']==90_000_000
    assert body['notification_status']=='not_needed'


@pytest.mark.parametrize('value,expected',[(800_000_000,False),(799_999_999,True),(0,True),(-10_000_000,True)])
def test_roas_strict_threshold(data,value,expected):
    data.campaigns[0].conversion_value_micros=value
    assert any(a.code=='ROAS_DROP' for a in m.detect_exceptions(data)) is expected


def test_missing_target_is_accepted_and_alerted(data):
    data.campaigns[0].target_cpa_micros=None
    data.campaigns[0].platform_target_cpa_micros=None
    codes={a.code for a in m.detect_exceptions(data)}
    assert {'MISSING_TCPA','MISSING_OBJECTIVE'} <= codes
    assert m.eligible_data(data,m.detect_exceptions(data)) is None
    assert m.wasted_keywords(data)==[]


def test_pacing_uses_current_local_day(data):
    data.snapshot_at=data.snapshot_at.replace(hour=12,minute=0,second=0)
    data.campaigns[0].today_cost_micros=80_000_000
    assert any(a.code=='BUDGET_PACING' for a in m.detect_exceptions(data))
    data.today_spend_date-=timedelta(days=1)
    codes={a.code for a in m.detect_exceptions(data)}
    assert 'BUDGET_PACING' not in codes and 'MONITORING_DATA_MISSING' in codes


def test_missing_roas_data_not_nominal(data):
    data.campaigns[0].previous_conversion_value_micros=None
    assert any(a.code=='MONITORING_DATA_MISSING' for a in m.detect_exceptions(data))
    data.roas_monitoring_enabled=False
    assert m.detect_exceptions(data)==[]


def test_send_before_llm_and_block_affected_campaign(data,monkeypatch):
    monkeypatch.setenv('RESEND_API_KEY','test-resend-unused')
    data.campaigns[0].conversion_value_micros=500_000_000
    calls=[]
    monkeypatch.setattr(m,'send_alert_email',lambda *a:calls.append('email'))
    monkeypatch.setattr(m,'build_crew',lambda *a:pytest.fail('Campagne en anomalie exclue du LLM'))
    with TestClient(m.app) as client:
        response=client.post('/optimize',json=data.model_dump(mode='json'),headers=headers())
    assert response.status_code==200 and calls==['email']
    body=response.json()
    assert body['orders']==[] and body['requires_attention'] and not body['silent']
    assert body['notification_status']=='sent'


def test_strategic_change_alerted_not_applied(data,monkeypatch):
    monkeypatch.setenv('RESEND_API_KEY','test-resend-unused')
    strategy=m.Strategy(decisions=[], strategic_changes=[dict(campaign_ids=['111'],kind='BIDDING_STRATEGY',reason='Changer la stratégie')],summary='Interne')
    monkeypatch.setattr(m,'build_crew',lambda d:SimpleNamespace(kickoff=lambda **k:fake_result(strategy)))
    sent=[]
    monkeypatch.setattr(m,'send_alert_email',lambda *a:sent.append(a))
    with TestClient(m.app) as client:
        body=client.post('/optimize',json=data.model_dump(mode='json'),headers=headers()).json()
    assert body['orders']==[] and len(sent)==1
    assert body['alerts'][0]['code']=='STRATEGIC_BIDDING_STRATEGY'


def test_major_budget_change_not_automatic(data,monkeypatch):
    monkeypatch.setenv('RESEND_API_KEY','test-resend-unused')
    strategy=m.Strategy(decisions=[dict(campaign_id='111',change_pct=-20,reason='Arbitrage majeur')],summary='Interne')
    monkeypatch.setattr(m,'build_crew',lambda d:SimpleNamespace(kickoff=lambda **k:fake_result(strategy)))
    monkeypatch.setattr(m,'send_alert_email',lambda *a:None)
    with TestClient(m.app) as client:
        body=client.post('/optimize',json=data.model_dump(mode='json'),headers=headers()).json()
    assert body['orders']==[] and body['alerts'][0]['code']=='MAJOR_BUDGET_CHANGE'


def test_dedup_and_receipts_survive_lost_render_database(data,monkeypatch,tmp_path):
    monkeypatch.setenv('RESEND_API_KEY','test-resend-unused')
    data.campaigns[0].platform_target_cpa_micros=None
    sent=[]
    monkeypatch.setattr(m,'send_alert_email',lambda *a:sent.append(a))
    alerts=m.detect_exceptions(data)
    first=m.notify_exceptions(data,alerts)
    assert first.status=='sent' and len(sent)==1
    assert m.notify_exceptions(data,alerts).status=='suppressed'
    monkeypatch.setenv('ALERT_STATE_DB',str(tmp_path/'new-after-restart.sqlite3'))
    data.alert_receipts=first.receipts
    assert m.notify_exceptions(data,alerts).status=='suppressed' and len(sent)==1


def test_failure_not_marked_sent_and_retried(data,monkeypatch):
    monkeypatch.setenv('RESEND_API_KEY','test-resend-unused')
    data.campaigns[0].platform_target_cpa_micros=None
    alerts=m.detect_exceptions(data)
    def fail(*a): raise TimeoutError('test')
    monkeypatch.setattr(m,'send_alert_email',fail)
    assert m.notify_exceptions(data,alerts).status=='failed'
    monkeypatch.setattr(m,'send_alert_email',lambda *a:None)
    assert m.notify_exceptions(data,alerts).status=='sent'


def test_no_resend_key_is_explicit_exception(data):
    data.campaigns[0].platform_target_cpa_micros=None
    with TestClient(m.app) as client:
        body=client.post('/monitor',json=data.model_dump(mode='json'),headers=headers()).json()
        assert client.post('/alerts/test',headers=headers()).status_code==503
        assert client.get('/alerts/recent').status_code==401
        assert client.get('/alerts/recent',headers=headers()).json()[0]['customer_id']==data.customer_id
    assert body['requires_attention'] and body['notification_status']=='unconfigured'


def test_resend_request_destination_and_authorization(monkeypatch):
    monkeypatch.setenv('RESEND_API_KEY','test-resend-key')
    captured={}
    class Response:
        def __enter__(self): return self
        def __exit__(self,*a): pass
        def read(self): return b'{"id":"test-message-id"}'
    def fake(request,timeout):
        captured.update(url=request.full_url,headers=dict(request.header_items()),body=json.loads(request.data),timeout=timeout)
        return Response()
    monkeypatch.setattr(m,'urlopen',fake)
    m.send_alert_email('Exception de test','Détail')
    assert captured['url']=='https://api.resend.com/emails'
    assert captured['headers']['Authorization']=='Bearer test-resend-key'
    assert captured['body']['to']==['contact@soler-agency.com']
    assert captured['body']['from']=='contact@soler-agency.com'
    assert captured['timeout']==10


def test_monitor_nominal_no_llm_no_email(data,monkeypatch):
    monkeypatch.setattr(m,'build_crew',lambda *a:pytest.fail('Pas de LLM pour monitor'))
    monkeypatch.setattr(m,'send_alert_email',lambda *a:pytest.fail('Pas d’email nominal'))
    with TestClient(m.app) as client:
        response=client.post('/monitor',json=data.model_dump(mode='json'),headers=headers())
    assert response.status_code==200
    assert response.json()['silent'] and response.json()['status']=='nominal'


def test_unknown_strategy_campaign_rejected(data):
    strategy=m.Strategy(decisions=[],strategic_changes=[dict(campaign_ids=['999'],kind='OTHER',reason='Test')],summary='Test')
    with pytest.raises(ValueError): m.strategic_exceptions(data,strategy,[])


def test_blocked_campaign_keeps_its_budget_in_remaining_cap(data):
    other=data.campaigns[0].model_copy(update={'campaign_id':'555','budget_id':'666'})
    data.campaigns.append(other)
    data.max_total_daily_budget_micros=200_000_000
    alerts=[m.Alert(code='ROAS_DROP',campaign_id='111',message='Test',suggested_action='Vérifier')]
    remaining=m.eligible_data(data,alerts)
    assert [c.campaign_id for c in remaining.campaigns]==['555']
    assert remaining.max_total_daily_budget_micros==100_000_000
    assert remaining.keywords==[]


def test_tracking_or_global_cap_never_nominal(data):
    data.conversion_tracking_ok=False
    assert any(a.code=='CONVERSION_TRACKING' for a in m.detect_exceptions(data))
    data.max_total_daily_budget_micros=50_000_000
    assert m.eligible_data(data,m.detect_exceptions(data)) is None


def test_email_error_does_not_expose_secret(data,monkeypatch,caplog):
    monkeypatch.setenv('RESEND_API_KEY','test-private-value')
    data.campaigns[0].platform_target_cpa_micros=None
    def error(*args): raise RuntimeError('secret=test-private-value')
    monkeypatch.setattr(m,'send_alert_email',error)
    assert m.notify_exceptions(data,m.detect_exceptions(data)).status=='failed'
    assert 'test-private-value' not in caplog.text
