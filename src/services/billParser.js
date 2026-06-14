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

// ─── Generic parser (any DIGITAL/text-layer invoice, any layout) ───────────────
// Unlike the Tally parser (hardcoded column x-positions), this DETECTS the table's
// header row and reads each column's actual x-position FROM THAT INVOICE, then
// classifies every data row's cells by which column they fall under. So it adapts
// to differently-organised invoices. Cannot read scanned-image PDFs (no text layer).
// Output matches parseTallyInvoice and is validated via sumMatches.
const moneyRe = (s) => /^[₹]?\s*[\d,]+(?:\.\d{1,2})?$/.test(String(s).trim());
const cleanMoney = (s) => num(String(s).replace(/[₹\s]/g, ''));

export async function parseGenericInvoice(buffer) {
  const allRows = [];
  await pdfParse(buffer, {
    pagerender: async (pageData) => { const tc = await pageData.getTextContent(); allRows.push(pageToRows(tc)); return ''; },
  });
  const flat = allRows.flat();

  const result = {
    format: 'generic', supplierName: null, supplierGstin: null, invoiceNumber: null, invoiceDate: null,
    items: [], taxableTotal: null, grandTotal: null, sumOfItems: 0, sumMatches: false,
    warnings: [], pages: allRows.length,
  };

  // ── Header metadata (by pattern, anywhere on the page) ─────────────────────
  for (const row of flat) {
    const text = row.cells.map((c) => c.str).join(' ');
    if (!result.supplierGstin) { const g = text.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/i); if (g) result.supplierGstin = g[0].toUpperCase(); }
    if (!result.invoiceDate) { const d = text.match(/\b(\d{1,2}[-/.](?:\d{1,2}|[A-Za-z]{3,9})[-/.]\d{2,4})\b/); if (d) result.invoiceDate = d[1]; }
    if (!result.invoiceNumber) {
      const m = text.match(/(?:invoice|bill|inv)\.?\s*(?:no|number|num|#)?\.?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9/-]{1,30})/i);
      if (m && !/^\d{1,2}[-/.]/.test(m[1]) && !/^date$/i.test(m[1])) result.invoiceNumber = m[1].trim();
    }
  }
  for (const row of flat.slice(0, 12)) {
    const t = row.cells.map((c) => c.str).join(' ').trim();
    if (/[A-Za-z]{3,}/.test(t) && !/^(tax\s*invoice|invoice|gstin|original|duplicate|triplicate|proforma|bill\s*of|credit\s*note|debit\s*note)\b/i.test(t) && t.length <= 60) {
      result.supplierName = t.replace(/\s{2,}/g, ' '); break;
    }
  }

  // ── Detect the table header row + each column's x-position ─────────────────
  const COL_RE = {
    description: /desc|particular|item|product|goods|^name$/i,
    hsn: /hsn|sac/i,
    qty: /qty|quantity/i,
    rate: /rate|price|mrp/i,
    amount: /amount|value|^total$/i,
  };
  let headerIdx = -1, cols = null;
  for (let i = 0; i < flat.length; i++) {
    const joined = flat[i].cells.map((c) => c.str).join(' ').toLowerCase();
    const hasDesc = /desc|particular|item|goods|product|\bname\b/.test(joined);
    const hasNum = /qty|quantity|rate|price|amount|value/.test(joined);
    if (!(hasDesc && hasNum)) continue;
    const cmap = {};
    for (const c of flat[i].cells) {
      const s = c.str.trim().toLowerCase();
      for (const [role, re] of Object.entries(COL_RE)) { if (re.test(s) && cmap[role] == null) cmap[role] = c.x; }
    }
    if (cmap.description != null && (cmap.amount != null || cmap.qty != null)) { headerIdx = i; cols = cmap; break; }
  }

  if (cols) {
    const ordered = Object.entries(cols).filter(([, x]) => x != null).sort((a, b) => a[1] - b[1]);
    const roleAtX = (x) => { let best = null, bd = Infinity; for (const [r, cx] of ordered) { const d = Math.abs(x - cx); if (d < bd) { bd = d; best = r; } } return best; };
    const firstNumX = Math.min(...[cols.hsn, cols.qty, cols.rate, cols.amount].filter((v) => v != null));
    let serial = 0;
    for (let i = headerIdx + 1; i < flat.length; i++) {
      const row = flat[i];
      const joined = row.cells.map((c) => c.str).join(' ');
      // Hard stop at the totals/footer block.
      if (/\b(grand\s*total|taxable|cgst|sgst|igst|round\s*off|amount\s*chargeable|amount\s*in\s*words|declaration|bank\s*details|jurisdiction|e\.?\s*&\s*o\.?e|hsn\s*summary)\b/i.test(joined)) break;
      if (/^\s*(total|sub\s*total)\b/i.test(joined.trim())) continue;

      let descParts = [], qty = null, rate = null, amount = null, hsn = null;
      for (const c of row.cells) {
        const s = c.str.trim();
        if (!s) continue;
        if (c.x < firstNumX - 5) { descParts.push(s); continue; }
        const role = roleAtX(c.x);
        if (role === 'hsn' && /^\d{4,8}$/.test(s)) { hsn = s; continue; }
        if (role === 'qty') { const q = s.match(/(\d[\d,]*)/); if (q) qty = parseInt(q[1].replace(/,/g, ''), 10); continue; }
        if (role === 'rate' && moneyRe(s)) { rate = cleanMoney(s); continue; }
        if (role === 'amount' && moneyRe(s)) { amount = cleanMoney(s); continue; }
        if (moneyRe(s) && amount == null && c.x >= (cols.amount ?? firstNumX)) amount = cleanMoney(s);
      }
      const name = descParts.join(' ').replace(/^\d{1,3}[).\s]+/, '').replace(/\s{2,}/g, ' ').trim();
      if (name && /[A-Za-z]{2,}/.test(name) && amount != null && amount > 0) {
        result.items.push({ serial: ++serial, partName: name, hsnCode: hsn, qty: qty ?? 1, unit: null, rate, rateInclTax: null, discountPct: 0, amount });
      }
    }
  }

  // ── Totals + validation ───────────────────────────────────────────────────
  result.sumOfItems = +result.items.reduce((s, it) => s + (it.amount || 0), 0).toFixed(2);
  const labelMoney = (re) => {
    const vals = [];
    for (const row of flat) { const t = row.cells.map((c) => c.str).join(' '); if (re.test(t)) for (const c of row.cells) { const s = c.str.trim(); if (/^[\d,]+\.\d{2}$/.test(s)) vals.push(num(s)); } }
    return vals;
  };
  const grandVals = labelMoney(/\b(grand\s*total|total\s*amount|invoice\s*total|amount\s*payable|net\s*payable|bill\s*total)\b/i);
  if (grandVals.length) result.grandTotal = Math.max(...grandVals);
  const taxableVals = labelMoney(/\b(taxable|sub\s*total|subtotal|total\s*value|total\s*before\s*tax)\b/i);
  const taxMatch = taxableVals.find((v) => Math.abs(v - result.sumOfItems) <= 1.0);
  result.taxableTotal = taxMatch != null ? taxMatch : (taxableVals.length ? Math.max(...taxableVals) : result.grandTotal);
  result.sumMatches = result.taxableTotal != null && Math.abs(result.sumOfItems - result.taxableTotal) <= 1.0;
  if (!result.items.length) result.warnings.push('No line items detected — the table layout was not recognised. Add items manually.');
  else if (!result.sumMatches) result.warnings.push(`Line items sum to ₹${result.sumOfItems} but the invoice total appears different — review for missing/misread rows.`);

  return result;
}
