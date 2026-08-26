# Finanzkontor — Project Knowledge

## Projekt
Browserbasiertes, **selbst gehostetes** Finanztool (Einnahmen, Kosten, Vermögen). **Flask + SQLite**, Fernet-verschlüsselt, Docker-fähig, läuft auf **Raspberry Pi** (Debian, Python 3.14). **Deutsch** (UI + Kommunikation). Modularer Aufbau: jede Funktion ein eigener Baustein im selben Rahmen. **Aktuelle Version: v0.4.0.** Name **Finanzkontor** bestätigt (über Vermögenskontor/Kontor/Kassenbuch/Bilanz).

## Arbeitsweise (wichtig)
- **Erst Plan/Konzept/Vorschau → Freigabe → dann bauen**, in Stufen mit Zwischentest.
- Neues/Experimentelles **zuerst in eine separate Vorschau-HTML (Mock)**, dort justieren; **erst bei 100 % ins echte Tool**.
- Immer einen **sicheren Rückfall** behalten (alte Dateien / frühere Vorschau).
- Feedback oft per Screenshot, iterativ.

## Backend (fertig, stabil)
- `app.py` (create_app), `config.py` (`DATA_DIR` env, `APP_VERSION="0.4.0"`), `core/{appstate,auth,crypto,db,registry}.py`, `modules/ledger/{api,calc,repo,schema}.py`, `modules/split/{api,calc,repo,schema}.py` (Stufe 2, **Backend fertig**).
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
Excel-artige Anzeige, kreuzweise editierbare Beträge, zeilenweises Anlegen über Geister-Zeilen (Multi-Draft, localStorage), Tab-Navigation, In-App-Bestätigungen, Posten sortieren und blockübergreifend verschieben (weicher Klon, gleiche Art) + ⋯-Menü, Inaktiv/Löschen, Live-Berechnung, Autospeichern, gemerkter Stand. **Sonderrolle** Fonds/Studienunterhalt über `income_role`-Schalter „zählt als Einnahme" vs. „separat als Sparen" (Default: separat). **Tag-Ausschluss** (z. B. `sprit`) als flexible Basis für „ohne Sprit".

## Neu in v0.4.0 — Stufe 2 komplett (Überschussverwendung)
- **Neues Modul `modules/split/`** (analog `ledger`, Backend stabil): eigene Tabelle `pots` (Töpfe), **Migration v3** (additiv, legt nur die Tabelle an — bestehende Ledger-Daten bleiben unberührt; per Test bestätigt). Sensible Werte (Name, Wert) Fernet-verschlüsselt, Struktur-Felder (Modus `fixed`/`percent`, Sortierung) klar.
- **`calc.compute_split(ueberschuss_monatlich, pots)`**: Zielbetrag je Topf = fester €-Betrag **oder** Prozent des (positiven) Überschusses; bei Überbuchung **proportionale Deckelung** (kein Reihenfolge-Vorrang), **Übrig nie negativ**; bei Überschuss ≤ 0 wird nichts verteilt. Ausgabe **serientauglich** (monatlich **und** jährlich je Topf + in Summe) → direkt für Auswertungen/KI.
- **API `/api/split`** (auth): `GET /state` (liefert Überschuss aus dem Ledger + Töpfe mit verteilten Beträgen + Übrig, alles monatlich/jährlich), `POST /pot`, `PATCH /pot/<id>`, `DELETE /pot/<id>`, `POST /pot/reorder`. Der Überschuss kommt aus **einer Quelle** (Ledger `build_summary`) — keine Doppelrechnung.
- **`api.js`** ergänzt: `splitState`, `addPot`, `updatePot`, `deletePot`, `reorderPots`.
- **Getestet** (Flask `test_client`): Anlegen/Ändern/Löschen/Reorder, Verteilung, proportionale Deckelung, Auth-Schutz, `schema_version=3`, sichere v2→v3-Migration ohne Datenverlust.
- **Frontend eingebaut** (`ledger.js`/`ledger.css`): rechte Spalte ist jetzt die verschmolzene Einheit aus Mock v29 — Zusammenfassung (Einnahmen/Kosten/Überschuss) + **Überschussverwendung** (Töpfe: Name, €/%-Umschalter, Wert, verteilter Betrag, „anteilig"-Markierung bei Deckelung, Griff zum Sortieren, Löschen, „+ Topf hinzufügen") + **Übrig**, je monatlich/jährlich. Verteilung wird **lokal** gerechnet (spiegelt `calc.py`) für flüssige Live-Anzeige beim Tippen; Töpfe werden optimistisch geändert und über `/api/split` persistiert (Muster wie im Ledger). €-Zeichen über getrennten `.cur`-Span ausgerichtet; Summen-Sonderpadding entfernt, sodass alle €-Zeichen auf einer Linie stehen; Spaltenbreiten fest (150px), damit sich bei dynamischen Zahlen nichts verschiebt.
- **Getestet (jsdom, gemockte API):** Render der rechten Spalte, Werte, Töpfe aus dem Backend, Live-Neuberechnung beim Wert-Tippen, €/%-Umschalten, Anlegen/Löschen, saubere unmount.
- **Offene Feinjustage / live zu prüfen:** €-Ausrichtung bei sehr breiten Zahlen (feste 150px-Spalte reicht bis ~99.999,99 €); Randfälle (negativer Überschuss/Verlust, Deckelung optisch, keine Töpfe); ob die feste `plancol`-Breite (524px) neben dem breiter/schmaler werdenden Ledger überall gut sitzt.

## Neu in v0.3.2
**Posten blockübergreifend verschieben** (Kosten↔Kosten / Einnahme↔Einnahme). Das alte native HTML5-Drag der Posten wurde durch **eine** einheitliche Pointer-Engine ersetzt (wie beim Kategorie-Drag): schwebende Kopie (`.pclone`, `position:fixed`), die die **Spaltenbreiten der `.ledger2` erbt** (rechte Spalte bündig) und die Live-`.value` der Inputs übernimmt; Ursprungszeile `display:none`, eine **mitwandernde Einfügemarke** (unsichtbarer Platzhalter `.ph` mit gestricheltem Rahmen, den Spalten folgend) zeigt die Zielposition. Nachbarzeilen gleiten smooth per **kontinuierlichem FLIP** (misst auch mitten in laufender Animation → kein Jitter). **Gesperrte Blöcke** (andere Art) werden ausgegraut, Cursor `not-allowed`, Marke gedämpft; Loslassen dort = Abbruch (Klon gleitet zurück). **Rand-Clamp** oben/unten (kein Zurückspringen, keine toten Zonen), Auto-Scroll am Rand, Escape-Abbruch, `touch-action:none` am Griff (Tablet). **Persistenz:** `updatePosten(category_id)` → `reorderPosten(ids)` (bzw. nur `reorderPosten` bei Sortieren im selben Block), optimistisch mit `refresh()`-Rückfall; **Guard** gegen No-Op-Speichern bei unveränderter Position. **Backend unverändert** — `PATCH category_id` + `reorder` genügen.

## Neu in v0.3.1
**Kategorie-Bereiche verschieben** per Griff (⠿) als schwebende Kopie (Klon `position:fixed`/`z-index:9999`, Original `visibility:hidden`, andere Bereiche machen per transform Platz; vorderkantenbasiertes Einrasten; Grenzen oben/unten; Auto-Scroll am Rand). Klon aus `cloneNode` **plus Übertragen der Live-`.value`** der Inputs (sonst alte Werte). Klon-Hintergrund `var(--bg)` (deckt Durchsicht inaktiver Zeilen ab, kein heller Streifen). `catDrag`/`catSettling`-Absicherung gegen Doppelbild. Persistenz optimistisch + `reorderCategories`. Dazu **Tab-Fokus-Fix** und **Auto-Scroll beim Arbeiten** (ensureVisible; Scroll-Restore neu geordnet + `ui.scroll` mitgezogen).

## Roadmap (Stufen)
- **Stufe 0 — Gerüst** · fertig (Shell, Login, DB-Picker, Themes, Event-Bus).
- **Stufe 1 — Kern-Ledger** · fertig (inkl. blockübergreifendem Posten-Verschieben, v0.3.2).
- **Tags (frei konfigurierbar) — Querschnitt-Baustein.** Eigene Tags anlegen/benennen/färben/löschen als wiederverwendbare Liste (nicht nur der fest gedachte `sprit`-Fall). **Am Posten:** Tags setzen/entfernen (Zeile oder ⋯-Menü). Backend hat `tags`-Feld + Filter schon; es fehlen **UI zum Zuweisen** und eine **Tag-Verwaltung**. *Voraussetzung für* „Ohne X" in Stufe 2 (statt fixem „Ohne Sprit" beliebige „Ohne …"-Ansichten), genutzt auch von Stufe 4 (Verträge/Abos) und Stufe 6 (Diagramme). Entweder als kleiner Vorbau vor/mit Stufe 2 ziehen, oder Stufe 2 baut „Ohne Sprit" vorbereitet-aber-inaktiv bis die Tags da sind. Konzept → Freigabe → bauen.
- **Stufe 2 — Überschussverwendung (Überschuss-Aufteilung).** *Fertig in v0.4.0 (Backend + Oberfläche).* Überschuss auf **Investing/Sparen/Freizeit** verteilen + **„Übrig"** (= Überschuss − Summe des Genutzten). Feste Beträge **und** Prozente. **„Ohne Sprit"** (= Überschuss + Sprit, über Tag — **setzt den Tags-Baustein voraus**; bis dahin vorbereitet/inaktiv) und **Überschuss in %** (= Überschuss/Einnahmen). *Deckelung:* „Übrig" nie negativ; Verteilung bei Überbuchung **proportional runterskalieren** (Reihenfolge-Priorität nur falls bewusst gewünscht) — final am Mock. % beziehen sich auf den vollen Überschuss. Konzept → Freigabe → bauen.
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
Sprit-/Sparen-Tags samt Auswertungen — **jetzt als eigener Baustein „Tags (frei konfigurierbar)" eingeplant** (Backend kann Feld+Filter; UI fehlt). UI-Intervalle nur monatlich/jährlich (Backend kann mehr).

## Offene nächste Schritte
1. **Stufe 2 live testen** auf dem Pi (Töpfe anlegen/ändern/sortieren/löschen, Live-Verteilung, Deckelung, Verlustfall, sehr große Zahlen). Feinjustage der €-Ausrichtung/Spaltenbreiten nur bei Bedarf.
2. **Tags (frei konfigurierbar)** als Querschnitt-Baustein (Voraussetzung für „Ohne Sprit/Ohne X" in Stufe 2). Separat zu besprechen.
2. **Tags (frei konfigurierbar)** als Querschnitt-Baustein: Zuweisungs-UI am Posten + Tag-Verwaltung. Voraussetzung für „Ohne X" (Stufe 2). Konzept → Freigabe → bauen.
3. **Informationsarchitektur / Navigation** klären, bevor Stufe 2 dazukommt: aktuelle zentrierte Ein-Seiten-GUI (Ledger mittig, Zusammenfassung rechts) skaliert nicht für 6–7 Stufen. Optionen: **linke Sidebar-Navigation** (Favorit: skaliert, „Instrument/Kontor"-Charakter, KI-Leiste dockt rechts an), Top-Tabs, oder lange Scroll-Sektionen. *Offen bei Homer.*
4. Später/optional: Tastatur-Verschieben für Posten (Barrierefreiheit).
