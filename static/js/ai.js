/* ============================================================
   KI-Integration (Frontend) — Konfiguration, Chat, Reaktor.
   Verdrahtet das AI-Icon, baut das Konfig-Modal (mit der 3D-Münze),
   bindet die Settings-API an (an/aus + Bereichs-Freigabe, pro DB)
   und pflegt den KI-Punkt in der Statusleiste.

   Bewusst gekapselt: app.js ruft nur initAi() / loadSettings() /
   setAiLocked() auf.
   ============================================================ */
import { AREAS, R_DIM, R_BLOCK_OFF, R_SEPIA, R_NSEG, rPol, angleOf, branchLines, PADS, FILLER } from "./ai_shared.js";
import { loadThree, makeCoin3D, readCoinSettings, LS_COIN } from "./ai_coin.js";

const AVAILABLE = AREAS.filter((a) => !a.soon);          // im Backend vorhanden, schaltbar

let _api = null, _bus = null, _toast = null;
let state = { enabled: false, allowed: [], known: AVAILABLE.map((a) => a.id) };
let modalEl = null;

// Münze im Konfig-Fenster (WebGL) + Verbindungszustand für ihre Anzeige
let coin = null, coinTried = false, conn = "check", lastModel = "";
const keysHeld = new Set();

// Chatfenster
let chatEl = null, fabEl = null, chatBuilt = false;
let chatOpen = true, chatPos = null, sending = false;
const LS_OPEN = "fk_ai_chat_open", LS_POS = "fk_ai_chat_pos", LS_CFG = "fk_ai_cfg_open";

// Sperrbildschirm: blendet alles KI-bezogene aus; lockEpoch verwirft Antworten,
// die erst nach dem Sperren eintreffen.
let locked = false, lockEpoch = 0;
// Chatverlauf nur im Speicher, solange entsperrt. Quelle der Wahrheit ist die DB
// (verschlüsselt, F5-fest); beim Sperren wird er aus Speicher und DOM entfernt.
const GREETING = "Hey! Ich sehe nur die Bereiche, die du im KI-Menü freigibst. Frag mich was zu deinen Finanzen.";
let msgs = [];
const reactors = [];   // flache Reaktor-Embleme (Chat-Kopf, minimierter Button, ggf. Ersatz für die Münze)

const $ = (sel, root = document) => root.querySelector(sel);

/* ---------- Öffentliche Init ---------- */
export function initAi({ api, bus, toast }) {
  _api = api; _bus = bus; _toast = toast;

  const btn = $("#ai-btn");
  if (btn) btn.onclick = openModal;

  try { chatOpen = localStorage.getItem(LS_OPEN) !== "0"; } catch (_) {}
  try { chatPos = JSON.parse(localStorage.getItem(LS_POS) || "null"); } catch (_) { chatPos = null; }

  buildModal();
  buildChat();
  wireKeys();

  // Einstellung pro DB laden – beim Start und bei jedem DB-Wechsel
  if (_bus) _bus.on("db:changed", () => loadSettings());
}

/* Nach dem Login / DB-Auswahl aufrufen, damit der Zustand sichtbar wird. */
let _firstLoad = true;
export async function loadSettings() {
  try {
    state = await _api.aiSettings();
    if (!Array.isArray(state.allowed)) state.allowed = [];
    if (!Array.isArray(state.known)) state.known = AVAILABLE.map((a) => a.id);
  } catch (_) {
    state = { enabled: false, allowed: [], known: AVAILABLE.map((a) => a.id) };
  }
  applyState();
  if (!locked) loadHistory();             // Verlauf der aktiven DB (F5-fest, auch nach Entsperren)
  if (_firstLoad) {                       // Konfig-Modal F5-fest wiederherstellen
    _firstLoad = false;
    try { if (localStorage.getItem(LS_CFG) === "1") openModal(); } catch (_) {}
  }
}

/* Aktueller Zustand – für das Chatfenster nützlich. */
export function aiEnabled() { return !!state.enabled; }

/* Vom Sperrbildschirm aufgerufen. Gesperrt = Chat, Button und Konfig
   ausgeblendet, Live-Ping pausiert, Chatverlauf geleert. */
export function setAiLocked(v) {
  locked = !!v;
  if (locked) {
    lockEpoch++;
    closeModal();
    msgs = [];
    wipeChatDom();                        // nichts mehr im DOM/Quelltext
  }
  syncChat();
}

/* ---------- Modal ---------- */
const GEAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm8.2 4.7-.1-2.6 2-1.6-2-3.5-2.5.8-2.2-1.3L14.9 2h-4l-.6 2.5-2.2 1.3-2.5-.8-2 3.5 2 1.6-.1 2.6-1.9 1.6 2 3.5 2.5-.8 2.2 1.3.6 2.5h4l.6-2.5 2.2-1.3 2.5.8 2-3.5-2.1-1.6Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

function buildModal() {
  if (modalEl) return;
  const wrap = document.createElement("div");
  wrap.className = "aik-scrim";
  wrap.innerHTML = `
    <div class="aik-modal" role="dialog" aria-label="KI-Assistent">
      <div class="aik-head"><h2>KI-Assistent</h2><span class="sp"></span><span class="x" data-x>✕</span></div>
      <div class="aik-body">
        <div class="aik-stage" data-stage>
          <div class="aik-coin" data-coin></div>
          <div class="cap"><div class="n">Kontor</div><div class="s" data-stat>—</div></div>
          <button class="aik-gear" data-gear type="button" aria-label="Darstellung der Münze" aria-haspopup="true" aria-expanded="false">${GEAR_SVG}</button>
          <div class="aik-gearpop" data-pop role="menu" hidden>
            <div class="gp-h">Darstellung</div>
            <div class="gp-row"><span>Glasboden mit Elektronik</span><div class="gp-seg" data-set="glass"><button type="button" data-v="an">an</button><button type="button" data-v="aus">aus</button></div></div>
            <div class="gp-row"><span>Werk</span><div class="gp-seg" data-set="werk"><button type="button" data-v="dezent">dezent</button><button type="button" data-v="kraeftig">kräftig</button></div></div>
          </div>
        </div>
        <div class="aik-side" data-side>
          <div class="aik-master">
            <div class="t"><div class="l">KI aktivieren</div><div class="s" data-sub>—</div></div>
            <div class="aik-sw" data-master role="switch" tabindex="0" aria-label="KI aktivieren"></div>
          </div>
          <div class="aik-sec">
            <h3>Welche Bereiche darf Kontor sehen?</h3>
            <div class="aik-mods" data-mods></div>
          </div>
          <div class="aik-count"><b data-cnt>0</b> von ${AVAILABLE.length} Bereichen freigegeben.</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  modalEl = wrap;

  // Bereiche-Zeilen (Farbstreifen = Farbe des Strangs); noch nicht verfügbare ausgegraut
  const mods = $("[data-mods]", wrap);
  AREAS.forEach((a) => {
    const row = document.createElement("div");
    row.className = "aik-mod" + (a.soon ? " soon" : "");
    row.dataset.area = a.id;
    row.style.setProperty("--c", a.color);
    row.innerHTML = `<div class="meta"><div class="nm">${a.nm}</div><div class="ds">${a.ds}</div></div><div class="aik-sw"${a.soon ? ' aria-disabled="true"' : ' role="switch" tabindex="0"'} aria-label="${a.nm} freigeben"></div>`;
    if (!a.soon) {
      const sw = row.querySelector(".aik-sw");
      sw.addEventListener("click", () => toggleArea(a.id));
      sw.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleArea(a.id); } });
      row.addEventListener("pointerenter", () => setHover(a.id));
      row.addEventListener("pointerleave", () => setHover(null));
    }
    mods.appendChild(row);
  });

  $("[data-x]", wrap).onclick = closeModal;
  const master = $("[data-master]", wrap);
  master.onclick = toggleMaster;
  master.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleMaster(); } });
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeModal(); });
  wireGearMenu();
}

/* Münze beim ersten Öffnen aufbauen (three.js wird erst dann geladen) */
async function ensureCoin() {
  if (coin || coinTried) return;
  coinTried = true;
  const host = $("[data-coin]", modalEl);
  try { await loadThree(); } catch (_) { /* kein three.js → flacher Reaktor */ }
  mountCoin(host);
  applyState();
}
function mountCoin(host) {
  coin = window.THREE ? makeCoin3D(host, {
    onMaster: () => toggleMaster(),
    onArea: (id) => toggleArea(id),
    onHover: (id) => setHover(id),
    getModel: () => lastModel,
  }) : null;
  if (!coin) {                                  // ohne WebGL: flacher Reaktor als Ersatz
    host.classList.add("fallback");
    const svg = buildReactorSVG(); host.appendChild(svg); reactors.push(host); updateReactors();
  }
}
function rebuildCoin() {
  const host = $("[data-coin]", modalEl); if (!host) return;
  if (coin && coin.destroy) coin.destroy();
  coin = null;
  const i = reactors.indexOf(host); if (i >= 0) reactors.splice(i, 1);
  host.classList.remove("fallback"); host.innerHTML = "";
  mountCoin(host); applyState();
}

/* Zahnrad unten rechts: Darstellung der Münze (im Browser gemerkt) */
function wireGearMenu() {
  const gear = $("[data-gear]", modalEl), pop = $("[data-pop]", modalEl);
  const paint = () => { const c = readCoinSettings();
    pop.querySelectorAll(".gp-seg").forEach((seg) => seg.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.v === c[seg.dataset.set]; b.classList.toggle("sel", on); b.setAttribute("aria-pressed", on); })); };
  const open = (yes) => { pop.hidden = !yes; gear.setAttribute("aria-expanded", yes); if (yes) paint(); };
  gear.addEventListener("click", (e) => { e.stopPropagation(); open(pop.hidden); });
  document.addEventListener("pointerdown", (e) => { if (!pop.hidden && !pop.contains(e.target) && !gear.contains(e.target)) open(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { open(false); gear.focus(); } });
  pop.addEventListener("click", (e) => {
    const b = e.target.closest(".gp-seg button"); if (!b) return;
    const set = b.closest(".gp-seg").dataset.set;
    if (readCoinSettings()[set] === b.dataset.v) return;
    try { localStorage.setItem(LS_COIN[set], b.dataset.v); } catch (_) {}
    readCoinSettings(); paint();
    if (window.THREE) rebuildCoin();
  });
}

/* Pfeiltasten drehen die Münze, solange das Fenster offen ist (nicht beim Tippen) */
function wireKeys() {
  const ARROWS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };
  const push = () => { if (coin) coin.setKeys((keysHeld.has("ArrowRight") ? 1 : 0) - (keysHeld.has("ArrowLeft") ? 1 : 0),
                                              (keysHeld.has("ArrowDown") ? 1 : 0) - (keysHeld.has("ArrowUp") ? 1 : 0)); };
  window.addEventListener("keydown", (e) => {
    if (!ARROWS[e.key] || !coin || locked || !modalEl || !modalEl.classList.contains("open")) return;
    if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
    e.preventDefault(); if (!keysHeld.has(e.key)) { keysHeld.add(e.key); push(); }   // Halten wird im Frame ausgewertet
  });
  window.addEventListener("keyup", (e) => { if (keysHeld.delete(e.key)) push(); });
  window.addEventListener("blur", () => { keysHeld.clear(); push(); });
}

let _hov = null;
function setHover(id) {
  const ok = id && state.enabled && AVAILABLE.some((a) => a.id === id);
  const v = ok ? id : null;
  if (v === _hov) return; _hov = v;
  if (coin) coin.hover(v);
  if (modalEl) modalEl.querySelectorAll(".aik-mod").forEach((row) => row.classList.toggle("hov", row.dataset.area === v));
}

let _pingTimer = null;
function startPingLoop() {
  stopPingLoop();
  pingStatus();
  _pingTimer = setInterval(pingStatus, 5000);   // live prüfen, solange offen
}
function stopPingLoop() {
  if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
}
function openModal() {
  if (locked) return;
  if (!modalEl) buildModal();
  modalEl.classList.add("open");
  try { localStorage.setItem(LS_CFG, "1"); } catch (_) {}
  applyState();
  startPingLoop();            // Verbindungsstatus laufend live halten
  ensureCoin();
}
function closeModal() {
  modalEl && modalEl.classList.remove("open");
  try { localStorage.setItem(LS_CFG, "0"); } catch (_) {}
  stopPingLoop();
  keysHeld.clear(); if (coin) coin.setKeys(0, 0);
  setHover(null);
  const pop = modalEl && $("[data-pop]", modalEl); if (pop) pop.hidden = true;
}

/* ---------- Aktionen ---------- */
async function toggleMaster() {
  const next = !state.enabled;
  state.enabled = next; applyState(); startPingLoop();   // sofort lokal (live) + Status live prüfen
  if (next && coin) coin.ignite();
  try { state = await _api.aiSetSettings({ enabled: next }); }
  catch (e) { state.enabled = !next; applyState(); startPingLoop(); _toast && _toast(e.message || "Speichern fehlgeschlagen", true); return; }
  applyState();
}

async function toggleArea(id) {
  if (!state.enabled) return;                          // bei KI-aus gesperrt
  if (!state.known.includes(id)) return;               // noch nicht verfügbar (ausgegraut)
  const set = new Set(state.allowed);
  const turningOn = !set.has(id);
  turningOn ? set.add(id) : set.delete(id);
  const next = state.known.filter((k) => set.has(k)); // stabile Reihenfolge
  state.allowed = next; applyState();                 // sofort lokal
  if (turningOn && coin) setTimeout(() => coin && coin.hit(), 640);   // Farbe erreicht den Kern
  try { state = await _api.aiSetSettings({ allowed: next }); }
  catch (e) { _toast && _toast(e.message || "Speichern fehlgeschlagen", true); }
  applyState();
}

async function pingStatus() {
  const el = modalEl && $("[data-stat]", modalEl);
  if (!el) return;
  if (!state.enabled) { el.textContent = "aus — keine Daten werden gesendet"; setConn("check"); return; }
  if (conn !== "ok" && conn !== "off") el.textContent = "prüfe Verbindung …";
  try {
    const p = await _api.aiPing();
    if (p.model) lastModel = p.model;
    el.textContent = p.ok ? `verbunden · ${p.model || "?"} · lokal`
                          : `nicht erreichbar${p.error ? " · " + p.error : ""}`;
    setConn(p.ok ? "ok" : "off");
  } catch (_) { el.textContent = "Verbindung unbekannt"; setConn("check"); }
}
function setConn(c) {
  conn = c;
  const st = modalEl && $("[data-stage]", modalEl);
  if (st) { st.classList.toggle("offline", !!state.enabled && c === "off"); st.classList.toggle("ready", !!state.enabled && c === "ok"); }
  if (coin) coin.setState({ enabled: !!state.enabled, allowed: state.allowed, conn });
}

/* ---------- Zustand anwenden (live) ---------- */
function applyState() {
  const on = !!state.enabled;

  // AI-Icon
  const btn = $("#ai-btn"); if (btn) btn.classList.toggle("on", on);

  // Statusleiste
  const stat = $("#s-ai"); if (stat) stat.hidden = false;
  const dot = $("#s-ai-dot"); if (dot) dot.classList.toggle("on", on);

  syncChat();
  updateReactors();
  if (coin) coin.setState({ enabled: on, allowed: state.allowed, conn });

  if (!modalEl) return;
  const master = $("[data-master]", modalEl);
  master.classList.toggle("on", on); master.setAttribute("aria-checked", on);
  $("[data-side]", modalEl).classList.toggle("off", !on);
  $("[data-sub]", modalEl).textContent = on ? "Kontor liest nur mit, ändert nie etwas." : "Solange aus, verlässt nichts die App.";

  const set = new Set(state.allowed);
  modalEl.querySelectorAll(".aik-mod").forEach((row) => {
    const shown = on && set.has(row.dataset.area);      // Variante a: gemerkt, bei KI-aus optisch aus
    row.classList.toggle("on", shown);
    const sw = row.querySelector(".aik-sw"); sw.classList.toggle("on", shown);
    if (!row.classList.contains("soon")) sw.setAttribute("aria-checked", shown);
  });
  $("[data-cnt]", modalEl).textContent = state.allowed.length;
  if (!on) setHover(null);

  const stEl = $("[data-stat]", modalEl);
  if (stEl && !on) stEl.textContent = "aus — keine Daten werden gesendet";
  const stage = $("[data-stage]", modalEl);
  if (stage) { stage.classList.toggle("offline", on && conn === "off"); stage.classList.toggle("ready", on && conn === "ok"); }
}

/* ============================================================
   Chatfenster — global, schwebend, verschiebbar, minimierbar.
   ============================================================ */
function buildChat() {
  if (chatBuilt) return;
  // Fenster
  chatEl = document.createElement("div");
  chatEl.className = "aik-chat";
  chatEl.innerHTML = `
    <div class="chead" data-drag>
      <span class="who"><div class="n">Kontor</div><div class="st">● online · lokal</div></span>
      <span class="aik-clear" data-clear title="Verlauf löschen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 7h14M9 7V5h6v2M6 7l1 13h10l1-13" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="aik-reactor aik-rchip" data-min title="Minimieren"></span>
    </div>
    <div class="cbody" data-body>
      <div class="aik-bub bot">Hey! Ich sehe nur die Bereiche, die du im KI-Menü freigibst. Frag mich was zu deinen Finanzen.</div>
    </div>
    <div class="cin"><input data-in placeholder="Nachricht …"><button data-send>➤</button></div>`;
  document.body.appendChild(chatEl);
  // Reaktor-Button (zugeklappt)
  fabEl = document.createElement("div");
  fabEl.className = "aik-fab aik-rchip";
  fabEl.title = "KI-Chat öffnen";
  document.body.appendChild(fabEl);
  chatBuilt = true;

  // Reaktor-Embleme einsetzen
  [$("[data-min]", chatEl), fabEl].forEach((host) => {
    const svg = buildReactorSVG();
    host.appendChild(svg);
    reactors.push(host);
  });
  updateReactors();

  // Position wiederherstellen (nur wenn wirklich verschoben)
  if (chatPos && typeof chatPos.left === "number") {
    chatEl.style.right = "auto"; chatEl.style.bottom = "auto";
    chatEl.style.left = chatPos.left + "px"; chatEl.style.top = chatPos.top + "px";
  }

  $("[data-min]", chatEl).addEventListener("click", (e) => { e.stopPropagation(); setChatOpen(false); });
  $("[data-clear]", chatEl).addEventListener("click", (e) => { e.stopPropagation(); clearChat(); });
  fabEl.addEventListener("click", () => setChatOpen(true));
  $("[data-send]", chatEl).addEventListener("click", sendChat);
  $("[data-in]", chatEl).addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  wireChatDrag();
}

function syncChat() {
  if (!chatBuilt) return;
  const on = !!state.enabled && !locked;
  if (!on) { chatEl.classList.remove("show"); fabEl.classList.remove("show"); return; }
  chatEl.classList.toggle("show", chatOpen);
  fabEl.classList.toggle("show", !chatOpen);
}

function setChatOpen(open) {
  chatOpen = open;
  try { localStorage.setItem(LS_OPEN, open ? "1" : "0"); } catch (_) {}
  syncChat();
}

/* Verschieben am Kopf, begrenzt auf den Arbeitsbereich (zwischen Top- und Statusleiste) */
function workBounds() {
  const tb = document.querySelector(".topbar");
  const sb = document.querySelector(".statusbar");
  const top = tb ? tb.getBoundingClientRect().bottom + 8 : 12;
  const bottom = sb ? sb.getBoundingClientRect().top - 8 : window.innerHeight - 12;
  return { left: 12, right: window.innerWidth - 12, top, bottom };
}
function wireChatDrag() {
  const head = $("[data-drag]", chatEl);
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".aik-reactor, [data-clear]")) return;   // Reaktor/Papierkorb sind Knöpfe, kein Drag
    const r = chatEl.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    chatEl.style.right = "auto"; chatEl.style.bottom = "auto";
    chatEl.style.left = r.left + "px"; chatEl.style.top = r.top + "px";
    try { head.setPointerCapture(e.pointerId); } catch (_) {}
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const b = workBounds(), w = chatEl.offsetWidth, h = chatEl.offsetHeight;
    const x = Math.max(b.left, Math.min(e.clientX - drag.dx, b.right - w));
    const y = Math.max(b.top, Math.min(e.clientY - drag.dy, Math.max(b.top, b.bottom - h)));
    chatEl.style.left = x + "px"; chatEl.style.top = y + "px";
    chatPos = { left: x, top: y };
  });
  head.addEventListener("pointerup", () => {
    if (drag && chatPos) { try { localStorage.setItem(LS_POS, JSON.stringify(chatPos)); } catch (_) {} }
    drag = null;
  });
}

/* Papierkorb: Verlauf in Anzeige UND Datenbank löschen */
function clearChat() {
  msgs = [];
  renderChat();
  _api.aiClearChat().catch((e) => _toast && _toast(e.message || "Löschen fehlgeschlagen", true));
}

function wipeChatDom() {
  const body = chatEl && $("[data-body]", chatEl);
  if (body) body.innerHTML = "";
}

function renderChat() {
  const body = chatEl && $("[data-body]", chatEl);
  if (!body) return;
  body.innerHTML = "";
  if (locked) return;
  appendBubble("bot", GREETING);
  msgs.forEach((m) => appendBubble(m.cls, m.text));
}

async function loadHistory() {
  const epoch = lockEpoch;
  let list = [];
  try { list = ((await _api.aiChat()) || {}).messages || []; } catch (_) { list = []; }
  if (epoch !== lockEpoch || locked) return;   // inzwischen gesperrt → nichts anzeigen
  msgs = list.map((m) => ({ cls: m.role === "user" ? "me" : "bot", text: m.text }));
  renderChat();
}

/* Nachricht senden → /api/ai/ask */
function appendBubble(cls, text) {
  const b = document.createElement("div");
  b.className = "aik-bub " + cls;
  b.textContent = text;
  const body = $("[data-body]", chatEl);
  body.appendChild(b); body.scrollTop = body.scrollHeight;
  return b;
}
function pushMsg(cls, text) {
  msgs.push({ cls, text });
  return appendBubble(cls, text);
}
async function sendChat() {
  if (sending) return;
  const inp = $("[data-in]", chatEl), v = inp.value.trim();
  if (!v) return;
  sending = true; $("[data-send]", chatEl).disabled = true;
  pushMsg("me", v); inp.value = "";
  const think = appendBubble("bot think", "Kontor denkt …");   // Platzhalter, wird nicht gemerkt
  const epoch = lockEpoch;
  try {
    const r = await _api.aiAsk(v);
    if (epoch !== lockEpoch) return;           // gesperrt: Antwort ist in der DB, erscheint nach dem Entsperren
    think.remove();
    if (r && r.ok) pushMsg("bot", r.antwort);
    else pushMsg("bot err", "⚠ " + ((r && r.error) || "Keine Antwort erhalten."));
  } catch (e) {
    if (epoch !== lockEpoch) return;
    think.remove();
    pushMsg("bot err", "⚠ " + (e.message || "Anfrage fehlgeschlagen."));
  } finally {
    sending = false; $("[data-send]", chatEl).disabled = false; inp.focus();
  }
}

/* ============================================================
   Flacher Reaktor (SVG) — Chat-Kopf (28px), minimierter Button
   (52px) und Ersatz für die Münze ohne WebGL. Gleiche Leiterbahn-
   Formen wie die Münze; noch nicht verfügbare Bereiche ausgegraut.
   ============================================================ */
const SVGNS = "http://www.w3.org/2000/svg";
const R_SOON = "#3a3124";
let _rid = 0;

function rEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function rPts(arr) { return arr.map((p) => p.map((v) => v.toFixed(2)).join(",")).join(" "); }

function rBranch(angle, i, soon) {
  const g = rEl("g", {});
  const col = soon ? R_SOON : R_DIM;
  branchLines(angle, i).forEach((l) => g.appendChild(rEl("polyline", { points: rPts(l.p), class: "rtrace", "stroke-width": "1.25", stroke: col })));
  PADS(angle, i).forEach(([r, a]) => {
    const [x, y] = rPol(r, a);
    g.appendChild(rEl("circle", { cx: x, cy: y, r: "1.35", class: "rpad", fill: col }));
  });
  return g;
}

function buildReactorSVG() {
  const id = "aikr" + (++_rid);
  const svg = rEl("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" });
  svg.dataset.rid = id;
  const defs = rEl("defs", {});
  defs.innerHTML = `
    <filter id="${id}-g" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="${id}-c" x="-150%" y="-150%" width="400%" height="400%">
      <feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <radialGradient id="${id}-h"><stop offset="0%" stop-color="#fff6d8" stop-opacity=".9"/><stop offset="100%" stop-color="#fff6d8" stop-opacity="0"/></radialGradient>`;
  svg.appendChild(defs);

  // Rand-Blöcke (drehen)
  const seg = rEl("g", { class: "rseg" }), R = 44;
  for (let i = 0; i < R_NSEG; i++) {
    const a0 = (i / R_NSEG) * 2 * Math.PI, a1 = a0 + (2 * Math.PI / R_NSEG) * 0.6;
    const x0 = 50 + Math.cos(a0) * R, y0 = 50 + Math.sin(a0) * R, x1 = 50 + Math.cos(a1) * R, y1 = 50 + Math.sin(a1) * R;
    seg.appendChild(rEl("path", { d: `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      fill: "none", "stroke-width": "8", "stroke-linecap": "butt", "data-block": i, stroke: R_BLOCK_OFF }));
  }
  svg.appendChild(seg);

  svg.appendChild(rEl("circle", { cx: 50, cy: 50, r: 37, fill: "none", stroke: R_SEPIA, "stroke-width": "1" }));
  svg.appendChild(rEl("circle", { cx: 50, cy: 50, r: 33, fill: "none", stroke: R_SEPIA, "stroke-width": "0.7" }));
  for (let i = 0; i < 24; i++) {                                          // Perlen, dauerhaft leuchtend
    const [x, y] = rPol(29, i * 15);
    svg.appendChild(rEl("circle", { cx: x, cy: y, r: "1.1", fill: "#ffe9b0", filter: `url(#${id}-g)` }));
  }
  svg.appendChild(rEl("circle", { cx: 50, cy: 50, r: 25, fill: "none", stroke: R_SEPIA, "stroke-width": "0.7" }));

  // je Bereich ein Strang (eigene Form), dazwischen neutrale Füll-Bahnen
  const n = AREAS.length, step = 360 / n;
  AREAS.forEach((a, i) => {
    const g = rBranch(angleOf(i), i, a.soon);
    g.setAttribute("data-area", a.id);
    svg.appendChild(g);
  });
  for (let i = 0; i < n; i++) {
    const a = -90 + i * step + step / 2, fp = FILLER(a);
    svg.appendChild(rEl("polyline", { points: rPts(fp), class: "rtrace", "stroke-width": "0.8", stroke: R_DIM }));
  }

  // Kern
  svg.appendChild(rEl("circle", { cx: 50, cy: 50, r: 5.5, fill: "none", stroke: R_SEPIA, "stroke-width": "0.9" }));
  svg.appendChild(rEl("circle", { cx: 50, cy: 50, r: 8, fill: `url(#${id}-h)`, class: "rhalo" }));
  svg.appendChild(rEl("circle", { cx: 50, cy: 50, r: 3.2, fill: "#fffaf0", filter: `url(#${id}-c)` }));
  return svg;
}

function rMix(cols) {
  let r = 0, g = 0, b = 0;
  cols.forEach((c) => { const n = parseInt(c.slice(1), 16); r += n >> 16 & 255; g += n >> 8 & 255; b += n & 255; });
  const k = cols.length;
  return `rgb(${Math.round(r / k)},${Math.round(g / k)},${Math.round(b / k)})`;
}

/* Zeigt live, welche Bereiche freigegeben sind. */
function updateReactors() {
  if (!reactors.length) return;
  const allowed = new Set(state.enabled ? state.allowed : []);
  const active = AVAILABLE.filter((a) => allowed.has(a.id));
  const n = active.length;
  reactors.forEach((host) => {
    const svg = host.querySelector("svg"); if (!svg) return;
    const id = svg.dataset.rid;
    svg.querySelectorAll("[data-area]").forEach((g) => {
      const area = AREAS.find((a) => a.id === g.dataset.area);
      if (area.soon) return;                                            // bleibt ausgegraut
      const on = allowed.has(area.id);
      g.querySelectorAll(".rtrace").forEach((t) => t.setAttribute("stroke", on ? area.color : R_DIM));
      g.querySelectorAll(".rpad").forEach((p) => p.setAttribute("fill", on ? area.color : R_DIM));
      if (on) g.setAttribute("filter", `url(#${id}-g)`); else g.removeAttribute("filter");
    });
    svg.querySelectorAll("[data-block]").forEach((b, i) => {
      if (!n) { b.setAttribute("stroke", R_BLOCK_OFF); b.removeAttribute("filter"); }
      else { b.setAttribute("stroke", active[i % n].color); b.setAttribute("filter", `url(#${id}-g)`); }
    });
    host.style.setProperty("--aik-glow", n ? rMix(active.map((a) => a.color)) : "#000");
    host.style.setProperty("--aik-energy", (n / AVAILABLE.length).toFixed(2));
  });
}
