"""Verschlüsselung der gespeicherten Werte (Fernet / AES).

Der Schlüssel liegt als data/secret.key geschützt neben den DB-Dateien.
Wichtig: DB + Keyfile gehören zusammen. Ohne Keyfile sind die Werte nicht
lesbar – beim Backup immer beide zusammen sichern.
"""
import os
import stat

from cryptography.fernet import Fernet

import config

_fernet = None


def _load_key():
    """Keyfile lesen oder beim ersten Start erzeugen (chmod 600)."""
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    if config.KEY_FILE.exists():
        return config.KEY_FILE.read_bytes()
    key = Fernet.generate_key()
    # Erst mit engen Rechten anlegen, dann schreiben.
    fd = os.open(str(config.KEY_FILE), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key)
    try:
        os.chmod(config.KEY_FILE, stat.S_IRUSR | stat.S_IWUSR)  # 600
    except OSError:
        pass
    return key


def _f():
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_key())
    return _fernet


def encrypt(text: str) -> str:
    if text is None:
        text = ""
    return _f().encrypt(text.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    if not token:
        return ""
    return _f().decrypt(token.encode("ascii")).decode("utf-8")


def encrypt_bytes(data: bytes) -> bytes:
    """Ganze Dateien mit demselben Key verschlüsseln (für Vertrags-Dokumente)."""
    return _f().encrypt(data or b"")


def decrypt_bytes(token: bytes) -> bytes:
    return _f().decrypt(token)
