# Finanzkontor — Project Knowledge

## Projekt
Browserbasiertes, **selbst gehostetes** Finanztool (Einnahmen, Kosten, Vermögen). **Flask + SQLite**, Fernet-verschlüsselt, Docker-fähig, läuft auf **Raspberry Pi** (Debian, Python 3.14). **Deutsch** (UI + Kommunikation). Modularer Aufbau: jede Funktion ein eigener Baustein im selben Rahmen. **Aktuelle Version: v0.3.1.** Name **Finanzkontor** bestätigt (über Vermögenskontor/Kontor/Kassenbuch/Bilanz).

## Arbeitsweise (wichtig)
- **Erst Plan/Konzept/Vorschau → Freigabe → dann bauen**, in Stufen mit Zwischentest.
- Neues/Experimentelles **zuerst in eine separate Vorschau-HTML (Mock)**, dort justieren; **erst bei 100 % ins echte Tool**.
- Immer einen **sicheren Rückfall** behalten (alte Dateien / frühere Vorschau).
- Feedback oft per Screenshot, iterativ.

## Backend (fertig, stabil)
- `app.py` (create_app), `config.py` (`DATA_DIR` env, `APP_VERSION="0.3.1"`), `core/{appstate,auth,crypto,db,registry}.py`, `modules/ledger/{api,calc,repo,schema}.py`.
- **Verschlüsselung:** Fernet, Schlüssel als **Keyfile auf dem Pi** (`data/secret.key`, chmod 600, wird bei Bedarf erzeugt) — bewusst so gewählt, damit der Dienst **ohne Passworteingabe nach Reboot durchstartet** (Alternative „Schlüssel aus Passwort ableiten" wurde verworfen). Sensible Werte (Name/Betrag/Notiz) verschlüsselt, Struktur-Felder (Intervall/Status/Tags) klar zum Filtern.
- **Login:** Werkzeug pbkdf2, kein Standard-Passwort (Setup vergibt eigenes, min. 4 Zeichen), **„30 Tage merken"** als signiertes Session-Token (konfigurierbar). Passwort getrennt von der Verschlüsselung. Alle privaten Daten in `data/` (gitignored).
- **Mehrere DBs:** beliebig viele `*.db` in `data/`; im Tool per **minimalistischem Datei-Picker** auswählbar (zeigt gefundene Dateien mit Größe/Datum), neue anlegbar. Aktive DB in `app_state.json`.
- **Migrationen:** DB-`schema_version` getrennt von `APP_VERSION`; `register_migration`, beim Verbinden angewandt.
- **API /api/ledger/state:** `categories[]` {id, kind (income/expense), name, color, sort, monthly, yearly, posten[]}; `posten` {id, category_id, name, amount, interval, active, note, tags, income_role, sort, monthly, yearly}; `totals`. **Nur aktive Posten zählen.**
- **API-Methoden** (`static/js/api.js`, auth): `ledgerState`; `addCategory`/`updateCategory`/`deleteCategory`/`reorderCategories({ids})`; `addPosten`/`updatePosten`/`deletePosten`/`reorderPosten({ids})`. `deleteCategory` wirft ValueError bei nicht-leerer Kategorie → Frontend-Kaskade + In-App-Bestätigung.
- **Betragsparser (deutsch):** Komma=Dezimal, Punkt=Tausender; ein Punkt + genau 3 Ziffern = Tausender (`1.500`→1500), sonst Dezimal. **calc:** monthly = jährlich ? amount/12 : amount; yearly = jährlich ? amount : amount×12 (2 Dez.). **Wichtige Vorsorge:** calc gibt Werte **serientauglich** (nach Zeit/Kategorie gruppierbar) aus — Basis für spätere Diagramme (Stufe 6/7).

## Betrieb / Pi (Homers Vorgaben)
- **Genau 1 Gunicorn-Worker** (aktive DB + Fernet-Key liegen im Prozess-Speicher; mehrere Worker hätten getrennten Zustand), Nebenläufigkeit über Threads.
- **Docker minimalistisch:** max. ~2 Services in Portainer, Netzwerke konfigurierbar, Ziel: Betrieb **hinter Nginx Proxy Manager nur übers NPM-Network** (max. Sicherheit). Alles über `docker-compose`, wenig Konfig-Aufwand.
- **Update einspielen:** nur geänderte Dateien ersetzen (zuletzt `static/js/modules/ledger.js` + `static/css/ledger.css`), `data/` behalten, **Strg+F5**. Rückfall = alte Dateien.
- **Passwort-Reset:** `password_hash` aus `data/app_state.json` entfernen (`secret.key` **nicht** anfassen). GitHub: saubere ZIP nehmen (keine Geheimnisse), Repo privat.
- **Tests intern:** jsdom-Headless (Vorschau via runScripts, echtes Modul via ES-Import + Mock-API), `node --check`, Backend-Smoke über Flask `test_client`.

## Frontend-Grundlagen
- **Modul-Vertrag:** `mount(root, {api, store, toast}) → {unmount}`. Host in `#modules` in `.canvas` (**`.canvas` = Scroll-Container, overflow:auto**; `.app` 100vh grid, Seite scrollt nicht). Event-Bus verbindet Bausteine.
- `render()` liest `data`, baut `.ledger2 > .leftcol (.tablearea mit .rp-Zeilen) + .evalcol`. Hilfsfn `rp(cls, mb, yb, attrs)`. Zeilentypen `.rp.ghead/.row/.ghost/.sum/.spacer`. Beträge = `.rval`-Inputs (`data-m`/`data-y`). **Scroll-Restore** (`canvas.scrollTop=ui.scroll`) läuft **vor** applyFocus/ensureVisible (sonst wird Auto-Scroll überschrieben).

## Design
- **9 Themes** (Default **Graphit**): dunkel — Kontor (Schiefer/Messing), Kobalt, Petrol, Tresor (warmes Champagner-Gold), Konsole (gedämpftes Phosphor-Grün, Terminal), Malve (staubiges Mauve); hell — Papier, Alabaster. (Bernstein wurde entfernt.)
- **Fonts:** Space Grotesk (Display), Inter (Body), JetBrains Mono (Zahlen, tabellarisch, serifenlos, prominent). Für Offline-Pi lokal einbindbar.
- Ruhiger „Instrument/Kontor"-Look, dezenter Akzent, mittlere Dichte, dezentes Punkt-/Kontobuch-Gitter auf der Canvas (kein Zeichenwerkzeug — Finanz-Tool bleibt Fokus). Bewusst nicht die üblichen KI-Defaults.

## Stufe 1 (Ledger) — fertig
Excel-artige Anzeige, kreuzweise editierbare Beträge, zeilenweises Anlegen über Geister-Zeilen (Multi-Draft, localStorage), Tab-Navigation, In-App-Bestätigungen, Posten sortieren (altes natives Drag innerhalb der Kategorie) + ⋯-Menü, Inaktiv/Löschen, Live-Berechnung, Autospeichern, gemerkter Stand. **Sonderrolle** Fonds/Studienunterhalt über `income_role`-Schalter „zählt als Einnahme" vs. „separat als Sparen" (Default: separat). **Tag-Ausschluss** (z. B. `sprit`) als flexible Basis für „ohne Sprit".

## Neu in v0.3.1
**Kategorie-Bereiche verschieben** per Griff (⠿) als schwebende Kopie (Klon `position:fixed`/`z-index:9999`, Original `visibility:hidden`, andere Bereiche machen per transform Platz; vorderkantenbasiertes Einrasten; Grenzen oben/unten; Auto-Scroll am Rand). Klon aus `cloneNode` **plus Übertragen der Live-`.value`** der Inputs (sonst alte Werte). Klon-Hintergrund `var(--bg)` (deckt Durchsicht inaktiver Zeilen ab, kein heller Streifen). `catDrag`/`catSettling`-Absicherung gegen Doppelbild. Persistenz optimistisch + `reorderCategories`. Dazu **Tab-Fokus-Fix** und **Auto-Scroll beim Arbeiten** (ensureVisible; Scroll-Restore neu geordnet + `ui.scroll` mitgezogen).

## Roadmap (Stufen)
- **Stufe 0 — Gerüst** · fertig (Shell, Login, DB-Picker, Themes, Event-Bus).
- **Stufe 1 — Kern-Ledger** · fertig.
- **Stufe 2 — Überschuss-Aufteilung.** Überschuss auf **Investing/Sparen/Freizeit** verteilen + **„Übrig"** (= Überschuss − Summe des Genutzten). Feste Beträge **und** Prozente. **„Ohne Sprit"** (= Überschuss + Sprit, über Tag) und **Überschuss in %** (= Überschuss/Einnahmen). Konzept → Freigabe → bauen.
- **Stufe 3 — Vermögen / Net Worth.** Frei erweiterbare **Asset-Klassen** (Bargeld, Fonds, Aktien, Krypto, Edelmetalle, Immobilie …), gruppiert **liquide vs. Sachwerte**. Positionen je Klasse (Name, Wert, Notiz). Auto: Gesamt, %-Anteile, % von Referenzgruppe (z. B. „Bar"). **Konfigurierbare Prozent-Regeln** (Name + Prozent + Bezug, z. B. „5 % vom Gesamt", „10 % vom Bar") statt fest verdrahtet. Sparen/Investing aus Stufe 2 zeigt hierher. *Offen, erst beim Bau zu klären:* was „% vom Bar wenn abgehend" genau meint; ob 5 %/10 %-Helfer feste Werte oder Regeln sind.
- **Stufe 4 — Verträge & Abos** (Kündigungskandidaten etc.; koppelt an KI-Sparpotenzial).
- **Stufe 5 — Szenarien.**
- **Stufe 6 — Verlauf & Diagramme.** Baut die Diagramm-Vorlagen (Anzeigeschicht auf der serientauglichen calc-Ausgabe), die die KI in Stufe 7 mitbenutzt.
- **Stufe 7 — KI-Modus** (siehe unten).

## Stufe 7 — KI-Modus (lokal, LAN-only)
- **Technik:** lokale Modelle (Ollama/LM Studio/llama.cpp), OpenAI-kompatible API, konfiguriert über **`AI_BASE_URL`/`AI_MODEL` in `.env`**. Daten klein genug für den Kontext, läuft lokal.
- **Sicherheit:** KI **schreibt nie direkt**. (1) Lese-Kontext getrennt vom Schreiben; (2) Änderungen nur über **dieselben validierten Backend-Wege** wie die GUI; (3) **Vorschlag → Bestätigung → Undo** (Vorschau-Diff, erst Klick schreibt). Co-Pilot, kein Autopilot.
- **Bedienung:** **„KI-Modus"-Schalter oben**; an = **schmale, einblendbare Leiste** (rechts angedockt, per Ziehen breiter/schmaler), Zustand (an/aus, Breite) gemerkt/rehydriert; aus = kein verlorener Platz.
- **Können:** Ausgaben-Analyse, Sparpotenzial/Kündigungskandidaten, Zielplanung; aus Alltagssprache Posten als Vorschlag bauen; „markier X als gekündigt" als Vorschlag.
- **Diagramme:** KI *malt* nicht — sie **wählt/konfiguriert** eine Vorlage (`{typ, quelle, von, bis}`), Tool rendert mit **echten DB-Werten**; Chart in der Leiste oder als anpinnbare Karte. Live-Änderungen über Event-Bus. **Einzige schon getroffene Vorsorge:** serientaugliche calc-Ausgabe.

## Bewusst weggelassen (bestätigt)
Sprit-/Sparen-Tags samt Auswertungen (Backend kann's, später optional). UI-Intervalle nur monatlich/jährlich (Backend kann mehr). Posten behalten vorerst das **alte native Ziehen** (nur innerhalb ihrer Kategorie).

## Offene nächste Schritte
1. **Real testen:** v0.3.1 auf dem Pi (Kategorie-Drag, Tab-Fix, Auto-Scroll, Inaktiv-Optik, Live-Werte im Klon).
2. **Blockübergreifendes Posten-Verschieben** (Kosten↔Kosten / Einnahme↔Einnahme). *Offene Konzeptfragen:* (a) Posten weiches Klon-Handle oder altes Ziehen? (b) unzulässige Ablage sichtbar blockieren? *Empfehlung:* weiches Handle + sichtbar blockieren. Zuerst Vorschau → Freigabe.
3. **Stufe 2 — Überschuss-Aufteilung** als nächster großer Baustein: Konzept → Freigabe → bauen.
4. Später/optional: Sprit-/Sparen-Tags samt Auswertungen aktivieren.
