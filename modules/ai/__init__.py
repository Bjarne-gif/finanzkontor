"""KI-Baustein — Kontext-Layer + Anbindung + Einstellungen.

Registriert den API-Blueprint und Migration v12 (ai_settings). Verdichtet
vorhandene calc-Ausgaben zu Datenpaketen, spricht ein lokales LLM (Ollama) an
und speichert pro DB, ob die KI aktiv ist und welche Bereiche freigegeben sind.
Kein Frontend-Panel (KI ist integriert, kein eigener Reiter).
"""
from core import registry
from modules.ai.api import bp
from modules.ai.schema import migrate_v12, migrate_v13

registry.register("ai", "KI", order=90, blueprint=bp)
registry.register_migration(12, migrate_v12)
registry.register_migration(13, migrate_v13)
