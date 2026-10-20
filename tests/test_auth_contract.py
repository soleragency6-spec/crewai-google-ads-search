"""Vérifier les vrais en-têtes JavaScript avec le serveur FastAPI, sans réseau."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import main as m

TOKEN = "test-only-" + "x" * 32 + "!"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-unused")
    monkeypatch.setenv("WEBHOOK_TOKEN", TOKEN)
    with TestClient(m.app) as value:
        yield value


@pytest.mark.parametrize("filename", ["google_ads_script.js", "google_ads_monitor.js"])
@pytest.mark.parametrize("form", ["raw", "spaced", "prefixed"])
def test_javascript_authorization_accepted_by_fastapi(client, filename, form):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js requis pour le test de contrat JavaScript/FastAPI")
    configured = {"raw": TOKEN, "spaced": "  " + TOKEN + "  ", "prefixed": "Bearer " + TOKEN}[form]
    program = """
const fs = require('node:fs'), vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), context);
vm.runInContext('CONFIG.WEBHOOK_TOKEN=' + JSON.stringify(process.argv[2]), context);
process.stdout.write(JSON.stringify(context.authorizationHeaders_()));
"""
    headers = json.loads(subprocess.check_output(
        [node, "-e", program, str(ROOT / filename), configured], text=True))
    assert headers == {"Authorization": "Bearer " + TOKEN}
    assert client.get("/alerts/config", headers=headers).status_code == 200
    # Corps vide : 422 prouve que l'authentification passe avant la validation,
    # sans analyse CrewAI ni email.
    for endpoint in ["/optimize", "/monitor"]:
        assert client.post(endpoint, headers=headers, json={}).status_code == 422


@pytest.mark.parametrize("headers", [
    {},
    {"WEBHOOK_TOKEN": TOKEN},
    {"X-Webhook-Token": TOKEN},
    {"Authorization": TOKEN},
    {"Authorization": "Bearer Bearer " + TOKEN},
    {"Authorization": "Bearer incorrect"},
])
def test_server_still_rejects_invalid_authentication(client, headers):
    assert client.get("/alerts/config", headers=headers).status_code == 401
    for endpoint in ["/optimize", "/monitor"]:
        assert client.post(endpoint, headers=headers, json={}).status_code == 401
