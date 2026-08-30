"""Vermögens-Baustein (Stufe 3 – Net Worth / Besitz & Schulden).

Registriert Blueprint und Migration v4. Ein eigenes Frontend-Panel folgt im
nächsten Schritt (Reiter „Vermögen"); das Backend steht eigenständig und ist
über /api/assets abfragbar.
"""
from core import registry
from modules.assets.api import bp
from modules.assets.schema import migrate_v4

registry.register("assets", "Vermögen", order=30, blueprint=bp, panel="js/modules/assets.js")
registry.register_migration(4, migrate_v4)
