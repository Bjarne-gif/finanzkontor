"""KI-Einstellungen — lesen/schreiben (pro Datenbank).

Speichert in `ai_settings` (Schlüssel/Wert):
  - enabled : "0" | "1"   – KI aktiviert?
  - allowed : JSON-Liste  – freigegebene Bereiche, z. B. ["haushalt","vertraege"]

Defaults einer frischen DB: KI aus, nichts freigegeben. Nicht verschlüsselt
(nur ein Schalter + Bereichsnamen, keine Finanzdaten).
"""
import json

# Bekannte Bereiche (Schlüssel der Kontext-Pakete). Freigaben werden dagegen validiert.
KNOWN_AREAS = ("haushalt", "vermoegen", "vertraege", "partner", "dokumente")


def _get(conn, key, default=None):
    row = conn.execute("SELECT value FROM ai_settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def _set(conn, key, value):
    conn.execute(
        "INSERT INTO ai_settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def read(conn):
    """Aktueller KI-Einstellungsstand mit Defaults."""
    enabled = _get(conn, "enabled", "0") == "1"
    try:
        allowed = json.loads(_get(conn, "allowed", "[]"))
    except (ValueError, TypeError):
        allowed = []
    # nur bekannte Bereiche durchlassen, Reihenfolge stabil
    allowed = [a for a in KNOWN_AREAS if a in allowed]
    return {"enabled": enabled, "allowed": allowed, "known": list(KNOWN_AREAS)}


def write(conn, data):
    """Setzt enabled und/oder allowed (nur die übergebenen Felder)."""
    if "enabled" in data:
        _set(conn, "enabled", "1" if data.get("enabled") else "0")
    if "allowed" in data:
        req = data.get("allowed") or []
        if not isinstance(req, list):
            raise ValueError("allowed muss eine Liste sein.")
        clean = [a for a in KNOWN_AREAS if a in req]   # unbekannte verwerfen
        _set(conn, "allowed", json.dumps(clean))
    conn.commit()
    return read(conn)
