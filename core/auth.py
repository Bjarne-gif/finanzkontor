"""Zugang: Passwort setzen/prüfen, Session mit '30 Tage merken'.

Passwort-Hashing über Werkzeug (pbkdf2) – bewusst ohne C-Kompilat, damit es
auf ARM/Pi ohne Build-Ärger läuft.
"""
from datetime import datetime, timezone
from functools import wraps

from flask import jsonify, session
from werkzeug.security import check_password_hash, generate_password_hash

from core import appstate


def setup_needed():
    return not appstate.is_setup_done()


def set_password(password: str):
    if not password or len(password) < 4:
        raise ValueError("Passwort muss mindestens 4 Zeichen haben.")
    appstate.set("password_hash", generate_password_hash(password))
    appstate.set("created_at", datetime.now(timezone.utc).isoformat())


def verify_password(password: str) -> bool:
    h = appstate.get("password_hash")
    return bool(h) and check_password_hash(h, password or "")


def login(remember: bool):
    session["auth"] = True
    session.permanent = bool(remember)  # permanent -> Cookie lebt REMEMBER_DAYS lang


def logout():
    session.clear()


def is_authenticated() -> bool:
    return bool(session.get("auth"))


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not is_authenticated():
            return jsonify({"error": "unauthorized"}), 401
        return fn(*args, **kwargs)
    return wrapper
