"""Finanzkontor – App-Factory (Stufe 0: Gerüst).

Ein einziger Dienst. SQLite + Fernet, kein extra Container nötig.
"""
from datetime import timedelta

from flask import Flask, jsonify, request, send_from_directory

import config
from core import appstate, auth, db, registry
# Bausteine importieren -> sie registrieren sich in der Registry (Stufe 0: keine).
import modules  # noqa: F401


def create_app():
    app = Flask(__name__, static_folder="static", static_url_path="")
    app.secret_key = appstate.flask_secret()
    app.permanent_session_lifetime = timedelta(days=config.REMEMBER_DAYS)
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
    )

    registry.register_blueprints(app)

    # ---- Oberfläche -------------------------------------------------------
    @app.route("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    # ---- Basis / Version --------------------------------------------------
    @app.get("/api/version")
    def version():
        return jsonify({
            "app": config.APP_NAME,
            "version": config.APP_VERSION,
            "stage": config.STAGE,
        })

    # ---- Zugang -----------------------------------------------------------
    @app.get("/api/session")
    def session_state():
        return jsonify({
            "authenticated": auth.is_authenticated(),
            "setup_needed": auth.setup_needed(),
            "remember_days": config.REMEMBER_DAYS,
        })

    @app.post("/api/setup")
    def setup():
        if not auth.setup_needed():
            return jsonify({"error": "already_setup"}), 400
        data = request.get_json(silent=True) or {}
        try:
            auth.set_password(data.get("password", ""))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        auth.login(remember=bool(data.get("remember")))
        return jsonify({"ok": True})

    @app.post("/api/login")
    def login():
        data = request.get_json(silent=True) or {}
        if not auth.verify_password(data.get("password", "")):
            return jsonify({"error": "Falsches Passwort."}), 401
        auth.login(remember=bool(data.get("remember")))
        return jsonify({"ok": True})

    @app.post("/api/logout")
    def logout():
        auth.logout()
        return jsonify({"ok": True})

    # ---- Datenbank-Auswahl ------------------------------------------------
    @app.get("/api/databases")
    @auth.login_required
    def databases():
        return jsonify({"active": db.active_db(), "files": db.list_databases()})

    @app.post("/api/databases/select")
    @auth.login_required
    def databases_select():
        data = request.get_json(silent=True) or {}
        try:
            active = db.set_active_db(data.get("name", ""))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        return jsonify({"ok": True, "active": active})

    @app.post("/api/databases/create")
    @auth.login_required
    def databases_create():
        data = request.get_json(silent=True) or {}
        try:
            name = db.create_database(data.get("name", ""))
            db.set_active_db(name)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        return jsonify({"ok": True, "active": name, "files": db.list_databases()})

    # ---- Module -----------------------------------------------------------
    @app.get("/api/modules")
    @auth.login_required
    def modules_list():
        return jsonify(registry.public_list())

    # ---- Rehydrate (alles in einem Rutsch) --------------------------------
    @app.get("/api/state")
    @auth.login_required
    def state():
        return jsonify({
            "app": config.APP_NAME,
            "version": config.APP_VERSION,
            "stage": config.STAGE,
            "active_db": db.active_db(),
            "databases": db.list_databases(),
            "modules": registry.public_list(),
            "encrypted": True,
        })

    return app


app = create_app()

if __name__ == "__main__":
    # Nur für lokale Entwicklung. Im Container läuft gunicorn (siehe Dockerfile).
    app.run(host="0.0.0.0", port=int(__import__("os").environ.get("APP_PORT", "8000")),
            threaded=True, debug=True)
