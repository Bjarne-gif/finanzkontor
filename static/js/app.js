/* Finanzkontor – App-Steuerung (Stufe 0).
   Prüft Zugang, rehydriert vom Backend, baut Topbar / DB-Auswahl / Status. */

import { api } from "./api.js";
import { store, bus } from "./store.js";
import { initTheme, renderThemeMenu } from "./themes.js";

const $ = (s) => document.querySelector(s);

/* ---------- Helfer ---------- */
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString("de-DE",
      { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (_) { return iso; }
}
let toastTimer;
export function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 2600);
}

/* ---------- Popover-Verhalten ----------
   Offen-Zustand wird gemerkt, damit die Menüs ein F5 überstehen –
   bis man sie selbst schließt (Trigger nochmal oder Klick daneben). */
const OPENPOP_KEY = "fk_openpop";
function setOpenPop(id) {
  try { id ? localStorage.setItem(OPENPOP_KEY, id) : localStorage.removeItem(OPENPOP_KEY); } catch (_) {}
}
function restoreOpenPop() {
  let id = null;
  try { id = localStorage.getItem(OPENPOP_KEY); } catch (_) {}
  if (!id) return;
  const pop = document.getElementById(id);
  if (pop && (pop.classList.contains("pop") || pop.classList.contains("dbpick"))) {
    document.querySelectorAll(".pop.open, .dbpick.open").forEach((p) => p.classList.remove("open"));
    pop.classList.add("open");
  }
}
function wirePopovers() {
  document.querySelectorAll("[data-pop]").forEach((trigger) => {
    const pop = trigger.closest(".pop, .dbpick");
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = pop.classList.contains("open");
      document.querySelectorAll(".pop.open, .dbpick.open").forEach((p) => p.classList.remove("open"));
      if (!wasOpen) { pop.classList.add("open"); setOpenPop(pop.id); }
      else setOpenPop("");
    });
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".pop.open, .dbpick.open").forEach((p) => p.classList.remove("open"));
    setOpenPop("");
  });
  document.querySelectorAll(".pop-panel, .db-panel").forEach((panel) =>
    panel.addEventListener("click", (e) => e.stopPropagation()));
}

/* ---------- DB-Auswahl ---------- */
export function renderDbPicker(state) {
  const active = state.active_db;
  $("#db-active").textContent = active || "—";

  const list = $("#db-list");
  list.innerHTML = "";
  (state.databases || []).forEach((f) => {
    const item = document.createElement("div");
    item.className = "db-item" + (f.name === active ? " active" : "");
    item.innerHTML = `
      <span class="dot"></span>
      <span class="meta">
        <span class="n">${f.name}</span>
        <span class="s">${fmtBytes(f.size)} · ${fmtDate(f.modified)}</span>
      </span>`;
    item.onclick = () => selectDb(f.name);
    list.appendChild(item);
  });
}

async function selectDb(name) {
  const state = store.get("state");
  if (name === state.active_db) return;
  try {
    await api.selectDb(name);
    await rehydrate();
    bus.emit("db:changed", name);
    toast(`Aktiv: ${name}`);
  } catch (e) { toast(e.message, true); }
}

async function createDb() {
  const input = $("#db-new-name");
  const name = input.value.trim();
  if (!name) return;
  try {
    await api.createDb(name);
    input.value = "";
    await rehydrate();
    bus.emit("db:changed", name);
    toast(`Angelegt: ${name.endsWith(".db") ? name : name + ".db"}`);
  } catch (e) { toast(e.message, true); }
}

/* ---------- Statusleiste ---------- */
function renderStatus(state) {
  $("#s-version").textContent = `v${state.version}`;
  $("#s-stage").textContent = state.stage;
  $("#s-db").textContent = `data/${state.active_db}`;
}

/* ---------- Hauptfläche ---------- */
const mountedPanels = [];

/* ---------- Navigation: Reiter (nur Module MIT Panel) ---------- */
const ACTIVE_TAB_KEY = "fk_active_tab";
const TAB_LABELS = { ledger: "Haushalt", assets: "Vermögen" };

function panelModules(state) {
  return (state.modules || []).filter((m) => m.panel);
}
function activeModule(state) {
  const mods = panelModules(state);
  let id = null;
  try { id = localStorage.getItem(ACTIVE_TAB_KEY); } catch (_) {}
  return mods.find((m) => m.id === id) || mods[0] || null;
}
function tabLabel(m) { return TAB_LABELS[m.id] || m.name; }

function renderTabs(state) {
  const el = $("#nav-tabs");
  if (!el) return;
  const mods = panelModules(state);
  const active = activeModule(state);
  el.innerHTML = mods.map((m) => {
    const on = active && m.id === active.id ? " active" : "";
    return `<span class="tab${on}" data-mod="${m.id}">${tabLabel(m)}` +
      `<span class="uline"><span class="bar"></span><span class="hook"></span></span></span>`;
  }).join("");
  el.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.mod)));
}

function switchTab(id) {
  const state = store.get("state");
  if (!state) return;
  if (!panelModules(state).some((m) => m.id === id)) return;
  try { localStorage.setItem(ACTIVE_TAB_KEY, id); } catch (_) {}
  renderTabs(state);
  renderModules(state);
}

async function renderModules(state) {
  const mountEl = $("#modules");
  // vorheriges Panel sauber abbauen
  mountedPanels.splice(0).forEach((p) => { try { p && p.unmount && p.unmount(); } catch (_) {} });

  const mods = panelModules(state);
  if (!mods.length) {
    mountEl.innerHTML = `
      <div class="empty">
        <span class="badge">${state.stage}</span>
        <h1>Das Fundament steht.</h1>
        <p>Zugang, verschlüsselte Speicherung, DB-Auswahl und die Themes sind fertig.
           Ab hier wachsen die Bausteine – jeder als eigenes Modul, alle im selben Rahmen.</p>
      </div>`;
    return;
  }

  const active = activeModule(state);
  mountEl.innerHTML = "";
  const host = document.createElement("section");
  host.className = "module-host";
  host.dataset.module = active.id;
  mountEl.appendChild(host);
  try {
    const mod = await import("/" + active.panel);
    // mount() liefert { unmount } zurück – DAS merken wir uns (nicht mod.default).
    const inst = await mod.default.mount(host, { api, store, bus, toast });
    if (inst && inst.unmount) mountedPanels.push(inst);
  } catch (e) {
    host.innerHTML = `<p class="muted">Modul „${active.name}" konnte nicht geladen werden.</p>`;
    console.error(e);
  }
}

/* ---------- Rehydrate ---------- */
export async function rehydrate() {
  const state = await api.state();
  store.set("state", state);
  renderDbPicker(state);
  renderStatus(state);
  renderTabs(state);
  renderModules(state);
  return state;
}

/* ---------- Zugang / Views ---------- */
function showGate(mode) {
  $("#app").classList.remove("show");
  const gate = $("#gate");
  gate.classList.add("show");
  const isSetup = mode === "setup";
  $("#gate-sub").textContent = isSetup
    ? "Erstes Einrichten – lege dein Passwort fest."
    : "Willkommen zurück.";
  $("#gate-btn").textContent = isSetup ? "Einrichten & starten" : "Entsperren";
  $("#gate-hint").textContent = isSetup
    ? "Das Passwort schützt den Zugang. Deine Werte liegen verschlüsselt in data/."
    : "";
  gate.dataset.mode = mode;
  $("#gate-err").textContent = "";
  setTimeout(() => $("#gate-pass").focus(), 60);
}

async function showApp() {
  $("#gate").classList.remove("show");
  $("#app").classList.add("show");
  await rehydrate();
  restoreOpenPop();
}

async function submitGate() {
  const mode = $("#gate").dataset.mode;
  const pass = $("#gate-pass").value;
  const remember = $("#gate-remember").checked;
  $("#gate-err").textContent = "";
  try {
    if (mode === "setup") await api.setup(pass, remember);
    else await api.login(pass, remember);
    $("#gate-pass").value = "";
    await showApp();
  } catch (e) {
    $("#gate-err").textContent = e.message || "Fehlgeschlagen.";
    $("#gate-pass").select();
  }
}

async function lock() {
  try { await api.logout(); } catch (_) {}
  showGate("login");
  toast("Gesperrt.");
}

/* ---------- Start ---------- */
async function boot() {
  initTheme();
  renderThemeMenu();
  wirePopovers();

  $("#gate-btn").onclick = submitGate;
  $("#gate-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") submitGate(); });
  $("#db-new-btn").onclick = createDb;
  $("#db-new-name").addEventListener("keydown", (e) => { if (e.key === "Enter") createDb(); });
  $("#lock-btn").onclick = lock;

  try {
    const s = await api.session();
    if (s.setup_needed) showGate("setup");
    else if (!s.authenticated) showGate("login");
    else await showApp();
  } catch (e) {
    showGate("login");
  }
}

document.addEventListener("DOMContentLoaded", boot);
