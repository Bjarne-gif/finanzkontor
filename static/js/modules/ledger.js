/* Ledger-Panel – Excel-Layout (Stufe 1 komplett).
   Anzeige · Editieren (Beträge kreuzweise, Kommentar/Name, Kategorie) ·
   Anlegen über fließende Geister-Zeilen · Organisieren (Drag/⋯/Inaktiv/Löschen).
   Voll per Tab bedienbar (Kommentar→Name→Monatlich→Jährlich→…→nächster Bereich→Umlauf).
   Speichern läuft über die API; fürs flüssige Tippen wird lokal nachgeführt und
   im Hintergrund persistiert. Backend unverändert. */

const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const dec = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtEUR = (n) => eur.format(n || 0);
const amtStr = (n) => dec.format(n || 0);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Deutsche Konvention (Komma = Dezimal, Punkt = Tausender).
function parse(raw) {
  if (typeof raw === "number") return r2(raw);
  let s = String(raw).trim().replace("€", "").replace(/\s/g, "");
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(".")) {
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
    else { const [h, t] = s.split("."); if (t.length === 3) s = h + t; }
  }
  const v = parseFloat(s);
  if (isNaN(v) || v < 0) throw new Error("Betrag ungültig.");
  return r2(v);
}

function mount(root, ctx) {
  const { api, store, toast } = ctx;
  const dbName = (store.get("state") && store.get("state").active_db) || "db";
  const UIKEY = "fk_ledger_ui_" + dbName;

  let data = null, menuEl = null, dragId = null, confirmEl = null;
  let draftKey = 1, pendingFocus = null;

  let ui = loadUi();
  function loadUi() {
    try { return { drafts: {}, scroll: 0, ...JSON.parse(localStorage.getItem(UIKEY) || "{}") }; }
    catch (_) { return { drafts: {}, scroll: 0 }; }
  }
  const saveUi = debounce(() => { try { localStorage.setItem(UIKEY, JSON.stringify(ui)); } catch (_) {} }, 250);

  root.innerHTML = `<div class="ledger2"><div class="lg-load">Lade …</div></div>`;
  const canvas = root.closest(".canvas");
  const onScroll = debounce(() => { if (canvas) { ui.scroll = canvas.scrollTop; saveUi(); } }, 150);
  if (canvas) canvas.addEventListener("scroll", onScroll, { passive: true });

  async function refresh() { data = await api.ledgerState(); render(); }

  // Lokale Neuberechnung (nach optimistischen Änderungen) – spiegelt das Backend.
  function recompute() {
    let eM = 0, eY = 0, kM = 0, kY = 0;
    for (const c of data.categories) {
      let sm = 0, sy = 0;
      for (const p of c.posten) {
        p.monthly = r2(p.interval === "jaehrlich" ? p.amount / 12 : p.amount);
        p.yearly = r2(p.interval === "jaehrlich" ? p.amount : p.amount * 12);
        if (p.active) { sm += p.monthly; sy += p.yearly; }
      }
      c.monthly = r2(sm); c.yearly = r2(sy);
      if (c.kind === "income") { eM += c.monthly; eY += c.yearly; } else { kM += c.monthly; kY += c.yearly; }
    }
    data.totals = {
      einnahmen: { monthly: r2(eM), yearly: r2(eY) },
      kosten: { monthly: r2(kM), yearly: r2(kY) },
      ueberschuss: { monthly: r2(eM - kM), yearly: r2(eY - kY) },
    };
  }

  const findPosten = (id) => { for (const c of data.categories) for (const p of c.posten) if (p.id === id) return p; return null; };
  const catObj = (cid) => data.categories.find((c) => c.id === cid);
  const catOf = (id) => data.categories.find((c) => c.posten.some((p) => p.id === id));

  // ---- Fokus-Descriptoren (überstehen Neuaufbau) ----
  function descOf(el) {
    if (!el || !el.dataset) return null;
    const d = el.dataset;
    if (d.gk != null) { const f = (String(el.className).match(/g-(?:note|name|m|y)/) || ["g-name"])[0]; return { t: "g", k: +d.gk, f }; }
    if (d.note != null) return { t: "p", id: +d.note, f: "note" };
    if (d.name != null) return { t: "p", id: +d.name, f: "name" };
    if (d.m != null) return { t: "p", id: +d.m, f: "m" };
    if (d.y != null) return { t: "p", id: +d.y, f: "y" };
    if (d.catname != null) return { t: "c", id: +d.catname };
    return null;
  }
  function selByDesc(desc) {
    if (!desc) return null;
    const q = (x) => root.querySelector(x);
    if (desc.t === "g") return q("." + (desc.f || "g-name") + `[data-gk="${desc.k}"]`);
    if (desc.t === "p") return q(`[data-${desc.f}="${desc.id}"]`);
    if (desc.t === "c") return q(`[data-catname="${desc.id}"]`);
    return null;
  }
  const isAmt = (el) => /(?:^|\s)(rval|g-m|g-y)(?:\s|$)/.test(el.className || "");
  function applyFocus() {
    if (!pendingFocus) return;
    const pf = pendingFocus; pendingFocus = null;
    const el = selByDesc(pf.desc); if (!el) return;
    el.focus();
    if (isAmt(el) && el.select) el.select();
    else if (el.setSelectionRange) { try { const L = el.value.length; const c = pf.caret != null ? pf.caret : L; el.setSelectionRange(c, c); } catch (e) {} }
  }

  // ---- Geister-Zeilen (Multi-Draft) ----
  const blank = () => ({ k: draftKey++, note: "", name: "", m: "", y: "", src: "monatlich" });
  const hasContent = (d) => !!((d.name || "").trim() || (d.note || "").trim() || (d.m || "").trim() || (d.y || "").trim());
  function normDrafts(cid) {
    let a = (ui.drafts[cid] || []).filter((d, i, arr) => i === arr.length - 1 || hasContent(d));
    if (a.length === 0 || hasContent(a[a.length - 1])) a = a.concat([blank()]);
    ui.drafts[cid] = a;
  }
  const getDraft = (cid, k) => (ui.drafts[cid] || []).find((x) => x.k === k);
  function maybeSpawn(cid, k, field, caret) {
    const arr = ui.drafts[cid] || [];
    const isLast = arr.length && arr[arr.length - 1].k === k;
    const d = getDraft(cid, k);
    if (isLast && d && hasContent(d)) { pendingFocus = { desc: { t: "g", k, f: field }, caret }; render(); }
  }

  function colWidths() {
    const CH = 0.63; let mpx = 0, ypx = 0, empx = 0, eypx = 0;
    for (const c of data.categories) {
      for (const p of c.posten) { mpx = Math.max(mpx, fmtEUR(p.monthly).length * 13.5 * CH); ypx = Math.max(ypx, fmtEUR(p.yearly).length * 13.5 * CH); }
      mpx = Math.max(mpx, fmtEUR(c.monthly).length * 14 * CH); ypx = Math.max(ypx, fmtEUR(c.yearly).length * 14 * CH);
    }
    const t = data.totals;
    empx = Math.max(fmtEUR(t.einnahmen.monthly).length, fmtEUR(t.kosten.monthly).length) * 13 * CH;
    eypx = Math.max(fmtEUR(t.einnahmen.yearly).length, fmtEUR(t.kosten.yearly).length) * 13 * CH;
    empx = Math.max(empx, fmtEUR(t.ueberschuss.monthly).length * 20 * CH);
    eypx = Math.max(eypx, fmtEUR(t.ueberschuss.yearly).length * 20 * CH);
    return { mw: Math.max(92, Math.round(mpx) + 20), yw: Math.max(100, Math.round(ypx) + 22), emw: Math.max(150, Math.round(empx) + 22), eyw: Math.max(184, Math.round(eypx) + 24) };
  }

  const rp = (cls, mb, yb, attrs = "") => `<div class="rp ${cls}" ${attrs}><div class="mbox">${mb}</div><div class="ybox">${yb}</div></div>`;
  const valCell = (kind, p) => {
    const isSrc = kind === "m" ? p.interval !== "jaehrlich" : p.interval === "jaehrlich";
    const num = kind === "m" ? p.monthly : p.yearly;
    return `<input class="rval${isSrc ? "" : " drv"}" data-${kind}="${p.id}" inputmode="decimal" value="${fmtEUR(num)}" />`;
  };

  function renderEval(empty) {
    if (empty) return `<div class="evalwrap"><div class="ebox ebox-emain"></div><div class="ebox ebox-eyear"></div></div>`;
    const t = data.totals, uM = t.ueberschuss.monthly, uY = t.ueberschuss.yearly;
    const state = uM > 0 ? "surplus" : (uM < 0 ? "loss" : "zero"), lbl = uM < 0 ? "Verlust" : "Überschuss";
    const mc = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "zero");
    const main = `<div class="evalbox evalmain ${state}">`
      + `<div class="er first"><span class="ek"></span><span class="em hdl">Monatlich</span></div><div class="er spacer"></div>`
      + `<div class="er"><span class="ek">Einnahmen</span><span class="em pos">${fmtEUR(t.einnahmen.monthly)}</span></div>`
      + `<div class="er"><span class="ek">Kosten</span><span class="em neg">${fmtEUR(t.kosten.monthly)}</span></div><div class="er spacer"></div>`
      + `<div class="er sum"><span class="ek">${lbl}</span><span class="em ${mc(uM)}">${fmtEUR(uM)}</span></div></div>`;
    const year = `<div class="evalbox evalyear ${state}">`
      + `<div class="er first"><span class="ey hdl">Jährlich</span></div><div class="er spacer"></div>`
      + `<div class="er"><span class="ey pos">${fmtEUR(t.einnahmen.yearly)}</span></div>`
      + `<div class="er"><span class="ey neg">${fmtEUR(t.kosten.yearly)}</span></div><div class="er spacer"></div>`
      + `<div class="er sum"><span class="ey ${mc(uY)}">${fmtEUR(uY)}</span></div></div>`;
    return `<div class="evalwrap">${main}${year}</div>`;
  }

  function render() {
    const cats = data.categories, empty = cats.length === 0, w = colWidths();
    let html = "";
    if (empty) {
      html = `<div class="emptyrow"><div class="ebox ebox-main"><span>Noch keine Bereiche. Lege unten einen an.</span></div><div class="ebox ebox-year"></div></div>`;
    } else {
      html = rp("first hd", `<span class="mGrip"></span><span class="mInfo">Information</span><span class="mName">Posten</span><span class="mAmt">Monatlich</span><span class="mMenu"></span>`, `<span class="yhd">Jährlich</span>`);
      html += rp("spacer", "", "");
      cats.forEach((c, ci) => {
        html += rp("ghead grp-" + c.kind, `<span class="mGrip"></span><span class="ghfull"><span class="dot"></span><input data-catname="${c.id}" value="${esc(c.name)}" /></span><span class="mMenu"><button class="catdel" data-catdel="${c.id}" title="Bereich löschen" tabindex="-1">×</button></span>`, "");
        c.posten.forEach((p) => {
          html += rp("row " + (p.active ? "" : "inactive"),
            `<span class="mGrip" draggable="true" data-grip="${p.id}">⠿</span>`
            + `<span class="mInfo cInfo"><input data-note="${p.id}" value="${esc(p.note || "")}" placeholder="Kommentar…" /></span>`
            + `<span class="mName cName"><input data-name="${p.id}" value="${esc(p.name)}" /></span>`
            + `<span class="mAmt">${valCell("m", p)}</span>`
            + `<span class="mMenu"><button class="dots" data-menu="${p.id}" tabindex="-1">⋯</button></span>`,
            `<span class="yw">${valCell("y", p)}</span>`,
            `data-cat="${c.id}" data-id="${p.id}"`);
        });
        normDrafts(c.id);
        (ui.drafts[c.id] || []).forEach((gd) => {
          html += rp("ghost",
            `<button class="mGrip gplus" data-gadd="${c.id}" data-gk="${gd.k}" title="Posten anlegen" tabindex="-1">+</button>`
            + `<span class="mInfo cInfo"><input class="g-note" data-gc="${c.id}" data-gk="${gd.k}" placeholder="Kommentar…" value="${esc(gd.note || "")}" /></span>`
            + `<span class="mName cName"><input class="g-name" data-gc="${c.id}" data-gk="${gd.k}" placeholder="Neuer Posten…" value="${esc(gd.name || "")}" /></span>`
            + `<span class="mAmt"><input class="g-m" data-gc="${c.id}" data-gk="${gd.k}" inputmode="decimal" placeholder="0,00" value="${esc(gd.m || "")}" /></span>`
            + `<span class="mMenu"></span>`,
            `<span class="yw"><input class="g-y" data-gc="${c.id}" data-gk="${gd.k}" inputmode="decimal" placeholder="0,00" value="${esc(gd.y || "")}" /></span>`);
        });
        const isLast = ci === cats.length - 1, scls = c.kind === "income" ? "pos" : "neg";
        html += rp("sum" + (isLast ? " last" : ""), `<span class="mGrip"></span><span class="mInfo sumlbl">Summe</span><span class="mName"></span><span class="mAmt"><span class="sumv ${scls}">${fmtEUR(c.monthly)}</span></span><span class="mMenu"></span>`, `<span class="yw"><span class="sumv ${scls}">${fmtEUR(c.yearly)}</span></span>`);
        if (!isLast) html += rp("spacer", "", "");
      });
    }
    html += `<div class="xaddcat"><button data-addcat="income">+ Einnahme-Kategorie</button><button data-addcat="expense">+ Kosten-Kategorie</button></div>`;

    root.innerHTML = `<div class="ledger2" style="--mw:${w.mw}px;--yw:${w.yw}px;--emw:${w.emw}px;--eyw:${w.eyw}px"><div class="leftcol"><div class="areatitle">Einzelpositionen</div><div class="tablearea">${html}</div></div><div class="evalcol"><div class="areatitle">Zusammenfassung</div>${renderEval(empty)}</div></div>`;
    wire();
    applyFocus();
    if (canvas && ui.scroll) canvas.scrollTop = ui.scroll;
  }

  // ---- Anlegen (Geister-Zeile) ----
  async function commitDraft(cid, k, opts) {
    const arr = ui.drafts[cid] || [];
    const d = getDraft(cid, k); if (!d) return;
    const n = (d.name || "").trim(); if (!n) return;
    const src = d.src || "monatlich";
    let amount; try { amount = parse((src === "jaehrlich" ? d.y : d.m) || "0"); } catch (e) { toast(e.message, true); return; }
    let id;
    try { const res = await api.addPosten({ category_id: cid, name: n, amount, interval: src, note: d.note || "" }); id = res && res.id; }
    catch (e) { toast(e.message, true); return; }
    const idx = arr.findIndex((x) => x.k === k); if (idx >= 0) arr.splice(idx, 1);
    const c = catObj(cid);
    if (c) {
      const maxSort = c.posten.reduce((m, p) => Math.max(m, p.sort || 0), -1);
      c.posten.push({ id, category_id: cid, name: n, amount, interval: src, active: true, note: d.note || "", tags: "", income_role: c.kind === "income" ? "einnahme" : null, sort: maxSort + 1, monthly: 0, yearly: 0 });
    }
    if (opts && opts.desc) pendingFocus = { desc: opts.desc };
    else if (opts && opts.focusTrailing) { normDrafts(cid); const t = ui.drafts[cid][ui.drafts[cid].length - 1]; pendingFocus = { desc: { t: "g", k: t.k, f: "g-name" } }; }
    saveUi(); recompute(); render();
  }

  // ---- Sortieren ----
  function afterRow(cat, y) {
    const rows = [...root.querySelectorAll(`.rp.row[data-cat="${cat}"]:not(.dragging)`)];
    return rows.reduce((cl, ch) => { const b = ch.getBoundingClientRect(); const off = y - b.top - b.height / 2; return off < 0 && off > cl.o ? { o: off, el: ch } : cl; }, { o: -Infinity, el: null }).el;
  }
  async function commitOrder(cat) {
    const ids = [...root.querySelectorAll(`.rp.row[data-cat="${cat}"]`)].map((r) => +r.dataset.id);
    try { await api.reorderPosten(ids); await refresh(); } catch (e) { toast(e.message, true); await refresh(); }
  }
  async function move(id, dir) {
    const c = catOf(id); if (!c) return;
    const ids = c.posten.map((p) => p.id); const i = ids.indexOf(id), j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api.reorderPosten(ids); await refresh(); } catch (e) { toast(e.message, true); }
  }

  // ---- ⋯-Menü ----
  function closeMenu() { if (menuEl) { const m = menuEl; m.classList.remove("open"); setTimeout(() => m.remove(), 150); menuEl = null; } }
  function openMenu(id, btn) {
    closeMenu(); const p = findPosten(id); if (!p) return;
    const items = [["up", "↑ Nach oben"], ["down", "↓ Nach unten"], ["sep"], ["active", p.active ? "Inaktiv setzen" : "Aktiv setzen"], ["sep"], ["del", "Löschen", "danger"]];
    const m = document.createElement("div"); m.className = "ctx";
    m.innerHTML = items.map((it) => it[0] === "sep" ? '<div class="sep"></div>' : `<button data-a="${it[0]}" class="${it[2] || ""}">${it[1]}</button>`).join("");
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect(); m.style.top = r.bottom + 6 + "px"; m.style.left = Math.max(8, Math.min(r.left - 148, window.innerWidth - 186)) + "px";
    requestAnimationFrame(() => m.classList.add("open")); menuEl = m;
    m.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a; closeMenu();
      try {
        if (a === "up") await move(id, -1);
        else if (a === "down") await move(id, 1);
        else if (a === "active") { await api.updatePosten(id, { active: !p.active }); await refresh(); }
        else if (a === "del") { await api.deletePosten(id); await refresh(); }
      } catch (err) { toast(err.message, true); }
    });
  }

  // ---- In-App-Bestätigung (kein Browser-Dialog; übersteht F5) ----
  function removeConfirm() { if (confirmEl) { if (confirmEl._esc) document.removeEventListener("keydown", confirmEl._esc); confirmEl.remove(); confirmEl = null; } }
  function renderConfirm() {
    removeConfirm(); const p = ui.pendingConfirm; if (!p) return;
    const ov = document.createElement("div"); ov.className = "fk-modal-ov";
    ov.innerHTML = `<div class="fk-modal" role="dialog" aria-modal="true"><div class="fk-modal-msg">${esc(p.message)}</div><div class="fk-modal-act"><button class="fk-mbtn" data-mc="cancel">Abbrechen</button><button class="fk-mbtn danger" data-mc="ok">Löschen</button></div></div>`;
    document.body.appendChild(ov); confirmEl = ov;
    const close = (ok) => { const pend = ui.pendingConfirm; delete ui.pendingConfirm; saveUi(); removeConfirm(); if (ok && pend) dispatchConfirm(pend); };
    ov.addEventListener("click", (e) => { if (e.target === ov) return close(false); const b = e.target.closest("[data-mc]"); if (!b) return; close(b.dataset.mc === "ok"); });
    ov._esc = (e) => { if (e.key === "Escape") close(false); };
    document.addEventListener("keydown", ov._esc);
    const db = ov.querySelector(".danger"); if (db) db.focus();
  }
  function dispatchConfirm(p) { if (p.kind === "deleteCategory") doDeleteCategory(p.cid); }
  function requestDeleteCategory(cid) {
    const c = catObj(cid); if (!c) return; const n = c.posten.length;
    if (n === 0) { doDeleteCategory(cid); return; }
    ui.pendingConfirm = { kind: "deleteCategory", cid, message: `Bereich „${c.name}“ inklusive ${n} Posten löschen?` };
    saveUi(); renderConfirm();
  }
  async function doDeleteCategory(cid) {
    const c = catObj(cid);
    try { if (c) for (const p of c.posten) await api.deletePosten(p.id); await api.deleteCategory(cid); delete ui.drafts[cid]; saveUi(); await refresh(); }
    catch (e) { toast(e.message, true); await refresh(); }
  }

  function wire() {
    // Kategorie
    root.querySelectorAll("[data-addcat]").forEach((b) => b.addEventListener("click", async () => {
      try { await api.addCategory({ kind: b.dataset.addcat, name: b.dataset.addcat === "income" ? "Neue Einnahmen" : "Neue Kosten" }); await refresh(); } catch (e) { toast(e.message, true); }
    }));
    root.querySelectorAll("[data-catname]").forEach((inp) => inp.addEventListener("change", () => {
      const c = catObj(+inp.dataset.catname); if (c) c.name = inp.value;
      api.updateCategory(+inp.dataset.catname, { name: inp.value }).catch((e) => { toast(e.message, true); refresh(); });
    }));
    root.querySelectorAll("[data-catdel]").forEach((b) => b.addEventListener("click", () => requestDeleteCategory(+b.dataset.catdel)));

    // Kommentar / Name (lokal + Hintergrund-Speichern, kein Neuaufbau)
    root.querySelectorAll("[data-note]").forEach((inp) => inp.addEventListener("input", () => { const p = findPosten(+inp.dataset.note); if (p) p.note = inp.value; saveNote(+inp.dataset.note, inp.value); }));
    root.querySelectorAll("[data-name]").forEach((inp) => inp.addEventListener("input", () => { const p = findPosten(+inp.dataset.name); if (p) p.name = inp.value; saveName(+inp.dataset.name, inp.value); }));

    // Beträge (direkt editierbar)
    root.querySelectorAll(".rval").forEach((inp) => {
      const kind = inp.dataset.m != null ? "m" : "y";
      const id = +(kind === "m" ? inp.dataset.m : inp.dataset.y);
      const row = inp.closest(".rp");
      const other = kind === "m" ? row.querySelector(".rval[data-y]") : row.querySelector(".rval[data-m]");
      inp.addEventListener("focus", () => inp.select());
      inp.addEventListener("input", () => { try { const v = parse(inp.value); if (other) other.value = kind === "m" ? amtStr(v * 12) : amtStr(v / 12); } catch (e) {} });
      inp.addEventListener("keydown", (e) => { const p = findPosten(id); if (e.key === "Enter") { e.preventDefault(); inp.blur(); } else if (e.key === "Escape") { if (p) inp.value = fmtEUR(kind === "m" ? p.monthly : p.yearly); inp.blur(); } });
      inp.addEventListener("blur", () => {
        const p = findPosten(id); if (!p) return;
        const cur = kind === "m" ? p.monthly : p.yearly;
        let v; try { v = parse(inp.value); } catch (e) { toast(e.message, true); inp.value = fmtEUR(cur); return; }
        if (Math.abs(v - cur) < 0.005) { inp.value = fmtEUR(cur); return; }
        p.amount = v; p.interval = kind === "m" ? "monatlich" : "jaehrlich";
        pendingFocus = { desc: descOf(document.activeElement) };
        recompute(); render();
        api.updatePosten(id, { amount: v, interval: p.interval }).catch((e) => { toast(e.message, true); refresh(); });
      });
    });

    // ⋯-Menü + Drag
    root.querySelectorAll("[data-menu]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); openMenu(+btn.dataset.menu, btn); }));
    root.querySelectorAll("[data-grip]").forEach((g) => {
      g.addEventListener("dragstart", (e) => { dragId = +g.dataset.grip; g.closest(".rp").classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
      g.addEventListener("dragend", async () => { const c = catOf(dragId); const rpEl = root.querySelector(".rp.dragging"); if (rpEl) rpEl.classList.remove("dragging"); dragId = null; if (c) await commitOrder(c.id); });
    });
    const area = root.querySelector(".tablearea");
    if (area) area.addEventListener("dragover", (e) => {
      if (dragId == null) return; e.preventDefault();
      const c = catOf(dragId); const rpEl = root.querySelector(".rp.dragging"); if (!c || !rpEl) return;
      const after = afterRow(c.id, e.clientY);
      if (after == null) { const rows = [...area.querySelectorAll(`.rp.row[data-cat="${c.id}"]:not(.dragging)`)]; const last = rows[rows.length - 1]; if (last) last.after(rpEl); } else after.before(rpEl);
    });

    // Geister-Zeilen
    root.querySelectorAll(".rp.ghost").forEach((row) => {
      const cid = +row.querySelector("[data-gc]").dataset.gc;
      const k = +row.querySelector("[data-gk]").dataset.gk;
      const note = row.querySelector(".g-note"), name = row.querySelector(".g-name"), gm = row.querySelector(".g-m"), gy = row.querySelector(".g-y");
      const upd = (f, v) => { const d = getDraft(cid, k); if (d) d[f] = v; saveUi(); };
      gm.addEventListener("input", () => { const d = getDraft(cid, k); if (d) d.src = "monatlich"; upd("m", gm.value); try { gy.value = gm.value.trim() ? amtStr(parse(gm.value) * 12) : ""; } catch (e) {} upd("y", gy.value); maybeSpawn(cid, k, "g-m", gm.selectionStart); });
      gy.addEventListener("input", () => { const d = getDraft(cid, k); if (d) d.src = "jaehrlich"; upd("y", gy.value); try { gm.value = gy.value.trim() ? amtStr(parse(gy.value) / 12) : ""; } catch (e) {} upd("m", gm.value); maybeSpawn(cid, k, "g-y", gy.selectionStart); });
      note.addEventListener("input", () => { upd("note", note.value); maybeSpawn(cid, k, "g-note", note.selectionStart); });
      name.addEventListener("input", () => { upd("name", name.value); maybeSpawn(cid, k, "g-name", name.selectionStart); });
      [note, name, gm, gy].forEach((inp) => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commitDraft(cid, k, { focusTrailing: true }); } }));
      row.addEventListener("focusout", (e) => { if (row.contains(e.relatedTarget)) return; const d = getDraft(cid, k); if (!d || !(d.name || "").trim()) return; commitDraft(cid, k, { desc: descOf(e.relatedTarget) }); });
    });
    root.querySelectorAll("[data-gadd]").forEach((b) => { b.addEventListener("mousedown", (e) => e.preventDefault()); b.addEventListener("click", () => commitDraft(+b.dataset.gadd, +b.dataset.gk, { focusTrailing: true })); });
  }

  const saveNote = debounce((id, v) => api.updatePosten(id, { note: v }).catch((e) => toast(e.message, true)), 500);
  const saveName = debounce((id, v) => api.updatePosten(id, { name: v }).catch((e) => toast(e.message, true)), 500);

  function ledgerTab(e) {
    if (e.key !== "Tab") return;
    const box = root.querySelector(".leftcol"); if (!box) return;
    const fields = [...box.querySelectorAll("input")].filter((el) => el.offsetParent !== null);
    const i = fields.indexOf(document.activeElement); if (i === -1) return;
    e.preventDefault();
    let j = e.shiftKey ? i - 1 : i + 1; if (j < 0) j = fields.length - 1; if (j >= fields.length) j = 0;
    const t = fields[j]; if (!t) return; t.focus();
    if (isAmt(t) && t.select) t.select();
    else if (t.setSelectionRange) { try { const L = t.value.length; t.setSelectionRange(L, L); } catch (e2) {} }
  }

  const onDocClick = () => closeMenu();
  const onResize = () => closeMenu();
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", ledgerTab);
  window.addEventListener("resize", onResize);

  refresh().then(() => renderConfirm()).catch((e) => { root.innerHTML = `<div class="ledger2"><p class="lg-load">Ledger konnte nicht geladen werden: ${esc(e.message)}</p></div>`; });

  return {
    unmount() {
      closeMenu(); removeConfirm();
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", ledgerTab);
      window.removeEventListener("resize", onResize);
      if (canvas) canvas.removeEventListener("scroll", onScroll);
    },
  };
}

export default { mount };
