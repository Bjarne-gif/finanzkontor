"""Zentrale Konfiguration. Alles über .env steuerbar, mit sinnvollen Defaults."""
import os
from pathlib import Path

APP_NAME = "Finanzkontor"
APP_VERSION = "0.5.0"
STAGE = "Stufe 3 – Vermögen"

# Verzeichnis für ALLE privaten Daten (DB-Dateien + Keyfile).
# Umzug = einfach diesen Ordner mitnehmen.
DATA_DIR = Path(os.environ.get("DATA_DIR", "./data")).resolve()

# Keyfile für die Verschlüsselung der Werte (liegt bewusst neben den DBs).
KEY_FILE = DATA_DIR / "secret.key"

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
