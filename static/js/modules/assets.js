/* Vermögen-Panel (Stufe 3) – Besitz/Schulden-Tabelle + Kennzahlen.
   Hängt an /api/assets. Anlage optimistisch (sofort sichtbar, im Hintergrund
   persistiert). Werte werden lokal live nachgerechnet (spiegelt calc.py) für
   flüssiges Tippen; Struktur-Änderungen synchronisieren per refresh().
   Drag-and-drop folgt in Schritt 3 (Ledger-Engine). */

const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const fmtEUR = (n) => eur.format(n || 0);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const LIQ = ["liquide", "halb-liquide", "illiquide"];
const RISK = ["sicher", "mittel", "hoch"];
const ART = ["Geldwert", "Sachwert"];

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
function parseSafe(raw) { try { return parse(raw); } catch (_) { return null; } }
function pctS(n) { return (Math.round(n * 10) / 10).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " %"; }

function mount(root, ctx) {
  const { api, store, toast } = ctx;
  const dbName = (store.get("state") && store.get("state").active_db) || "db";
  const UIKEY = "fk_assets_ui_" + dbName;
  const canvas = root.closest(".canvas");

  let data = { besitz: [], schulden: [] };
  let monthlyExpenses = 0;
  let tmpN = 1;

  let ui;
  try { ui = { drafts: {}, openId: null, confirmDelete: null, ...JSON.parse(localStorage.getItem(UIKEY) || "{}") }; }
  catch (_) { ui = { drafts: {}, openId: null, confirmDelete: null }; }
  if (!ui.drafts) ui.drafts = {};
  const saveUi = debounce(() => { try { localStorage.setItem(UIKEY, JSON.stringify(ui)); } catch (_) {} }, 200);

  // Body-Ebene: Popover / Zeilenmenü / Overlay (über allem)
  const pop = el("div", "vm-pop"); const rmenu = el("div", "vm-rmenu");
  const overlay = el("div", "vm-overlay"); overlay.innerHTML = `<div class="vm-confirm" id="vmConfirm"></div>`;
  document.body.append(pop, rmenu, overlay);
  const confirmBox = overlay.querySelector("#vmConfirm");

  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

  root.innerHTML = `
    <div class="vmwrap" id="vm">
      <section class="vm-left">
        <div class="areatitle">Besitz</div>
        <div class="ledger" id="vmBesitz"></div>
        <button class="addklasse" data-kind="asset">+ Klasse hinzufügen</button>
        <div class="areatitle">Schulden</div>
        <div class="ledger" id="vmSchulden"></div>
        <button class="addklasse" data-kind="debt">+ Klasse hinzufügen</button>
      </section>
      <aside class="vm-right">
        <div class="areatitle">Kennzahlen</div>
        <div class="vm-ebox-right" id="vmEmpty"><span class="emptytxt">Kennzahlen erscheinen, sobald Werte da sind.</span></div>
        <div class="vm-real" id="vmReal" style="display:none">
          <div class="evalgrid">
            <div class="tiles">
              <div class="tile hero span2"><div class="tlbl">Gesamtvermögen</div><div class="tbig num" data-k="netto">0,00 €</div><div class="tsub">Besitz <span class="num" data-k="besitz">0,00 €</span> &nbsp;−&nbsp; Schulden <span class="num" data-k="schulden">0,00 €</span></div></div>
              <div class="tile"><div class="tlbl">Griffbereit</div><div class="vm-tval num" data-k="griff">0,00 €</div><div class="thint">liquide Mittel</div></div>
              <div class="tile"><div class="tlbl">Notgroschen-Reichweite</div><div class="vm-tval num" data-k="run">–</div><div class="thint">liquide ÷ Ausgaben/Mon.</div></div>
              <div class="tile"><div class="tlbl">Eigenkapitalquote</div><div class="vm-tval num" data-k="ek">0 %</div><div class="thint">Netto ÷ Besitz</div></div>
              <div class="tile"><div class="tlbl">Verschuldungsgrad</div><div class="vm-tval num" data-k="debt">0 %</div><div class="thint">Schulden ÷ Besitz</div></div>
              <div class="tile span2"><div class="tlbl">Klumpenrisiko</div><div class="vm-tval num" data-k="clump">0 %</div><div class="thint" data-k="clumpname">größte Einzelposition</div></div>
              <div class="tile"><div class="tlbl">Sachwertquote</div><div class="vm-tval num" data-k="sach">0 %</div><div class="thint">Sachwerte ÷ Besitz</div></div>
              <div class="tile"><div class="tlbl">Liquide Quote</div><div class="vm-tval num" data-k="cash">0 %</div><div class="thint">liquide ÷ Besitz</div></div>
              <div class="tile"><div class="tlbl">Illiquide Quote</div><div class="vm-tval num" data-k="anlage">0 %</div><div class="thint">illiquide ÷ Besitz</div></div>
              <div class="tile"><div class="tlbl">Risikoquote</div><div class="vm-tval num" data-k="risk">0 %</div><div class="thint">mittel + hoch ÷ Besitz</div></div>
              <div class="tile span2"><div class="tlbl">Sicher angelegt</div><div class="vm-tval num" data-k="safe">0 %</div><div class="thint">sicher ÷ Besitz</div></div>
            </div>
            <div class="sidecol">
              <div class="panel"><h4>Aufteilung im Detail</h4><div class="dbody" id="vmAlloc"></div></div>
              <div class="panel regler"><h4>Prozent-Rechner</h4><div class="dbody">
                <div class="rpct"><span data-k="rp">10</span> % von <span data-k="rbl">Gesamtbesitz</span></div>
                <div class="rout num" data-k="rout">0,00 €</div>
                <input type="range" min="0" max="100" value="10" id="vmRange">
                <div class="rpre" id="vmPre"><button data-v="1">1 %</button><button data-v="5">5 %</button><button data-v="10">10 %</button><button data-v="20">20 %</button><button data-v="50">50 %</button></div>
                <div class="rbezug" id="vmBez"><button data-b="besitz" class="on">Gesamtbesitz</button><button data-b="liquide">liquide</button><button data-b="netto">Netto</button></div>
              </div></div>
            </div>
          </div>
        </div>
      </aside>
    </div>`;

  const wrap = root.querySelector("#vm");
  const q = (s) => root.querySelector(s);
  const setW = (px) => wrap.style.setProperty("--wertw", px + "px");

  /* ---------- Laden ---------- */
  async function refresh() {
    const st = await api.assetsState();
    monthlyExpenses = st.monthly_expenses || 0;
    data = { besitz: [], schulden: [] };
    for (const c of st.classes) {
      const cls = { id: c.id, kind: c.kind, name: c.name, profile: c.profile,
        positions: (c.positions || []).map((p) => ({ id: p.id, name: p.name, value: p.value, note: p.note || "", active: p.active !== false })) };
      (c.kind === "asset" ? data.besitz : data.schulden).push(cls);
    }
    render();
  }

  /* ---------- lokale Berechnung (spiegelt calc.py) ---------- */
  const classSum = (c) => c.positions.reduce((a, p) => a + (p.active === false ? 0 : (+p.value || 0)), 0);
  const besitzTotal = () => data.besitz.reduce((a, c) => a + classSum(c), 0);
  const schuldenTotal = () => data.schulden.reduce((a, c) => a + classSum(c), 0);
  const grp = (ax, val) => data.besitz.filter((c) => c.profile && c.profile[ax] === val).reduce((a, c) => a + classSum(c), 0);

  function valW() {
    let m = 0; const consider = (v) => { const L = fmtEUR(v).length; if (L > m) m = L; };
    data.besitz.forEach((c) => { c.positions.forEach((p) => consider(p.value)); consider(classSum(c)); });
    data.schulden.forEach((c) => { c.positions.forEach((p) => consider(p.value)); consider(classSum(c)); });
    consider(besitzTotal()); consider(schuldenTotal());
    return Math.max(165, Math.round(m * 13.5 * 0.63) + 20);
  }

  /* ---------- Render: Tabelle ---------- */
  function classHTML(c) {
    const asset = c.kind === "asset";
    const rows = c.positions.map((p, i) =>
      `<div class="trow prow${i === 0 ? " first" : ""}${p.active === false ? " inactive" : ""}" data-cid="${c.id}" data-pid="${p.id}">
        <span class="grip">⠿</span>
        <input class="cellinput info" data-f="note" value="${esc(p.note)}" placeholder="Kommentar…">
        <input class="cellinput name" data-f="name" value="${esc(p.name)}" placeholder="${asset ? "Neuer Posten…" : "Neue Schuld…"}">
        <input class="cellinput wert num" data-f="value" value="${fmtEUR(p.value)}">
        <button class="rmenu-btn" title="Optionen">⋯</button>
        <span class="pct${asset ? "" : " neg"} num" data-role="ppct">–</span>
        <span class="btrack${asset ? "" : " debt"}"><span class="bfill" data-role="pbar" style="width:0"></span></span>
      </div>`).join("");
    const d = ui.drafts[c.id] || { note: "", name: "", value: "" };
    const ghost = `<div class="trow prow ghost" data-cid="${c.id}" data-ghost="1">
        <span class="plus">+</span>
        <input class="cellinput info" data-g="note" value="${esc(d.note)}" placeholder="Kommentar…">
        <input class="cellinput name" data-g="name" value="${esc(d.name)}" placeholder="${asset ? "Neuer Posten…" : "Neue Schuld…"}">
        <input class="cellinput wert num" data-g="value" value="${esc(d.value)}" placeholder="0,00">
        <span class="pct"></span><span></span></div>`;
    const sum = `<div class="trow srow" data-cid="${c.id}"><span class="sname">Summe ${esc(c.name)}</span><span class="wert num" data-role="csumval">0</span><span class="pct${asset ? "" : " neg"} num" data-role="csumpct">–</span><span class="btrack${asset ? "" : " debt"}"><span class="bfill" data-role="csumbar" style="width:0"></span></span></div>`;
    const prof = asset && c.profile
      ? `<span class="gsub prof-b">${c.profile.liq} · ${c.profile.risk} · ${c.profile.art}</span>`
      : "";
    const editBtn = asset ? `<button class="edit" title="Profil bearbeiten">⋯</button>` : "";
    return `<div class="gclass" data-cid="${c.id}" data-block="${asset ? "besitz" : "schulden"}">
      <div class="ghead">
        <span class="grip">⠿</span>
        <span class="ch-id"><span class="cdot" style="background:var(--${asset ? "positive" : "negative"})"></span><input class="cname" data-f="cname" value="${esc(c.name)}"></span>
        <span class="ch-prof">${prof}</span>
        <span class="ch-act">${editBtn}<button class="del" title="Klasse löschen">×</button></span>
      </div>${rows}${ghost}${sum}</div>`;
  }

  function render() {
    setW(valW());
    const colB = `<div class="trow colhead"><span class="h h-info">Information</span><span class="h h-name">Posten</span><span class="h h-wert">Wert</span><span class="h h-ant">Anteil am Besitz</span></div>`;
    const colS = `<div class="trow colhead"><span class="h h-info">Information</span><span class="h h-name">Posten</span><span class="h h-wert">Wert</span><span class="h h-ant">Anteil (abziehend)</span></div>`;
    const lB = q("#vmBesitz"), lS = q("#vmSchulden");
    if (!data.besitz.length) { lB.classList.add("vm-empty"); lB.innerHTML = `<span class="emptytxt">Noch keine Bereiche. Lege unten einen an.</span>`; }
    else { lB.classList.remove("vm-empty"); lB.innerHTML = colB + data.besitz.map(classHTML).join("") +
      `<div class="trow grow" id="vmGrowB"><span class="sname">Gesamtbesitz</span><span class="wert num" data-role="gbval">0</span><span class="pct num">100 %</span><span class="btrack"><span class="bfill" style="width:100%"></span></span></div>`; }
    if (!data.schulden.length) { lS.classList.add("vm-empty"); lS.innerHTML = `<span class="emptytxt"></span>`; }
    else { lS.classList.remove("vm-empty"); lS.innerHTML = colS + data.schulden.map(classHTML).join("") +
      `<div class="trow grow" id="vmGrowS"><span class="sname">Gesamtschulden</span><span class="wert num" data-role="gsval">0</span><span class="pct neg num" data-role="gspct">0 %</span><span class="btrack debt"><span class="bfill" data-role="gsbar" style="width:0"></span></span></div>`; }
    const allEmpty = !data.besitz.length && !data.schulden.length;
    q("#vmReal").style.display = allEmpty ? "none" : "";
    q("#vmEmpty").style.display = allEmpty ? "flex" : "none";
    recompute();
    if (ui.openId) renderPop();
    if (ui.confirmDelete) renderConfirm();
  }

  /* ---------- Recompute (Live) ---------- */
  function recompute() {
    setW(valW());
    const tot = besitzTotal(), totS = schuldenTotal(), netto = tot - totS;
    const pctOf = (v) => tot > 0 ? Math.round(v / tot * 100) + " %" : "0 %";
    data.besitz.forEach((c) => {
      c.positions.forEach((p) => {
        const row = q(`.prow[data-pid="${p.id}"]`); if (!row) return;
        const inactive = p.active === false;
        const perc = (!inactive && tot > 0) ? (+p.value / tot * 100) : 0;
        row.querySelector('[data-role="ppct"]').textContent = inactive ? "–" : pctS(perc);
        row.querySelector('[data-role="pbar"]').style.width = Math.max(0, Math.min(100, perc)) + "%";
      });
      updSum(c, tot, false);
    });
    data.schulden.forEach((c) => {
      c.positions.forEach((p) => {
        const row = q(`.prow[data-pid="${p.id}"]`); if (!row) return;
        const inactive = p.active === false;
        const perc = (!inactive && tot > 0) ? (+p.value / tot * 100) : 0;
        row.querySelector('[data-role="ppct"]').textContent = inactive ? "–" : ("−" + pctS(perc));
        row.querySelector('[data-role="pbar"]').style.width = Math.max(0, Math.min(100, perc)) + "%";
      });
      updSum(c, tot, true);
    });
    const gb = q('#vmGrowB [data-role="gbval"]'); if (gb) gb.textContent = fmtEUR(tot);
    const gs = q('#vmGrowS [data-role="gsval"]'); if (gs) gs.textContent = fmtEUR(totS);
    const gsp = tot > 0 ? totS / tot * 100 : 0;
    const gspEl = q('#vmGrowS [data-role="gspct"]'); if (gspEl) gspEl.textContent = "−" + pctS(gsp);
    const gsbar = q('#vmGrowS [data-role="gsbar"]'); if (gsbar) gsbar.style.width = Math.max(0, Math.min(100, gsp)) + "%";

    // Kacheln
    const griff = grp("liq", "liquide"), sach = grp("art", "Sachwert");
    const set = (k, v) => { const e = q(`[data-k="${k}"]`); if (e) e.textContent = v; };
    set("netto", fmtEUR(netto)); set("besitz", fmtEUR(tot)); set("schulden", fmtEUR(totS));
    set("griff", fmtEUR(griff));
    set("run", (tot > 0 && monthlyExpenses > 0) ? ((griff / monthlyExpenses).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " Mon.") : "–");
    set("ek", pctOf(netto)); set("debt", pctOf(totS)); set("sach", pctOf(sach));
    set("cash", pctOf(griff)); set("anlage", pctOf(grp("liq", "illiquide")));
    set("risk", pctOf(grp("risk", "mittel") + grp("risk", "hoch"))); set("safe", pctOf(grp("risk", "sicher")));
    let big = null;
    data.besitz.forEach((c) => c.positions.forEach((p) => { if (p.active !== false && (!big || (+p.value || 0) > big.value)) big = { value: +p.value || 0, name: p.name || "—" }; }));
    set("clump", big && tot > 0 ? pctOf(big.value) : "0 %");
    set("clumpname", big ? `größte Position: ${big.name} · ${fmtEUR(big.value)}` : "größte Einzelposition");

    // Aufteilung
    const bar = (label, v) => { const p = tot > 0 ? v / tot * 100 : 0; return `<div class="barrow"><span class="bl">${label}</span><div class="bartrack"><div class="barfill" style="width:${p}%"></div></div><span class="bp num">${Math.round(p)} %</span></div>`; };
    q("#vmAlloc").innerHTML =
      `<div class="dcat">Liquidität</div>${bar("liquide", grp("liq", "liquide"))}${bar("halb-liquide", grp("liq", "halb-liquide"))}${bar("illiquide", grp("liq", "illiquide"))}
       <div class="dcat">Risiko</div>${bar("sicher", grp("risk", "sicher"))}${bar("mittel", grp("risk", "mittel"))}${bar("hoch", grp("risk", "hoch"))}
       <div class="dcat">Art</div>${bar("Geldwert", grp("art", "Geldwert"))}${bar("Sachwert", grp("art", "Sachwert"))}`;
    reglerBases = { besitz: tot, liquide: griff, netto }; updRegler();
  }
  function updSum(c, tot, debt) {
    const el = q(`.srow[data-cid="${c.id}"]`); if (!el) return;
    const cs = classSum(c), pc = tot > 0 ? cs / tot * 100 : 0;
    el.querySelector('[data-role="csumval"]').textContent = fmtEUR(cs);
    el.querySelector('[data-role="csumpct"]').textContent = (debt ? "−" : "") + pctS(pc);
    el.querySelector('[data-role="csumbar"]').style.width = Math.max(0, Math.min(100, pc)) + "%";
  }

  /* ---------- Helfer: Klasse/Position finden ---------- */
  const findClass = (cid) => data.besitz.find((c) => c.id == cid) || data.schulden.find((c) => c.id == cid);
  const blockOf = (c) => (c.kind === "asset" ? "besitz" : "schulden");

  /* ---------- ensureVisible (smooth) ---------- */
  function ensureVisible(el) {
    if (!el) return;
    const sc = canvas; const r = el.getBoundingClientRect();
    const vb = sc ? sc.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const H = vb.bottom - vb.top; const bm = Math.min(Math.max(H * 0.34, 150), 300), tm = 28;
    let delta = 0;
    if (r.bottom > vb.bottom - bm) delta = r.bottom - (vb.bottom - bm);
    else if (r.top < vb.top + tm) delta = r.top - (vb.top + tm);
    if (Math.abs(delta) > 1 && sc) { const t = Math.max(0, sc.scrollTop + delta); try { sc.scrollTo({ top: t, behavior: "smooth" }); } catch (_) { sc.scrollTop = t; } }
  }

  /* ---------- Anlage (optimistisch) ---------- */
  function promoteGhost(cid, field) {
    const c = findClass(cid); if (!c) return;
    const d = ui.drafts[cid] || { note: "", name: "", value: "" };
    const pos = { id: "tmp" + (tmpN++), name: d.name || "", value: parseSafe(d.value) || 0, note: d.note || "", active: true, pending: true };
    c.positions.push(pos);
    ui.drafts[cid] = { note: "", name: "", value: "" }; saveUi();
    render();
    const inp = q(`.prow[data-pid="${pos.id}"] [data-f="${field}"]`);
    if (inp) { inp.focus(); try { const n = inp.value.length; inp.setSelectionRange(n, n); } catch (_) {} ensureVisible(q(`.gclass[data-cid="${cid}"] .ghost`)); }
    api.addAssetPosition({ class_id: c.id, name: pos.name, value: pos.value, note: pos.note })
      .then((res) => {
        const real = res && res.id; if (!real) return;
        const old = pos.id; pos.id = real; pos.pending = false; pendingPos.delete(old);
        const row = q(`.prow[data-pid="${old}"]`); if (row) row.dataset.pid = real;
        // etwaige Änderungen während des Anlegens nachziehen
        api.updateAssetPosition(real, { name: pos.name, value: pos.value, note: pos.note }).catch(() => {});
        recompute();
      })
      .catch((e) => { toast(e.message, true); refresh(); });
  }

  const pendingPos = new Map(); // pid -> patch
  const pendingCls = new Map(); // cid -> patch
  const flushSoon = debounce(() => { flushAll(); }, 350);
  async function flushAll() {
    const posE = [...pendingPos.entries()]; pendingPos.clear();
    const clsE = [...pendingCls.entries()]; pendingCls.clear();
    for (const [pid, patch] of posE) { if (String(pid).startsWith("tmp")) continue; try { await api.updateAssetPosition(pid, patch); } catch (e) { toast(e.message, true); } }
    for (const [cid, patch] of clsE) { try { await api.updateAssetClass(cid, patch); } catch (e) { toast(e.message, true); } }
  }
  function queuePos(pid, patch) { pendingPos.set(pid, { ...(pendingPos.get(pid) || {}), ...patch }); flushSoon(); }
  function queueCls(cid, patch) { pendingCls.set(cid, { ...(pendingCls.get(cid) || {}), ...patch }); flushSoon(); }

  /* ---------- Events: Tabelle ---------- */
  root.addEventListener("input", (e) => {
    const t = e.target, g = t.closest(".gclass"); if (!g) return;
    const cid = g.dataset.cid, c = findClass(cid); if (!c) return;
    if (t.dataset.f === "cname") { c.name = t.value; const s = g.querySelector(".srow .sname"); if (s) s.textContent = "Summe " + c.name; queueCls(cid, { name: t.value }); return; }
    const prow = t.closest(".prow");
    if (prow && prow.dataset.ghost) {
      const d = ui.drafts[cid] || { note: "", name: "", value: "" }; d[t.dataset.g] = t.value; ui.drafts[cid] = d; saveUi();
      if (t.dataset.g === "name" && d.name.trim() !== "") promoteGhost(cid, "name");
      return;
    }
    if (prow) {
      const pid = prow.dataset.pid, p = c.positions.find((x) => x.id == pid); if (!p) return;
      if (t.dataset.f === "value") { const v = parseSafe(t.value); if (v !== null) { p.value = v; recompute(); queuePos(pid, { value: v }); } }
      else { p[t.dataset.f] = t.value; queuePos(pid, { [t.dataset.f]: t.value }); }
    }
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return; const g = e.target.closest(".gclass"); if (!g) return;
    e.preventDefault(); const gh = g.querySelector('.ghost [data-g="name"]'); if (gh) gh.focus();
  });
  root.addEventListener("blur", (e) => {
    const t = e.target; if (!(t.dataset && t.dataset.f === "value")) return;
    const prow = t.closest(".prow"), g = t.closest(".gclass"); if (!prow || !g) return;
    const c = findClass(g.dataset.cid); if (!c) return; const p = c.positions.find((x) => x.id == prow.dataset.pid);
    if (p) t.value = fmtEUR(p.value);
  }, true);

  root.addEventListener("click", (e) => {
    const t = e.target;
    if (t.classList.contains("rmenu-btn")) { const pr = t.closest(".prow"), g = t.closest(".gclass"); const pid = pr.dataset.pid;
      if (rmTarget && rmTarget.pid == pid && rmenu.classList.contains("show")) hideRowMenu(); else openRowMenu(g.dataset.cid, pid, t); e.stopPropagation(); return; }
    if (t.classList.contains("edit")) { const g = t.closest(".gclass"), cid = g.dataset.cid;
      if (ui.openId == cid && pop.classList.contains("show")) { ui.openId = null; hidePop(); saveUi(); } else openPop(cid); e.stopPropagation(); return; }
    if (t.classList.contains("del")) { const g = t.closest(".gclass"), c = findClass(g.dataset.cid);
      if (c && c.positions.length >= 1) openConfirm(c.id); else delClass(c.id); return; }
  });

  root.querySelectorAll(".addklasse").forEach((b) => b.addEventListener("click", async () => {
    const kind = b.dataset.kind;
    const body = { kind, name: kind === "asset" ? "Neue Klasse" : "Neue Schuld" };
    if (kind === "asset") body.profile = { liq: "liquide", risk: "sicher", art: "Geldwert" };
    try { await flushAll(); await api.addAssetClass(body); await refresh();
      const arr = kind === "asset" ? data.besitz : data.schulden; const nc = arr[arr.length - 1];
      const elc = q(`.gclass[data-cid="${nc.id}"]`); ensureVisible(elc); const nm = elc && elc.querySelector(".cname"); if (nm) { nm.focus(); try { nm.select(); } catch (_) {} }
    } catch (e) { toast(e.message, true); }
  }));

  /* ---------- Profil-Popover ---------- */
  function openPop(cid) { ui.openId = cid; renderPop(); saveUi(); }
  function hidePop() { pop.classList.remove("show"); }
  function renderPop() {
    const c = findClass(ui.openId); if (!c || c.kind !== "asset") { ui.openId = null; hidePop(); return; }
    const rowH = (label, ax, opts) => `<div class="poprow"><div class="pl">${label}</div><div class="choice" data-ax="${ax}">${opts.map((o) => `<button class="${o === c.profile[ax] ? "on" : ""}" data-v="${o}">${o}</button>`).join("")}</div></div>`;
    pop.innerHTML = `<h6>${esc(c.name)} — Profil</h6>${rowH("Liquidität", "liq", LIQ)}${rowH("Risiko", "risk", RISK)}${rowH("Art", "art", ART)}<button class="done">Fertig</button>`;
    pop.classList.add("show"); positionPop(c.id);
  }
  function positionPop(cid) {
    const b = q(`.gclass[data-cid="${cid}"] .edit`); if (!b) { hidePop(); return; }
    const r = b.getBoundingClientRect(), w = 286, vw = window.innerWidth;
    let left = Math.min(r.right - w, vw - w - 12); if (left < 12) left = 12;
    let top = r.bottom + 8; if (top + 260 > window.innerHeight) top = Math.max(12, r.top - 260);
    pop.style.left = left + "px"; pop.style.top = top + "px";
  }
  pop.addEventListener("click", (e) => {
    const t = e.target;
    if (t.classList.contains("done")) { ui.openId = null; hidePop(); saveUi(); return; }
    if (t.tagName === "BUTTON" && t.dataset.v) {
      const ax = t.closest(".choice").dataset.ax, c = findClass(ui.openId); if (!c) return;
      c.profile[ax] = t.dataset.v; t.closest(".choice").querySelectorAll("button").forEach((x) => x.classList.remove("on")); t.classList.add("on");
      const sub = q(`.gclass[data-cid="${ui.openId}"] .prof-b`); if (sub) sub.textContent = `${c.profile.liq} · ${c.profile.risk} · ${c.profile.art}`;
      recompute(); api.updateAssetClass(c.id, { profile: { [ax]: t.dataset.v } }).catch((err) => { toast(err.message, true); refresh(); });
    }
  });

  /* ---------- Zeilen-Menü ---------- */
  let rmTarget = null;
  function openRowMenu(cid, pid, btn) {
    const c = findClass(cid); if (!c) return; const p = c.positions.find((x) => x.id == pid); if (!p) return;
    const idx = c.positions.indexOf(p); rmTarget = { cid, pid };
    document.querySelectorAll(".rmenu-btn.active").forEach((x) => x.classList.remove("active")); if (btn) btn.classList.add("active");
    rmenu.innerHTML = `<button data-a="up"${idx === 0 ? " disabled" : ""}>↑ Nach oben</button>
      <button data-a="down"${idx === c.positions.length - 1 ? " disabled" : ""}>↓ Nach unten</button>
      <div class="sep"></div><button data-a="toggle">${p.active === false ? "Aktiv setzen" : "Inaktiv setzen"}</button>
      <div class="sep"></div><button class="danger" data-a="del">Löschen</button>`;
    rmenu.classList.add("show");
    const r = btn.getBoundingClientRect(), w = 176; let l = Math.min(r.right - w, window.innerWidth - w - 12); if (l < 12) l = 12;
    let top = r.bottom + 6; if (top + 180 > window.innerHeight) top = Math.max(12, r.top - 180);
    rmenu.style.left = l + "px"; rmenu.style.top = top + "px";
  }
  function hideRowMenu() { rmenu.classList.remove("show"); rmTarget = null; document.querySelectorAll(".rmenu-btn.active").forEach((x) => x.classList.remove("active")); }
  rmenu.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || b.hasAttribute("disabled") || !rmTarget) return;
    const c = findClass(rmTarget.cid); if (!c) { hideRowMenu(); return; }
    const p = c.positions.find((x) => x.id == rmTarget.pid); const idx = c.positions.indexOf(p); const a = b.dataset.a; hideRowMenu();
    try {
      await flushAll();
      if (a === "toggle") { await api.updateAssetPosition(p.id, { active: !(p.active !== false) }); await refresh(); }
      else if (a === "up" && idx > 0) { c.positions.splice(idx - 1, 0, c.positions.splice(idx, 1)[0]); render(); await api.reorderAssetPositions(c.positions.map((x) => x.id)); }
      else if (a === "down" && idx < c.positions.length - 1) { c.positions.splice(idx + 1, 0, c.positions.splice(idx, 1)[0]); render(); await api.reorderAssetPositions(c.positions.map((x) => x.id)); }
      else if (a === "del") { await api.deleteAssetPosition(p.id); await refresh(); }
    } catch (err) { toast(err.message, true); refresh(); }
  });

  /* ---------- Löschen-Bestätigung ---------- */
  function openConfirm(cid) { ui.confirmDelete = cid; renderConfirm(); saveUi(); }
  function renderConfirm() {
    const c = findClass(ui.confirmDelete); if (!c) { ui.confirmDelete = null; overlay.classList.remove("show"); return; }
    confirmBox.innerHTML = `<p>Klasse „<b>${esc(c.name)}</b>" inklusive ${c.positions.length} Posten löschen?</p><div class="btns"><button class="cancel">Abbrechen</button><button class="ok">Löschen</button></div>`;
    overlay.classList.add("show");
  }
  confirmBox.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !ui.confirmDelete) return;
    if (b.classList.contains("ok")) { const cid = ui.confirmDelete; ui.confirmDelete = null; overlay.classList.remove("show"); saveUi(); delClass(cid); }
    else { ui.confirmDelete = null; overlay.classList.remove("show"); saveUi(); }
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) { ui.confirmDelete = null; overlay.classList.remove("show"); saveUi(); } });

  async function delClass(cid) {
    const c = findClass(cid); if (!c) return;
    try { await flushAll(); for (const p of c.positions) await api.deleteAssetPosition(p.id); await api.deleteAssetClass(cid); delete ui.drafts[cid]; saveUi(); await refresh(); }
    catch (e) { toast(e.message, true); refresh(); }
  }

  /* ---------- Regler ---------- */
  let reglerBases = { besitz: 0, liquide: 0, netto: 0 }, reglerCur = "besitz";
  const reglerLabels = { besitz: "Gesamtbesitz", liquide: "liquidem Geld", netto: "Nettovermögen" };
  const range = q("#vmRange");
  function updRegler() { const p = +range.value; const set = (k, v) => { const e = q(`[data-k="${k}"]`); if (e) e.textContent = v; };
    set("rp", p); set("rbl", reglerLabels[reglerCur]); const e = q('[data-k="rout"]'); if (e) e.textContent = fmtEUR((reglerBases[reglerCur] || 0) * p / 100); }
  range.addEventListener("input", updRegler);
  q("#vmPre").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { range.value = b.dataset.v; updRegler(); }));
  q("#vmBez").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { q("#vmBez").querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); reglerCur = b.dataset.b; updRegler(); }));

  /* ---------- Doc-Listener (schließen) ---------- */
  const onDocClick = (e) => {
    if (ui.openId && !e.target.closest(".vm-pop") && !e.target.classList.contains("edit")) { ui.openId = null; hidePop(); saveUi(); }
    if (rmTarget && !e.target.closest(".vm-rmenu") && !e.target.classList.contains("rmenu-btn")) hideRowMenu();
  };
  const onWinChange = () => { if (ui.openId) positionPop(ui.openId); hideRowMenu(); };
  document.addEventListener("click", onDocClick);
  window.addEventListener("resize", onWinChange);
  window.addEventListener("scroll", onWinChange, true);

  refresh().catch((e) => { toast(e.message, true); });

  return {
    unmount() {
      flushAll();
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("resize", onWinChange);
      window.removeEventListener("scroll", onWinChange, true);
      pop.remove(); rmenu.remove(); overlay.remove();
    },
  };
}

export default { mount };
