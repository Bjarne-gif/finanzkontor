"""LLM-Anbindung — kapselnde Adapter-Schicht.

Der Rest des Tools spricht nur mit diesem Modul (`ping()`, später `ask()`), nie
direkt mit einem konkreten LLM-Server. So lässt sich neben Ollama später ein
weiterer Provider (z. B. OpenAI-kompatibel) additiv ergänzen, gesteuert über
`config.AI_PROVIDER` in der .env — ohne den übrigen Code anzufassen.

Bewusst abhängigkeitsfrei: nur Pythons eingebautes urllib, kein `requests`.
"""
import json
import urllib.request
import urllib.error

import config


# ---------------------------------------------------------------------------
# Ollama-Adapter
# ---------------------------------------------------------------------------
def _ollama_ping():
    """Fragt Ollamas /api/tags ab und gibt die installierten Modellnamen zurück."""
    url = config.AI_BASE_URL.rstrip("/") + "/api/tags"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    # Kurzer Timeout: ein toter/abgeschalteter Server soll schnell als offline gelten,
    # nicht erst nach dem langen Anfrage-Timeout.
    with urllib.request.urlopen(req, timeout=min(config.AI_TIMEOUT, 5)) as r:
        data = json.loads(r.read().decode("utf-8"))
    return [m.get("name") for m in data.get("models", []) if m.get("name")]


# Kontextfenster: Ollama schneidet sonst stillschweigend ab (Standard nur 2048/4096 Tokens).
# Wir schätzen den Bedarf und setzen num_ctx passend – begrenzt auf das Maximum des Modells.
_CTX_MAX_CACHE = {}
CTX_FALLBACK_MAX = 32768      # falls das Modell sein Maximum nicht verrät
CTX_MIN = 4096
ANTWORT_RESERVE = 1536        # Platz für die Antwort


def schaetze_tokens(text):
    """Grobe, eher großzügige Schätzung für deutschen Text (~3 Zeichen je Token)."""
    return int(len(text or "") / 3) + 1


BILD_TOKENS = 1600            # grobe Schätzung je mitgeschicktem Bild


def _ollama_show(model):
    """Eckdaten des Modells aus /api/show (zwischengespeichert): Kontext-Maximum, Bildverständnis.

    Nur erfolgreiche Abfragen werden gemerkt – ist Ollama gerade nicht erreichbar,
    wird beim nächsten Mal erneut gefragt.
    """
    if model in _CTX_MAX_CACHE:
        return _CTX_MAX_CACHE[model]
    mx, vision, ok = None, False, False
    try:
        url = config.AI_BASE_URL.rstrip("/") + "/api/show"
        req = urllib.request.Request(url, data=json.dumps({"model": model}).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=min(config.AI_TIMEOUT, 5)) as r:
            data = json.loads(r.read().decode("utf-8")) or {}
        ok = True
        info = data.get("model_info") or {}
        for k, v in info.items():
            if k.endswith(".context_length") and isinstance(v, int):
                mx = v
                break
        caps = data.get("capabilities") or []
        vision = ("vision" in caps or bool(data.get("projector_info"))
                  or any(".vision." in k for k in info))
    except Exception:  # noqa: BLE001 — ohne Angabe gelten die Rückfallwerte
        pass
    res = {"ctx_max": mx or CTX_FALLBACK_MAX, "vision": vision}
    if ok:
        _CTX_MAX_CACHE[model] = res
    return res


def _ollama_ctx_max(model):
    """Maximales Kontextfenster des Modells (aus /api/show)."""
    return _ollama_show(model)["ctx_max"]


def modell_kann_bilder():
    """Versteht das eingestellte Modell Bilder (z. B. llama3.2-vision, qwen2.5vl, gemma3)?"""
    if config.AI_PROVIDER != "ollama":
        return False
    return _ollama_show(config.AI_MODEL)["vision"]


def num_ctx_fuer(text, ctx_max):
    """Passendes num_ctx: Bedarf + Antwort-Reserve, aufgerundet auf 2048er-Schritte, begrenzt."""
    bedarf = schaetze_tokens(text) + ANTWORT_RESERVE
    n = max(CTX_MIN, -(-bedarf // 2048) * 2048)
    return min(n, ctx_max)


def _ollama_ask(system, user, images=None):
    """Schickt System- + Nutzer-Nachricht (optional mit Bildern) an Ollamas /api/chat."""
    url = config.AI_BASE_URL.rstrip("/") + "/api/chat"
    images = list(images or [])
    num_ctx = num_ctx_fuer(system + user + " " * (3 * BILD_TOKENS * len(images)), _ollama_ctx_max(config.AI_MODEL))
    user_msg = {"role": "user", "content": user}
    if images:
        user_msg["images"] = images
    payload = json.dumps({
        "model": config.AI_MODEL,
        "stream": False,
        "options": {"num_ctx": num_ctx},
        "messages": [
            {"role": "system", "content": system},
            user_msg,
        ],
    }).encode("utf-8")
    req = urllib.request.Request(url, data=payload,
                                headers={"Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=config.AI_TIMEOUT) as r:
        data = json.loads(r.read().decode("utf-8"))
    return (data.get("message") or {}).get("content", "").strip()


# Registry der Provider — hier kommt später z. B. "openai" dazu.
_PROVIDERS = {
    "ollama": {"ping": _ollama_ping, "ask": _ollama_ask},
}


SYSTEM_PROMPT = (
    "Du bist Kontor, der Finanz-Assistent der App Finanzkontor. "
    "Du hilfst dem Nutzer, seine eigenen Finanzen zu verstehen und zu planen. "
    "Unten stehen seine freigegebenen Daten vollständig: je Bereich erst die Summen, dann jeder Eintrag einzeln. "
    "Einträge haben Kurz-IDs (z. B. P12, V4, PA2, D7); gleiche ID bedeutet derselbe Eintrag. "
    "Nutze die IDs, um Zusammenhänge herzustellen (z. B. Vertrag V4 gehört zu Haushaltsposten P12 und Partner PA2), "
    "nenne in deiner Antwort aber die Namen, nicht die IDs. "
    "Beträge und Fristen sind bereits von der App berechnet – übernimm sie, statt selbst neu zu rechnen. "
    "Sind Bilder beigefügt, sind es Seiten gescannter Dokumente bzw. Fotos; welches Bild zu welchem Dokument gehört, "
    "steht im Abschnitt Dokumente (z. B. „als Bild 1–2 beigefügt“). "
    "Nutze ausschließlich diese Daten und erfinde keine Zahlen. "
    "Fehlt eine Information (Bereich nicht freigegeben oder leer), sage das offen. "
    "Antworte auf Deutsch, freundlich und knapp. Du änderst nichts an den Daten, du berätst nur."
)


def system_text(context_text):
    """Kompletter System-Text, wie er an das Modell geht (auch für die Vorschau)."""
    return SYSTEM_PROMPT + "\n\n=== Freigegebene Daten ===\n" + (context_text or "(keine Bereiche freigegeben)")


def _model_installed(model, installed):
    """Toleranter Abgleich: 'llama3.2' passt auch auf 'llama3.2:latest'."""
    for m in installed:
        if m == model or m.split(":")[0] == model:
            return True
    return False


# ---------------------------------------------------------------------------
# Öffentliche Schnittstelle
# ---------------------------------------------------------------------------
def ping():
    """Prüft, ob der konfigurierte LLM-Server erreichbar ist. Sendet keine Daten.

    Rückgabe immer ein Dict mit `ok` (bool) und erklärenden Feldern — nie eine
    Exception nach außen, damit der Endpunkt robust bleibt.
    """
    prov = _PROVIDERS.get(config.AI_PROVIDER)
    base = {"provider": config.AI_PROVIDER, "base_url": config.AI_BASE_URL, "model": config.AI_MODEL}
    if not prov:
        return {**base, "ok": False,
                "error": f"Unbekannter AI_PROVIDER '{config.AI_PROVIDER}'. "
                         f"Verfügbar: {', '.join(_PROVIDERS)}."}
    try:
        installed = prov["ping"]()
        return {**base, "ok": True,
                "modell_installiert": _model_installed(config.AI_MODEL, installed),
                "installierte_modelle": installed}
    except urllib.error.URLError as e:
        return {**base, "ok": False, "error": f"LLM-Server nicht erreichbar: {getattr(e, 'reason', e)}"}
    except Exception as e:  # noqa: BLE001 — Verbindungstest soll nie durchschlagen
        return {**base, "ok": False, "error": f"Fehler beim Verbindungstest: {e}"}


def ask(frage, context_text, images=None):
    """Stellt dem lokalen LLM eine Frage mit dem freigegebenen Kontext.

    Gibt ein Dict {ok, antwort|error} zurück. `context_text` ist die vollständige
    Datenübergabe der freigegebenen Bereiche (siehe uebergabe.py, read-only).
    `images`: Base64-JPEGs (Scans/Fotos der Dokumente), nur bei Modellen mit Bildverständnis.
    """
    prov = _PROVIDERS.get(config.AI_PROVIDER)
    if not prov or "ask" not in prov:
        return {"ok": False, "error": f"Provider '{config.AI_PROVIDER}' kann keine Fragen beantworten."}
    system = system_text(context_text)
    try:
        antwort = prov["ask"](system, frage, images) if images else prov["ask"](system, frage)
        if not antwort:
            return {"ok": False, "error": "Das Modell hat keine Antwort geliefert."}
        return {"ok": True, "antwort": antwort}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"LLM-Server nicht erreichbar: {getattr(e, 'reason', e)}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"Fehler bei der Anfrage: {e}"}
