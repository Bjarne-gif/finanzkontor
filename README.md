<img width="2394" height="1193" alt="image" src="https://github.com/user-attachments/assets/279775f7-9c33-4532-9570-40276e793fa7" />

# Finanzkontor

Browserbasiertes Tool für Einnahmen, Kosten und Vermögen – selbst gehostet,
dockerfähig, Daten verschlüsselt. Modularer Aufbau: jede Funktion ist ein
eigener Baustein, alle laufen im selben Rahmen.

**Stand:** v0.12.18 · Stufen 1–5 abgeschlossen (Ledger, Überschussverwendung,
Vermögen, Verträge & Abos, Dateiverwaltung). Ledger: Kategorien &
Posten mit Betrag + Intervall (monatlich/jährlich), Beträge kreuzweise
editierbar, zeilenweises Anlegen direkt in der Tabelle, volle Tastatur-/Tab-
Bedienung, Posten sortieren und ganze Bereiche per Drag verschieben (mit
sauberer Drag-Optik: schwebender Klon, graue Ablagefläche, durchlaufender
Rahmen), Inaktiv/Löschen, Live-Berechnung von Einnahmen/Kosten/Überschuss,
Autospeichern und gemerkter Bearbeitungsstand. Kosten-Posten mit hinterlegtem
Vertrag zeigen ein klickbares Symbol, das direkt in die Vertragsansicht springt.

Stufe 2 verteilt den Überschuss auf frei anlegbare **Töpfe** (fester €-Betrag
oder Prozent des Überschusses) und zeigt, was **übrig** bleibt. Wollen die Töpfe
mehr als der Überschuss, wird anteilig gedeckelt (Übrig nie negativ). Die
Aufteilung erscheint rechts neben dem Ledger (Zusammenfassung + Töpfe + Übrig,
je monatlich und jährlich); Töpfe lassen sich anlegen, umbenennen, zwischen €/%
umschalten, per Griff sortieren und löschen. Alles läuft über `/api/split` und
ist damit auch für Auswertungen/KI abfragbar. Persistent gespeichert werden die
Töpfe; Verteilung und Übrig werden live aus Ledger + Töpfen berechnet.

Stufe 3 (**Vermögen**) verwaltet Besitz/Schulden in Klassen mit 3-Achsen-Profil
(liquide/Risiko/Art), berechnet Netto, Quoten, Notgroschen-Reichweite und
Klumpenrisiko. Stufe 4 (**Verträge & Abos**) hängt ein Vertragsprofil an einen
bestehenden Kosten-Posten (1:1-Bindung), rechnet Kündigungsfristen („Kündigen
bis"), verwaltet Vertragskategorien, Status/Pause und Dokumente. Stufe 5
(**Dateiverwaltung**) bündelt alle Vertragsdokumente in einem Modal mit
eingebettetem PDF-Viewer, Umbenennen und Drag-Umhängen/Sortieren; Dokumente
verwaisen statt zu verschwinden, wenn ein Vertrag entfernt wird.

## App in Docker installieren:

```bash
git clone https://github.com/Bjarne-gif/finanzkontor.git
cd finanzkontor
cp .env.example .env      # bei Bedarf anpassen (Port, DATA_DIR)
docker compose up -d --build
docker compose up -d
```

Dann im Browser: `http://<host>:8000`. Beim ersten Start legst du dein
Passwort fest.

Status in Docker überprüfen:

```bash
docker ps -a      # Zeigt alle Container an (auch gestoppte)
docker stats      # Zeigt die Live-Ressourcennutzung (CPU/RAM) an
```
Um den Container sauber zu löschen:

```bash
cd finanzkontor
docker compose down -v --rmi all
cd ..
sudo rm -rf finanzkontor/
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

## Update auf eine neue Version

Vorher `data/` sichern (DB + `secret.key` gehören zusammen). Dann die neuen
Dateien übernehmen und `docker compose up -d --build`. Datenbank-Migrationen
laufen beim Start automatisch – auch über mehrere Versionen hinweg. Eigene
`docker-compose.yml` und `.env` bleiben unangetastet.

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

Für den Betrieb hinter NPM – siehe Kommentar in `docker-compose.yml`: externes
NPM-Netz (z. B. `npm-network`) eintragen, Proxy-Host auf `finanzkontor:8000`
zeigen, optional `ports` entfernen (dann kein Port nach außen).

## Konfiguration (`.env`)

| Variable | Default | Bedeutung |
|---|---|---|
| `APP_PORT` | `8000` | Port nach außen |
| `DATA_DIR` | `./data` | Wo DB + Keyfile liegen |
| `REMEMBER_DAYS` | `30` | Gültigkeit von „merken" |
| `SECRET_SEED` | *(leer)* | Fester Session-Secret; leer = auto in `data/` |
| `REQUIRE_PASSWORD_UNLOCK` | `false` | Später: DB erst nach Passwort entsperren |
| `AI_PROVIDER` | `ollama` | LLM-Anbieter (aktuell nur Ollama) |
| `AI_BASE_URL` | `http://ollama:11434` | Interne Adresse des LLM-Servers |
| `AI_MODEL` | `llama3.2` | Modellname in Ollama; für Scans/Fotos ein Modell mit Bildverständnis |
| `AI_TIMEOUT` | `400` | Sekunden je KI-Anfrage (lokale Modelle sind langsam) |

## KI-Assistent (lokal)

<img width="261" height="260" alt="image" src="https://github.com/user-attachments/assets/ddf69f56-3b2b-4ffa-b521-3796559b0f80" />
<img width="261" height="260" alt="image" src="https://github.com/user-attachments/assets/0c7fe136-d12b-4027-a78a-f38bc2fc4f8d" />


**Einrichten:** Ollama im selben Docker-Netz wie Finanzkontor betreiben
(Container-Name `ollama`, siehe Kommentar in `docker-compose.yml`), ein Modell
installieren (`docker exec -it ollama ollama pull llama3.2`), die `AI_*`-Werte in
der `.env` prüfen und `docker compose up -d --build`. Danach in der App oben
rechts auf **AI** klicken, die KI einschalten und die Bereiche freigeben.
Verbindung prüfen: eingeloggt `/api/ai/ping` aufrufen (erwartet `ok: true`).

Die KI liest nur, was du im KI-Fenster freigibst, und ändert nie etwas. Zu jeder
Frage bekommt sie die freigegebenen Bereiche vollständig (jeder Eintrag einzeln,
mit Kurz-IDs für die Verknüpfungen). Bereiche: Haushalt, Vermögen, Verträge,
Vertragspartner (alle Felder), Dokumente (Inhalt der Dateien: Text aus PDF,
Word, OpenDocument, Excel, txt; Scans und Fotos als Bild – nur bei Modellen mit
Bildverständnis wie `llama3.2-vision`, `qwen2.5vl`, `gemma3`). Dokumente werden
dafür nur im Arbeitsspeicher entschlüsselt. Was genau rausgeht, zeigt eingeloggt
`/api/ai/uebergabe` im Browser (`?alle=1` zeigt alle Bereiche). Das Kontextfenster
des Modells wird automatisch passend gesetzt.

## Aufbau

```
app.py            App-Factory + API (Stufe 0)
config.py         Konfiguration aus .env
core/             Kern: auth, crypto, db, appstate, registry (Modul-System)
modules/ledger/   Baustein Stufe 1 (Ledger: Kategorien, Posten, Summen)
modules/split/    Baustein Stufe 2 (Überschussverwendung: Töpfe + Verteilung)
modules/assets/   Baustein Stufe 3 (Vermögen: Klassen/Positionen, Kennzahlen)
modules/contracts/ Baustein Stufe 4+5 (Verträge & Abos + Dateiverwaltung, verschlüsselte Dokumente)
modules/ai/       KI-Anbindung (lokal via Ollama): vollständige Datenübergabe (uebergabe.py), Dokument-Inhalte (dokumente.py), Einstellungen, Chat
static/           Frontend (SPA): index.html, css/, js/modules/*.js
static/js/vendor/three.min.js  three.js r128 (MIT) für die 3D-Münze im KI-Fenster, lokal mitgeliefert
data/             Private Daten inkl. data/docs/<db>/ (nicht im Git)
```
