"""KI — Inhalte der Vertragsdokumente für die Datenübergabe (read-only).

Ollama nimmt nur Text und Bilder an, keine Dateien. Deshalb wird hier – wie es
auch ChatGPT/Claude im Hintergrund tun – jede Datei in das umgewandelt, was ein
Modell lesen kann:

  * PDF mit Textebene  -> Text (pypdf)
  * PDF ohne Text (Scan) -> Seitenbilder (pypdfium2), nur für Modelle mit Bildverständnis
  * docx / odt / xlsx  -> Text (Bordmittel: zipfile + XML)
  * txt                -> Text
  * png/jpg/webp/gif   -> Bild, nur für Modelle mit Bildverständnis
  * doc / xls (alt)    -> nicht lesbar (Hinweis)

Die Dateien werden nur im Arbeitsspeicher entschlüsselt, auf der Platte entsteht
kein Klartext. Ausgelesenes merkt sich der Prozess (1 Gunicorn-Worker) in einem
kleinen Zwischenspeicher, damit nicht jede Frage alle Dateien neu liest.
"""
import base64
import io
import logging
import re
import threading
import zipfile
from collections import OrderedDict
from xml.etree import ElementTree as ET

from modules.contracts import storage

MAX_ZEICHEN = 50_000        # je Dokument (Schutz vor Riesen-PDFs)
MAX_SCAN_SEITEN = 5         # je Scan/PDF ohne Text
MAX_BILD_PX = 1280          # längste Kante der Bilder für das Modell
SCAN_SCHWELLE = 25          # < so viele Textzeichen je Seite → gilt als Scan

BILD_ENDUNGEN = {"png", "jpg", "jpeg", "webp", "gif"}

logging.getLogger("pypdf").setLevel(logging.ERROR)   # kaputte PDFs nicht ins Log spammen

_cache = OrderedDict()
_cache_lock = threading.Lock()
_CACHE_MAX = 64


# ---------------------------------------------------------------------------
# Hilfen
# ---------------------------------------------------------------------------
def _kuerzen(text):
    text = (text or "").strip()
    if len(text) > MAX_ZEICHEN:
        return text[:MAX_ZEICHEN] + f"\n[… gekürzt, Dokument ist länger als {MAX_ZEICHEN:,} Zeichen]".replace(",", "."), True
    return text, False


def _saubere_zeilen(text):
    """Mehrfache Leerzeilen/Leerzeichen eindampfen, Zeilen erhalten."""
    zeilen = [" ".join(z.split()) for z in (text or "").splitlines()]
    out, leer = [], 0
    for z in zeilen:
        if z:
            out.append(z); leer = 0
        else:
            leer += 1
            if leer == 1 and out:
                out.append("")
    return "\n".join(out).strip()


def _bild_jpeg_b64(pil_img):
    """PIL-Bild -> verkleinertes JPEG als Base64 (so erwartet es Ollama)."""
    from PIL import Image
    img = pil_img
    if img.mode not in ("RGB", "L"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        try:
            bg.paste(img, mask=img.convert("RGBA").split()[-1])
        except Exception:  # noqa: BLE001
            bg.paste(img.convert("RGB"))
        img = bg
    img.thumbnail((MAX_BILD_PX, MAX_BILD_PX))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _xml_text(data, absatz_tags):
    """Text aus Office-XML: Absätze (absatz_tags) werden zu Zeilen."""
    root = ET.fromstring(data)
    zeilen = []
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag in absatz_tags:
            t = "".join(x for x in el.itertext())
            zeilen.append(t)
    return "\n".join(zeilen)


# ---------------------------------------------------------------------------
# Leser je Dateityp
# ---------------------------------------------------------------------------
def _pdf(data):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    seiten = len(reader.pages)
    texte = []
    for i, page in enumerate(reader.pages):
        try:
            t = page.extract_text() or ""
        except Exception:  # noqa: BLE001
            t = ""
        texte.append(t)
        if sum(len(x) for x in texte) > MAX_ZEICHEN * 1.2:
            break
    zeichen = sum(len(t.strip()) for t in texte)
    if seiten and zeichen < SCAN_SCHWELLE * seiten:
        return {"art": "scan", "format": "PDF", "seiten": seiten}
    teile = [f"[Seite {i + 1}]\n{_saubere_zeilen(t)}" for i, t in enumerate(texte) if t.strip()]
    text, gekuerzt = _kuerzen("\n\n".join(teile))
    return {"art": "text", "format": "PDF", "seiten": seiten, "text": text, "gekuerzt": gekuerzt}


def _pdf_seitenbilder(data):
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(data)
    try:
        bilder = []
        for i in range(min(len(pdf), MAX_SCAN_SEITEN)):
            page = pdf[i]
            w, h = page.get_size()
            scale = min(3.0, MAX_BILD_PX / max(w, h, 1))
            bilder.append(_bild_jpeg_b64(page.render(scale=scale).to_pil()))
        return bilder
    finally:
        pdf.close()


def _docx(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        raw = z.read("word/document.xml")
    return _xml_text(raw, {"p"})


def _odt(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        raw = z.read("content.xml")
    return _xml_text(raw, {"p", "h"})


def _spalte_index(ref):
    buchst = re.match(r"[A-Z]+", ref or "")
    n = 0
    for ch in (buchst.group(0) if buchst else "A"):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _xlsx(data):
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        namen = z.namelist()
        shared = []
        if "xl/sharedStrings.xml" in namen:
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(ns + "si"):
                shared.append("".join(si.itertext()))
        blattnamen = {}
        if "xl/workbook.xml" in namen:
            for i, sh in enumerate(ET.fromstring(z.read("xl/workbook.xml")).iter(ns + "sheet"), start=1):
                blattnamen[i] = sh.get("name")
        blaetter = sorted((n for n in namen if re.match(r"xl/worksheets/sheet\d+\.xml$", n)),
                          key=lambda n: int(re.findall(r"\d+", n)[-1]))
        zeilen = []
        for n in blaetter:
            nr = int(re.findall(r"\d+", n)[-1])
            zeilen.append(f"[Blatt {blattnamen.get(nr) or nr}]")
            for row in ET.fromstring(z.read(n)).iter(ns + "row"):
                werte = {}
                for c in row.iter(ns + "c"):
                    v = c.find(ns + "v")
                    if c.get("t") == "s" and v is not None:
                        wert = shared[int(v.text)] if v.text and int(v.text) < len(shared) else ""
                    elif c.get("t") == "inlineStr":
                        wert = "".join(c.itertext())
                    else:
                        wert = v.text if v is not None else ""
                    if wert not in ("", None):
                        werte[_spalte_index(c.get("r"))] = str(wert)
                if werte:
                    zeilen.append(" | ".join(werte[k] for k in sorted(werte)))
    return "\n".join(zeilen)


def _txt(data):
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _lies(filename, data):
    ext = storage.ext_of(filename)
    if ext == "pdf":
        return _pdf(data)
    if ext in BILD_ENDUNGEN:
        return {"art": "bild", "format": ext.upper()}
    leser = {"docx": ("Word", _docx), "odt": ("OpenDocument", _odt), "xlsx": ("Excel", _xlsx), "txt": ("Text", _txt)}
    if ext in leser:
        fmt, fn = leser[ext]
        text, gekuerzt = _kuerzen(_saubere_zeilen(fn(data)))
        return {"art": "text", "format": fmt, "text": text, "gekuerzt": gekuerzt}
    return {"art": "unlesbar", "format": ext.upper() or "?",
            "grund": "altes Office-Format (.doc/.xls) kann nicht gelesen werden" if ext in ("doc", "xls") else "Dateityp nicht lesbar"}


# ---------------------------------------------------------------------------
# Öffentlich
# ---------------------------------------------------------------------------
def inhalt(doc):
    """Ausgelesener Inhalt eines Dokuments (dict aus list_all_docs), zwischengespeichert.

    Rückgabe: {"art": "text"|"scan"|"bild"|"unlesbar"|"fehler", "format", ["text", "seiten", "gekuerzt", "grund"]}
    """
    key = (doc.get("stored_name"), doc.get("size"), doc.get("filename"))
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    try:
        res = _lies(doc.get("filename") or "", storage.read(doc["stored_name"]))
    except FileNotFoundError:
        res = {"art": "fehler", "format": "?", "grund": "Datei fehlt im Speicher"}
    except Exception as e:  # noqa: BLE001 — ein kaputtes Dokument sprengt die Übergabe nicht
        res = {"art": "fehler", "format": "?", "grund": f"konnte nicht gelesen werden ({type(e).__name__})"}
    with _cache_lock:
        _cache[key] = res
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return res


def bilder(doc, art):
    """Bilder (Base64-JPEG) für Scans und Fotos – nur aufrufen, wenn das Modell Bilder versteht."""
    key = ("bilder", doc.get("stored_name"), doc.get("size"))
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    try:
        data = storage.read(doc["stored_name"])
        if art == "scan":
            out = _pdf_seitenbilder(data)
        else:
            from PIL import Image
            with Image.open(io.BytesIO(data)) as img:
                img.seek(0)
                out = [_bild_jpeg_b64(img.copy())]
    except Exception:  # noqa: BLE001
        out = []
    with _cache_lock:
        _cache[key] = out
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return out
