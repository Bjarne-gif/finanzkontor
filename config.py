"""Zentrale Konfiguration. Alles über .env steuerbar, mit sinnvollen Defaults."""
import os
from pathlib import Path

APP_NAME = "Finanzkontor"
APP_VERSION = "0.12.18"
STAGE = "KI-Integration"

# Verzeichnis für ALLE privaten Daten (DB-Dateien + Keyfile).
# Umzug = einfach diesen Ordner mitnehmen.
DATA_DIR = Path(os.environ.get("DATA_DIR", "./data")).resolve()

# Keyfile für die Verschlüsselung der Werte (liegt bewusst neben den DBs).
KEY_FILE = DATA_DIR / "secret.key"

# Verschlüsselte Vertrags-Dokumente (PDFs u. a.) – innerhalb DATA_DIR, gitignored.
DOCS_DIR = DATA_DIR / "docs"

# Datei für App-Zustand (Passwort-Hash, Session-Secret, aktive DB).
STATE_FILE = DATA_DIR / "app_state.json"

# Wie lange "30 Tage merken" gilt.
REMEMBER_DAYS = int(os.environ.get("REMEMBER_DAYS", "30"))

# Optionaler fester Flask-Session-Secret. Leer = wird einmalig in data/ erzeugt.
SECRET_SEED = os.environ.get("SECRET_SEED", "").strip()

# Sicherheits-Schalter für später: DB erst nach Passworteingabe entsperren.
# Default aus (Dienst läuft ohne Eingabe durch). Ohne Umbau später hochstufbar.
REQUIRE_PASSWORD_UNLOCK = os.environ.get("REQUIRE_PASSWORD_UNLOCK", "false").lower() == "true"

# Standardname der ersten Datenbank.
DEFAULT_DB_NAME = "haushalt.db"

# --- KI-Anbindung (lokales LLM, LAN-only). Alles über .env steuerbar. ---
# Provider-Weiche: aktuell nur "ollama". Weitere Adapter (z. B. openai-kompatibel)
# lassen sich später additiv nachrüsten, ohne den Rest anzufassen.
AI_PROVIDER = os.environ.get("AI_PROVIDER", "ollama").strip().lower()
# Interne Adresse des LLM-Servers. Am saubersten: LLM-Container im selben Docker-Network,
# dann http und ohne Nginx-Umweg, z. B. http://ollama:11434
AI_BASE_URL = os.environ.get("AI_BASE_URL", "http://ollama:11434").strip()
# Modellname, wie im LLM-Server hinterlegt (z. B. llama3.2, mistral).
AI_MODEL = os.environ.get("AI_MODEL", "llama3.2").strip()
# Timeout für LLM-Anfragen in Sekunden (schwache lokale Modelle können langsam sein).
AI_TIMEOUT = int(os.environ.get("AI_TIMEOUT", "400"))
