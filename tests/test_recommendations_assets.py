"""Règles de rentabilité et ressources réelles : aucun appel réseau."""
import base64
import io
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4
from PIL import Image

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main as m


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("ALERT_STATE_DB", str(tmp_path / "alerts.sqlite3"))
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-unused")
    monkeypatch.setenv("WEBHOOK_TOKEN", "test-only-" + "x" * 32)
    monkeypatch.delenv("IMAGE_MODEL", raising=False)
    for name in ("WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ALERT_TO",
                 "WHATSAPP_TEMPLATE_NAME", "WHATSAPP_GRAPH_VERSION"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(m, "urlopen", lambda *a, **k: pytest.fail("Appel réseau non simulé"))


def payload():
    now = datetime.now(timezone.utc)
    end = now.date() - timedelta(days=7)
    return m.AdsInput(request_id=uuid4(), customer_id="1234567890", currency="EUR",
        snapshot_at=now, period_start=end-timedelta(days=6), period_end=end,
        conversion_lag_days=7, conversion_tracking_ok=True, account_timezone="UTC",
        today_spend_date=now.date(), reference_period_start=end-timedelta(days=13),
        reference_period_end=end-timedelta(days=7), max_total_daily_budget_micros=100_000_000,
        campaigns=[m.Campaign(campaign_id="111", channel_type="SEARCH", status="ENABLED",
            budget_id="222", budget_type="DAILY", budget_shared=False,
            daily_budget_micros=100_000_000, budget_unchanged_during_period=True,
            target_cpa_micros=30_000_000, platform_target_cpa_micros=30_000_000,
            cost_micros=500_000_000, conversions=12, conversion_value_micros=1_000_000_000,
            previous_cost_micros=500_000_000, previous_conversion_value_micros=1_000_000_000,
            today_cost_micros=0, search_budget_lost_impression_share=0.15)],
        keywords=[])


def recommendation(kind="SITELINK_ASSET", **changes):
    fields = dict(resource_name="customers/1234567890/recommendations/999", campaign_id="111",
        type=kind, base_cost_micros=10_000_000, potential_cost_micros=10_000_000,
        base_conversions=10, potential_conversions=11)
    return m.GoogleRecommendation(**{**fields, **changes})


def test_only_proven_sitelinks_and_rotation_are_automatic():
    data = payload().model_copy(update={"recommendations": [recommendation()]})
    assert len(m.safe_recommendation_orders(data, [])) == 1
    data = data.model_copy(update={"recommendations": [recommendation("OPTIMIZE_AD_ROTATION")]})
    assert len(m.safe_recommendation_orders(data, [])) == 1
    for item in (recommendation("CAMPAIGN_BUDGET"),
                 recommendation(potential_cost_micros=10_000_001),
                 recommendation(potential_conversions=10.4),
                 recommendation(base_conversions=None)):
        data = data.model_copy(update={"recommendations": [item]})
        assert m.safe_recommendation_orders(data, []) == []
    data = data.model_copy(update={"recommendations": [recommendation()]})
    alert = m.Alert(code="MISSING_TCPA", campaign_id="111", message="test", suggested_action="test")
    assert m.safe_recommendation_orders(data, [alert]) == []


def test_recommendations_cannot_cross_customer_or_campaign():
    data = payload()
    with pytest.raises(ValueError, match="Recommandation"):
        m.AdsInput.model_validate({**data.model_dump(), "recommendations": [
            recommendation(resource_name="customers/9999999999/recommendations/999").model_dump()]})


def test_google_tag_issue_requires_technical_attention():
    data = payload().model_copy(update={"recommendations": [recommendation("IMPROVE_GOOGLE_TAG_COVERAGE")]})
    assert "GOOGLE_TAG_COVERAGE" in {alert.code for alert in m.detect_exceptions(data)}
    assert not m.safe_recommendation_orders(data, [])


def asset_request(**changes):
    body = dict(request_id=str(uuid4()), customer_id="1234567890", campaign_id="111",
        campaign_type="PERFORMANCE_MAX", brand_name="Marque exemple",
        product_or_service="Entretien de toiture", audience="Propriétaires de maison")
    return {**body, **changes}


def test_real_resource_blocks_generation_and_uses_email_when_whatsapp_unconfigured(monkeypatch):
    captured = []
    monkeypatch.setattr(m, "send_alert_email", lambda subject, text: captured.append((subject, text)))
    monkeypatch.setattr(m, "generate_ad_image", lambda data: pytest.fail("Image interdite"))
    with TestClient(m.app) as client:
        headers = {"Authorization": "Bearer test-only-" + "x" * 32}
        body = asset_request(required_resources=["OFFICIAL_LOGO"])
        first = client.post("/assets/generate", json=body, headers=headers)
        second = client.post("/assets/generate", json=body, headers=headers)
    assert first.status_code == 200 and first.json()["status"] == "blocked"
    assert first.json()["whatsapp_status"] == "unconfigured"
    assert first.json()["email_status"] == "sent"
    assert second.json()["email_status"] == "suppressed"
    assert len(captured) == 1
    assert "OFFICIAL_LOGO" in captured[0][1]


def test_phrase_detection_blocks_real_person_and_exact_brand_chart():
    data = m.AssetRequest(**asset_request(product_or_service="Photo d'identité et charte graphique précise"))
    assert m.missing_real_resources(data) == ["EXACT_BRAND_GUIDELINES", "REAL_PERSON_PHOTO"]


def test_whatsapp_uses_approved_template_payload(monkeypatch):
    for key, value in {"WHATSAPP_ACCESS_TOKEN": "test-secret", "WHATSAPP_PHONE_NUMBER_ID": "123456789",
                       "WHATSAPP_ALERT_TO": "33612345678", "WHATSAPP_TEMPLATE_NAME": "ads_resource_request",
                       "WHATSAPP_GRAPH_VERSION": "v25.0"}.items():
        monkeypatch.setenv(key, value)
    captured = {}
    class Reply:
        def __enter__(self): return io.BytesIO(b'{"messages":[{"id":"wamid.test"}]}')
        def __exit__(self, *args): return False
    def fake_open(request, timeout):
        captured.update(url=request.full_url, headers=dict(request.header_items()),
                        body=json.loads(request.data), timeout=timeout)
        return Reply()
    monkeypatch.setattr(m, "urlopen", fake_open)
    m.send_resource_whatsapp("Logo officiel requis")
    assert captured["url"].endswith("/123456789/messages")
    assert captured["headers"]["Authorization"] == "Bearer test-secret"
    assert captured["body"]["type"] == "template"
    assert captured["body"]["template"]["name"] == "ads_resource_request"


def test_image_generation_returns_png_when_model_configured(monkeypatch):
    monkeypatch.setenv("IMAGE_MODEL", "gpt-image-2.5-flare")
    image_file = io.BytesIO()
    Image.new("RGB", (1536, 800), "blue").save(image_file, format="PNG")
    png = image_file.getvalue()
    captured = {}
    class Reply:
        def __enter__(self):
            return io.BytesIO(json.dumps({"data": [{"b64_json": base64.b64encode(png).decode()}]}).encode())
        def __exit__(self, *args): return False
    def fake_open(request, timeout):
        captured.update(url=request.full_url, headers=dict(request.header_items()),
                        body=json.loads(request.data), timeout=timeout)
        return Reply()
    monkeypatch.setattr(m, "urlopen", fake_open)
    data = m.AssetRequest(**asset_request())
    model, encoded = m.generate_ad_image(data)
    assert model == "gpt-image-2.5-flare"
    with Image.open(io.BytesIO(base64.b64decode(encoded))) as result_image:
        assert result_image.size == (1200, 628) and result_image.format == "PNG"
    assert captured["body"]["model"] == "gpt-image-2.5-flare"
    assert captured["body"]["size"] == "1536x800"
    assert captured["headers"]["Authorization"] == "Bearer test-only-unused"
