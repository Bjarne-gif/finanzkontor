# Finanzkontor

<img width="2396" height="1193" alt="image" src="https://github.com/user-attachments/assets/adece3ac-1c78-40e5-8532-de121fe8da1b" />

Browserbasiertes Tool für Einnahmen, Kosten und Vermögen – selbst gehostet,
dockerfähig, Daten verschlüsselt. Modularer Aufbau: jede Funktion ist ein
eigener Baustein, alle laufen im selben Rahmen.

**Stand:** v0.5.0 · Stufen 1–2 abgeschlossen, Stufe 3 (Vermögen) — Backend
(Überschussverwendung) **fertig** (Backend + Oberfläche). Ledger: Kategorien &
Posten mit Betrag + Intervall (monatlich/jährlich), Beträge kreuzweise
editierbar, zeilenweises Anlegen direkt in der Tabelle, volle Tastatur-/Tab-
Bedienung, Posten sortieren und ganze Bereiche per Drag verschieben,
Inaktiv/Löschen, Live-Berechnung von Einnahmen/Kosten/Überschuss, Autospeichern
und gemerkter Bearbeitungsstand.

Stufe 2 verteilt den Überschuss auf frei anlegbare **Töpfe** (fester €-Betrag
oder Prozent des Überschusses) und zeigt, was **übrig** bleibt. Wollen die Töpfe
mehr als der Überschuss, wird anteilig gedeckelt (Übrig nie negativ). Die
Aufteilung erscheint rechts neben dem Ledger (Zusammenfassung + Töpfe + Übrig,
je monatlich und jährlich); Töpfe lassen sich anlegen, umbenennen, zwischen €/%
umschalten, per Griff sortieren und löschen. Alles läuft über `/api/split` und
ist damit auch für Auswertungen/KI abfragbar. Persistent gespeichert werden die
Töpfe; Verteilung und Übrig werden live aus Ledger + Töpfen berechnet.

## Schnellstart (Docker)

```bash
cp .env.example .env      # bei Bedarf anpassen (Port, DATA_DIR)
docker compose up -d
```

Dann im Browser: `http://<host>:8000`. Beim ersten Start legst du dein
Passwort fest.

### Lokal ohne Docker (z. B. direkt auf dem Raspberry Pi)

Empfohlen mit virtueller Umgebung (venv) – hält die Abhängigkeiten sauber vom
System getrennt und umgeht das „externally-managed-environment“ neuerer Debian-/
Pi-OS-Versionen:

```bash
python3 -m venv .venv            # virtuelle Umgebung anlegen
source .venv/bin/activate        # aktivieren (Windows: .venv\Scripts\activate)
pip install -r requirements.txt  # Abhängigkeiten IN die venv installieren
python3 app.py                   # starten -> http://localhost:8000
```

Beenden mit `Strg+C`, venv verlassen mit `deactivate`. Beim nächsten Start
genügt `source .venv/bin/activate && python3 app.py`.

> **`python` vs. `python3`:** Auf Raspberry Pi OS / Debian heißt der Interpreter
> `python3` – ein blankes `python` existiert dort oft gar nicht (früher zeigte es
> auf Python 2). Zum Anlegen der venv brauchst du daher `python3`. *Innerhalb*
> einer aktivierten venv zeigen `python` und `python3` beide auf dieselbe
> Python-3-Version – dort ist es egal, welches du nimmst. Im Zweifel: `python3`.

#### Falls beim Einrichten etwas hakt

- **`error: externally-managed-environment`** beim `pip install`: Genau dafür ist
  die venv oben da – installiere *innerhalb* der aktivierten venv, nicht systemweit.
- **`python3 -m venv` fehlt** („No module named venv“): einmalig
  `sudo apt install python3-venv`.
- **`cryptography` will bei sehr neuem Python (3.13/3.14) aus dem Quellcode bauen**
  und bricht ab: entweder Build-Werkzeuge nachrüsten
  (`sudo apt install build-essential libffi-dev`) oder in `requirements.txt` die
  Zeile `cryptography==43.0.1` auf `cryptography>=43.0.1` lockern, damit pip ein
  passendes fertiges Paket zieht. Im Docker-Image (Python 3.12) tritt das nicht auf.

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
modules/ledger/   Baustein Stufe 1 (Ledger: Kategorien, Posten, Summen)
modules/split/    Baustein Stufe 2 (Überschussverwendung: Töpfe + Verteilung)
modules/assets/   Baustein Stufe 3 (Vermögen: Klassen/Positionen, Kennzahlen)
static/           Frontend (SPA): index.html, css/, js/
data/             Private Daten (nicht im Git)
```
