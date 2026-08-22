"""App-Zustand: Passwort-Hash, Flask-Session-Secret, aktive DB.

Liegt als data/app_state.json (nicht im Git). Kein Finanz-Inhalt, daher
unverschlüsselt – der Passwort-Wert ist ohnehin nur ein Hash.
"""
import json
import os
import secrets
from datetime import datetime, timezone

import config

_cache = None


def _now():
    return datetime.now(timezone.utc).isoformat()


def _load():
    global _cache
    if _cache is not None:
        return _cache
    if config.STATE_FILE.exists():
        with open(config.STATE_FILE, "r", encoding="utf-8") as fh:
            _cache = json.load(fh)
    else:
        _cache = {}
    return _cache


def _save():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = str(config.STATE_FILE) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(_cache, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, config.STATE_FILE)


def get(key, default=None):
    return _load().get(key, default)


def set(key, value):
    _load()[key] = value
    _save()


def flask_secret():
    """Stabiler Session-Secret, damit '30 Tage merken' auch Neustarts übersteht."""
    if config.SECRET_SEED:
        return config.SECRET_SEED
    s = get("flask_secret")
    if not s:
        s = secrets.token_hex(32)
        set("flask_secret", s)
    return s


def is_setup_done():
    return bool(get("password_hash"))


def created_at():
    ts = get("created_at")
    if not ts:
        ts = _now()
        set("created_at", ts)
    return ts
