"""Aufteilungs-Baustein (Stufe 2 – Überschussverwendung).

Registriert Blueprint und Migration. Ein eigenes Frontend-Panel gibt es
(noch) nicht – die Anzeige läuft vorerst innerhalb des Ledger-Panels; das
Backend steht aber eigenständig und ist über /api/split abfragbar.
"""
from core import registry
from modules.split.api import bp
from modules.split.schema import migrate_v3

registry.register("split", "Überschussverwendung", order=20, blueprint=bp, panel=None)
registry.register_migration(3, migrate_v3)
