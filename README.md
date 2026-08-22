# Finanzkontor

Browserbasiertes Tool für Einnahmen, Kosten und Vermögen – selbst gehostet,
dockerfähig, Daten verschlüsselt. Modularer Aufbau: jede Funktion ist ein
eigener Baustein, alle laufen im selben Rahmen.

**Stand:** v0.2.0 · Stufe 1 (Ledger). Zusätzlich zum Gerüst: Kategorien &
Posten mit Betrag + Intervall, Live-Berechnung von Einnahmen/Kosten/Überschuss
(inkl. „ohne Sprit“), Autospeichern und gemerkter Bearbeitungsstand.

## Schnellstart (Docker)

```bash
cp .env.example .env      # bei Bedarf anpassen (Port, DATA_DIR)
docker compose up -d
```

Dann im Browser: `http://<host>:8000`. Beim ersten Start legst du dein
Passwort fest.

### Lokal ohne Docker

```bash
pip install -r requirements.txt
python app.py             # http://localhost:8000
```

## Deine Daten liegen in `data/`

Alles Private liegt gebündelt in einem Ordner:

- `data/<name>.db` – deine Datenbank(en)
- `data/secret.key` – Schlüssel zur Entschlüsselung (wird beim 1. Start erzeugt, `chmod 600`)
- `data/app_state.json` – Passwort-Hash, Session-Secret, aktive DB

**Umzug:** einfach den Ordner `data/` auf das neue Gerät kopieren. Fertig.

> **Backup-Hinweis:** DB und `secret.key` gehören **zusammen**. Sicherst du nur
> die `.db` ohne den Schlüssel, sind die Werte unwiederbringlich verschlüsselt.
> Immer beide zusammen sichern.

Nichts davon landet im Git (siehe `.gitignore`) – das Repo bleibt frei von
privaten Daten und GitHub-tauglich.

## Mehrere Datenbanken

Lege beliebig viele `.db`-Dateien in `data/` an (z. B. `haushalt.db`, `2026.db`,
`test.db`). Im Tool wählst du oben rechts aus, welche gerade aktiv ist, oder legst
direkt eine neue an.

## Hinter Nginx Proxy Manager

Für den Betrieb hinter NPM (kein Port nach außen) – siehe Kommentar in
`docker-compose.yml`: `ports` entfernen, externes NPM-Netz eintragen,
Proxy-Host auf `finanzkontor:8000` zeigen.

## Konfiguration (`.env`)

| Variable | Default | Bedeutung |
|---|---|---|
| `APP_PORT` | `8000` | Port nach außen |
| `DATA_DIR` | `./data` | Wo DB + Keyfile liegen |
| `REMEMBER_DAYS` | `30` | Gültigkeit von „merken" |
| `SECRET_SEED` | *(leer)* | Fester Session-Secret; leer = auto in `data/` |
| `REQUIRE_PASSWORD_UNLOCK` | `false` | Später: DB erst nach Passwort entsperren |

## Aufbau

```
app.py            App-Factory + API (Stufe 0)
config.py         Konfiguration aus .env
core/             Kern: auth, crypto, db, appstate, registry (Modul-System)
modules/          Bausteine (ab Stufe 1)
static/           Frontend (SPA): index.html, css/, js/
data/             Private Daten (nicht im Git)
```
