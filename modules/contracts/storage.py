"""Datei-Ablage für Vertrags-Dokumente.

Dateien werden Fernet-verschlüsselt in DATA_DIR/docs/ gespeichert (zufälliger
Name, .enc). Erlaubt ist eine bewusste Whitelist; potenziell aktive Inhalte
(HTML/SVG) sind ausgeschlossen, weil sie sonst same-origin im Viewer laufen
könnten. PDFs und Bilder werden inline angezeigt, alles andere zum Download.
"""
import mimetypes
import os
import stat
import uuid

import config
from core import crypto, db

MAX_BYTES = 15 * 1024 * 1024  # 15 MB je Datei

# Endung -> (mimetype, inline-anzeigbar?)
ALLOWED = {
    "pdf":  ("application/pdf", True),
    "png":  ("image/png", True),
    "jpg":  ("image/jpeg", True),
    "jpeg": ("image/jpeg", True),
    "webp": ("image/webp", True),
    "gif":  ("image/gif", True),
    "txt":  ("text/plain; charset=utf-8", False),
    "doc":  ("application/msword", False),
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", False),
    "odt":  ("application/vnd.oasis.opendocument.text", False),
    "xls":  ("application/vnd.ms-excel", False),
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", False),
}


def ext_of(filename):
    return (filename.rsplit(".", 1)[-1].lower() if "." in (filename or "") else "")


def is_allowed(filename):
    return ext_of(filename) in ALLOWED


def content_info(filename):
    """(mimetype, inline?) für die Auslieferung."""
    e = ext_of(filename)
    if e in ALLOWED:
        return ALLOWED[e]
    guessed = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return (guessed, False)


def _db_folder():
    """Ordnername der aktiven DB (ohne .db), auf sichere Zeichen reduziert."""
    name = db.safe_name(db.active_db() or "haushalt")
    stem = name[:-3] if name.endswith(".db") else name
    return "".join(c for c in stem if c.isalnum() or c in "-_") or "db"


def _docs_dir():
    """Docs-Ordner der aktiven DB: DATA_DIR/docs/<db>/ (pro DB getrennt)."""
    config.DOCS_DIR.mkdir(parents=True, exist_ok=True)
    d = config.DOCS_DIR / _db_folder()
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(config.DOCS_DIR, stat.S_IRWXU)  # 700
        os.chmod(d, stat.S_IRWXU)
    except OSError:
        pass
    return d


def _resolve(stored_name):
    """Pfad einer bestehenden Datei: erst DB-Ordner, dann alter flacher Ordner (Legacy)."""
    p = _docs_dir() / stored_name
    if p.exists():
        return p
    legacy = config.DOCS_DIR / stored_name
    return legacy if legacy.exists() else p


def save(data: bytes) -> str:
    """Verschlüsselt ablegen, liefert den stored_name zurück."""
    stored = uuid.uuid4().hex + ".enc"
    path = _docs_dir() / stored
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(crypto.encrypt_bytes(data))
    return stored


def read(stored_name: str) -> bytes:
    return crypto.decrypt_bytes(_resolve(stored_name).read_bytes())


def delete(stored_name: str):
    if not stored_name:
        return
    try:
        _resolve(stored_name).unlink()
    except FileNotFoundError:
        pass


def cleanup_orphans(known_names):
    """Löscht verwaiste Dateien **nur im Ordner der aktiven DB**.

    Wird nicht mehr automatisch beim Laden aufgerufen (das löschte früher Dateien
    fremder DBs, s. v0.7.6), sondern gezielt aus der Dateiverwaltung.
    """
    d = _docs_dir()
    if not d.exists():
        return
    known = set(known_names or [])
    for p in d.glob("*.enc"):
        if p.name not in known:
            try:
                p.unlink()
            except OSError:
                pass
