/**
 * billParser — extracts structured line items from supplier invoice PDFs.
 *
 * Supports Tally-format GST invoices (the dominant format among Indian
 * auto-parts suppliers). Pure text-layer extraction via pdf.js with
 * COORDINATE-BASED table reconstruction — each value is classified by its
 * x-position column, so run-together numbers and multi-line part names are
 * handled exactly. Zero API cost.
 *
 * Output is ALWAYS validated against the invoice's own printed totals:
 * `sumMatches` tells the caller whether Σ(line amounts) equals the printed
 * taxable total. The review UI must surface a mismatch so the shop owner can
 * fill gaps manually — silent data loss is not acceptable.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// pdf-parse's index.js runs demo code on some import paths — use the lib entry
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const num = (s) => parseFloat(String(s).replace(/,/g, ''));
const isMoney = (s) => /^[\d,]+\.\d{2}$/.test(s);

/** Group a page's text items into visual rows by Y, cells sorted by X. */
function pageToRows(textContent) {
  const rows = new Map();
  for (const it of textContent.items) {
    const str = it.str.trim();
    if (!str) continue;
    const y = it.transform[5];
    const x = it.transform[4];
    // 3.2pt tolerance: Tally renders the grand-total label and its amount 3pt
    // apart; real item rows are 11+pt apart so this can't merge two items.
    const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 3.2) ?? y;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x, str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // top → bottom (pdf y origin is bottom-left)
    .map(([y, cells]) => ({ y, cells: cells.sort((a, b) => a.x - b.x) }));
}

export async function parseTallyInvoice(buffer) {
  const allRows = [];
  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent();
      allRows.push(pageToRows(tc));
      return '';
    },
  });

  const result = {
    format: 'tally',
    supplierName: null,
    supplierGstin: null,
    invoiceNumber: null,
    invoiceDate: null,
    items: [],
    taxableTotal: null,
    grandTotal: null,
    sumOfItems: 0,
    sumMatches: false,
    warnings: [],
    pages: allRows.length,
  };

  // ── Header metadata (page 1) ───────────────────────────────────────────────
  const flat = allRows.flat();
  for (let i = 0; i < flat.length; i++) {
    const text = flat[i].cells.map((c) => c.str).join(' ');
    if (!result.supplierName && /^TAX INVOICE/i.test(text)) {
      // supplier name = next row that starts in the LEFT column (the right
      // column holds the Invoice No./Dated labels at x≈273)
      for (let j = i + 1; j < Math.min(i + 5, flat.length); j++) {
        const first = flat[j].cells[0];
        if (first && first.x < 60) { result.supplierName = flat[j].cells.filter((c) => c.x < 200).map((c) => c.str).join(' ').trim(); break; }
      }
    }
    if (!result.supplierGstin) {
      const g = text.match(/GSTIN\/?UIN\s*:?\s*([0-9A-Z]{15})/i);
      if (g) result.supplierGstin = g[1];
    }
    if (!result.invoiceDate) {
      const d = text.match(/\b(\d{1,2}-[A-Za-z]{3}-\d{2,4})\b/);
      if (d) result.invoiceDate = d[1];
    }
    if (!result.invoiceNumber) {
      // label cell "Invoice No." — value renders on a following row in the same column
      const label = flat[i].cells.find((c) => /^Invoice No\.?$/i.test(c.str.trim()));
      if (label) {
        for (let j = i + 1; j < Math.min(i + 4, flat.length); j++) {
          const v = flat[j].cells.find((c) => Math.abs(c.x - label.x) < 30 && /^[\w/-]+$/.test(c.str.trim()) && !/^Dated$/i.test(c.str.trim()));
          if (v) { result.invoiceNumber = v.str.trim(); break; }
        }
      }
    }
  }

  // ── Line items via column classification ──────────────────────────────────
  // Columns (from the table header row): Sl≈39 | Description≈51 | HSN≈158 |
  // Quantity≈217+ | Rate(incl)≈271-329 | Rate≈330-369 | per≈370 | Disc%≈392 | Amount≈448+
  let current = null;
  const pushCurrent = () => {
    if (!current) return;
    if (current.hsnCode && current.amount != null && current.qty != null) {
      current.partName = current.nameParts.join(' ').replace(/\s+/g, ' ').trim();
      delete current.nameParts;
      current.mathOk = current.rate != null
        ? Math.abs(current.amount - current.rate * current.qty) < 0.05
        : true;
      if (!current.mathOk) result.warnings.push(`qty×rate ≠ amount for item ${current.serial}`);
      result.items.push(current);
    } else {
      result.warnings.push(`Incomplete item row (serial ${current.serial}) — skipped`);
    }
    current = null;
  };

  for (const pageRows of allRows) {
    let inTable = false;
    for (const row of pageRows) {
      const joined = row.cells.map((c) => c.str).join(' ');
      if (/Description of Goods/.test(joined)) { inTable = true; continue; }
      if (!inTable) continue;
      if (/^No\.?\s*\(Incl/.test(joined) || /^\(Incl\. of Tax\)/.test(joined)) continue;
      if (/continued/.test(joined)) break; // end of this page's table — item may continue next page

      // Tax footer begins after the last item: OUTPUT CGST/SGST/IGST rows,
      // round-off rows, or the unlabeled taxable-subtotal row (a lone value in
      // the Amount column with nothing else). Without this cut, footer rows
      // bleed into the last item's name and overwrite its amount.
      const isFooterLabel = /^(OUTPUT\s|Less\s*:|.*ROUND\s*OFF)/i.test(joined);
      const isLoneSubtotal = row.cells.length === 1 && row.cells[0].x >= 440 && isMoney(row.cells[0].str.trim());
      if (isFooterLabel || isLoneSubtotal
        || /JURISDICTION|Computer Generated|Amount Chargeable|^Total\b|E\. ?& ?O\.E|Declaration|Taxable/i.test(joined)) {
        pushCurrent();
        inTable = false;
        continue;
      }

      const serialCell = row.cells.find((c) => c.x < 50 && /^\d{1,3}$/.test(c.str));
      if (serialCell) {
        pushCurrent();
        current = { serial: parseInt(serialCell.str, 10), nameParts: [], hsnCode: null, qty: null, unit: null, rate: null, rateInclTax: null, discountPct: 0, amount: null };
      }
      if (!current) continue;

      for (const c of row.cells) {
        const s = c.str.trim();
        if (c.x < 50) continue; // serial — handled
        if (c.x < 150) { current.nameParts.push(s); continue; }            // Description
        if (c.x < 217 && /^\d{4,8}$/.test(s)) { current.hsnCode = s; continue; } // HSN/SAC (4-8 digits)
        const qm = s.match(/^([\d,]+)\s*([A-Z]{2,4})$/);
        if (qm && c.x < 271) { current.qty = parseInt(qm[1].replace(/,/g, ''), 10); current.unit = qm[2]; continue; } // Quantity
        if (isMoney(s)) {
          if (c.x >= 448) current.amount = num(s);                           // Amount
          else if (c.x >= 330 && c.x < 370) current.rate = num(s);           // Rate
          else if (c.x >= 271 && c.x < 330) current.rateInclTax = num(s);    // Rate (incl. tax)
          else if (c.x >= 392 && c.x < 448) current.discountPct = num(s);    // Disc %
          continue;
        }
        if (/^[A-Z]{2,4}$/.test(s) && c.x >= 370 && c.x < 392) continue;     // per-unit label
      }
    }
  }
  pushCurrent();

  // de-dupe rows repeated on continuation pages (same serial + same values)
  const seen = new Set();
  result.items = result.items.filter((it) => {
    const k = `${it.serial}|${it.hsnCode}|${it.qty}|${it.amount}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  result.items.sort((a, b) => a.serial - b.serial);

  // ── Totals + validation ────────────────────────────────────────────────────
  result.sumOfItems = +result.items.reduce((s, it) => s + it.amount, 0).toFixed(2);

  const totalRowValues = [];
  for (const row of flat) {
    const hasTotal = row.cells.some((c) => /^Total\b/i.test(c.str.trim()));
    if (!hasTotal) continue;
    for (const c of row.cells) if (isMoney(c.str.trim())) totalRowValues.push(num(c.str.trim()));
  }
  if (totalRowValues.length) result.grandTotal = Math.max(...totalRowValues);

  // taxable total = the Total-row value matching Σitems (Tally prints "Total Taxable Value")
  const taxableCandidate = totalRowValues.find((v) => Math.abs(v - result.sumOfItems) <= 1.0);
  if (taxableCandidate != null) {
    result.taxableTotal = taxableCandidate;
    result.sumMatches = true;
  } else {
    // fall back: largest total below grand total (taxable < grand)
    const below = totalRowValues.filter((v) => result.grandTotal == null || v < result.grandTotal);
    result.taxableTotal = below.length ? Math.max(...below) : result.grandTotal;
    result.sumMatches = result.taxableTotal != null
      && Math.abs(result.sumOfItems - result.taxableTotal) <= 1.0;
  }
  if (!result.sumMatches) {
    result.warnings.push(
      `Line items sum to ₹${result.sumOfItems} but the invoice's taxable total appears to be ₹${result.taxableTotal} — items may be missing or misread. Review carefully before importing.`
    );
  }

  return result;
}

// ─── Generic heuristic parser (any DIGITAL/text-layer invoice) ─────────────────
// Layout-agnostic fallback for non-Tally invoices: reads the PDF's text and finds
// fields by PATTERN (not fixed column x-positions), so it works across most
// digital invoice formats. Cannot read scanned-image PDFs (no text layer). Output
// is the same shape as parseTallyInvoice and is always validated via sumMatches —
// the review screen lets the owner fix anything the heuristics miss.
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/;
const DATE_RE = /\b(\d{1,2}[-\/.](?:\d{1,2}|[A-Za-z]{3,9})[-\/.]\d{2,4})\b/;
const MONEY_RE = /[\d,]+\.\d{2}/;
const SKIP_ROW_RE = /\b(total|sub\s*total|taxable|cgst|sgst|igst|gst|tax|round|discount|amount\s*(?:in\s*words|chargeable|payable)|declaration|bank|terms|signature|e\.?\s*&\s*o\.?e|jurisdiction|hsn\s*summary|continued)\b/i;

export async function parseGenericInvoice(buffer) {
  const data = await pdfParse(buffer);
  const text = (data.text || '').replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const upper = text.toUpperCase();

  const result = {
    format: 'generic',
    supplierName: null, supplierGstin: null, invoiceNumber: null, invoiceDate: null,
    items: [], taxableTotal: null, grandTotal: null, sumOfItems: 0, sumMatches: false,
    warnings: [], pages: data.numpages || 1,
  };

  // ── Header fields by pattern ──────────────────────────────────────────────
  const gstinMatch = upper.match(GSTIN_RE);
  if (gstinMatch) result.supplierGstin = gstinMatch[0]; // first GSTIN ≈ the seller's (top of doc)

  for (const ln of lines) {
    if (!result.invoiceNumber) {
      const m = ln.match(/(?:invoice|bill|inv)\.?\s*(?:no|number|num|#)?\.?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\/\-]{1,30})/i);
      if (m && !/date/i.test(ln) && !DATE_RE.test(m[1])) result.invoiceNumber = m[1].trim();
    }
    if (!result.invoiceDate) {
      const m = ln.match(/(?:invoice\s*date|dated|date)\s*[:#-]?\s*(\d{1,2}[-\/.](?:\d{1,2}|[A-Za-z]{3,9})[-\/.]\d{2,4})/i) || ln.match(DATE_RE);
      if (m) result.invoiceDate = m[1];
    }
  }
  // Supplier name: first substantive line near the top that isn't a generic header.
  for (const ln of lines.slice(0, 8)) {
    if (/[A-Za-z]{3,}/.test(ln) && !/^(tax\s*invoice|invoice|bill|gstin|original|duplicate|proforma)/i.test(ln) && ln.length <= 60) {
      result.supplierName = ln.replace(/\s{2,}/g, ' ').trim();
      break;
    }
  }

  // ── Line items: rows shaped like "<desc> [hsn] <qty> [unit] <rate> <amount>" ─
  let serial = 0;
  for (const ln of lines) {
    if (SKIP_ROW_RE.test(ln)) continue;
    // Trailing two money values = rate + amount; an integer qty before them.
    const m = ln.match(/^(.+?)\s+(\d{1,6}(?:\.\d{1,3})?)\s+(?:[A-Za-z]{1,5}\s+)?(?:₹|rs\.?)?\s*([\d,]+\.\d{2})\s+(?:₹|rs\.?)?\s*([\d,]+\.\d{2})$/i);
    if (!m) continue;
    let name = m[1].replace(/^\d{1,3}[).\s]+/, '').trim();   // strip a leading serial
    if (!/[A-Za-z]{2,}/.test(name)) continue;                // need a real description
    let hsnCode = null;
    const hsn = name.match(/\b(\d{4,8})\b\s*$/);             // trailing HSN/SAC on the name
    if (hsn) { hsnCode = hsn[1]; name = name.replace(/\b\d{4,8}\b\s*$/, '').trim(); }
    const qty = Math.round(num(m[2]));
    const rate = num(m[3]);
    const amount = num(m[4]);
    if (!(qty > 0) || !(amount > 0)) continue;
    result.items.push({ serial: ++serial, partName: name.replace(/\s{2,}/g, ' '), hsnCode, qty, unit: null, rate, rateInclTax: null, discountPct: 0, amount });
  }

  // ── Totals + validation ───────────────────────────────────────────────────
  result.sumOfItems = +result.items.reduce((s, it) => s + it.amount, 0).toFixed(2);
  const moneyOnLabel = (re) => {
    const vals = [];
    for (const ln of lines) { if (re.test(ln)) { const mm = ln.match(MONEY_RE); if (mm) vals.push(num(mm[0])); } }
    return vals;
  };
  const grandVals = moneyOnLabel(/\b(grand\s*total|total\s*amount|invoice\s*total|amount\s*payable|net\s*payable|bill\s*total)\b/i);
  if (grandVals.length) result.grandTotal = Math.max(...grandVals);
  const taxableVals = moneyOnLabel(/\b(taxable|sub\s*total|subtotal|total\s*value|total\s*before\s*tax)\b/i);
  const taxMatch = taxableVals.find((v) => Math.abs(v - result.sumOfItems) <= 1.0);
  result.taxableTotal = taxMatch != null ? taxMatch : (taxableVals.length ? Math.max(...taxableVals) : result.grandTotal);
  result.sumMatches = result.taxableTotal != null && Math.abs(result.sumOfItems - result.taxableTotal) <= 1.0;
  if (!result.items.length) result.warnings.push('No line items detected — this invoice layout could not be read automatically. Add the items manually.');
  else if (!result.sumMatches) result.warnings.push(`Line items sum to ₹${result.sumOfItems} but the invoice total appears different — review for missing/misread rows.`);

  return result;
}
