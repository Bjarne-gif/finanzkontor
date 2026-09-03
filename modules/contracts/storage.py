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
from core import crypto

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


def _docs_dir():
    config.DOCS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(config.DOCS_DIR, stat.S_IRWXU)  # 700
    except OSError:
        pass
    return config.DOCS_DIR


def save(data: bytes) -> str:
    """Verschlüsselt ablegen, liefert den stored_name zurück."""
    stored = uuid.uuid4().hex + ".enc"
    path = _docs_dir() / stored
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(crypto.encrypt_bytes(data))
    return stored


def read(stored_name: str) -> bytes:
    path = _docs_dir() / stored_name
    return crypto.decrypt_bytes(path.read_bytes())


def delete(stored_name: str):
    if not stored_name:
        return
    path = _docs_dir() / stored_name
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def cleanup_orphans(known_names):
    """Löscht verschlüsselte Dateien, die keine DB-Zeile mehr haben.

    Fängt den Fall ab, dass ein Ledger-Posten gelöscht wurde (DB-Kaskade räumt
    nur die Metadaten). Leichtgewichtig – bei einem Einzelnutzer-Tool sind das
    wenige Dateien."""
    if not config.DOCS_DIR.exists():
        return
    known = set(known_names or [])
    for p in config.DOCS_DIR.glob("*.enc"):
        if p.name not in known:
            try:
                p.unlink()
            except OSError:
                pass
