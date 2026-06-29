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

// Service/charge items that appear on invoices but aren't auto parts.
// These should not be imported into inventory — they are one-time charges.
const SERVICE_ITEM_RE = /^(labour|labor|cartage|freight|handling|packing|courier|delivery\s*charg|loading|unloading|transportation|installation|service\s*charg|logistics|insurance|gate\s*pass|octroi|toll|misc(?:ellaneous)?|charges?)\b/i;

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
      const d = text.match(/\b(\d{1,2}[-/][A-Za-z0-9]{1,3}[-/]\d{2,4})\b/);
      if (d) result.invoiceDate = d[1];
    }
    if (!result.invoiceNumber) {
      // label cell "Invoice No." — value renders on a following row in the same column
      const label = flat[i].cells.find((c) => /^Invoice\s*No\.?$/i.test(c.str.trim()));
      if (label) {
        for (let j = i + 1; j < Math.min(i + 4, flat.length); j++) {
          const v = flat[j].cells.find((c) => Math.abs(c.x - label.x) < 30 && /^[\w/-]+$/.test(c.str.trim()) && !/^Dated$/i.test(c.str.trim()));
          if (v) { result.invoiceNumber = v.str.trim(); break; }
        }
      }
      // Fallback: "Invoice No. : RP/24-25/00147" on the same row
      if (!result.invoiceNumber) {
        const m = text.match(/Invoice\s*No\.?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9/-]{1,30})/i);
        if (m && !/^(date|no|num|number)\b/i.test(m[1])) result.invoiceNumber = m[1].trim();
      }
    }
  }

  // ── Auto-detect column X positions from the table header row ─────────────
  // Different Tally versions and print settings produce PDFs with different
  // page widths and column layouts. We read the actual X coordinates from the
  // "Description of Goods" header row instead of using hardcoded values.
  // Defaults match a common A4 Tally layout as fallback.
  const colX = { desc: 51, hsn: 158, qty: 230, rateIncl: 285, rateExcl: 330, per: 370, disc: 392, amount: 448 };
  for (const row of flat) {
    const joined = row.cells.map((c) => c.str).join(' ');
    if (!/Description\s+of\s+Goods/i.test(joined)) continue;
    let rateCount = 0;
    for (const c of row.cells) {
      const s = c.str.trim();
      if (/^description/i.test(s) || /\bgoods\b/i.test(s)) { colX.desc = Math.min(colX.desc, c.x); continue; }
      if (/^hsn/i.test(s) || /^sac$/i.test(s)) { colX.hsn = c.x; continue; }
      if (/^quantity$/i.test(s) || /^qty$/i.test(s)) { colX.qty = c.x; continue; }
      if (/^rate$/i.test(s)) {
        rateCount++;
        // Tally has "Rate (Incl. of Tax)" first, then bare "Rate" (excl.) to its right.
        // We keep the leftmost as rateIncl and the next as rateExcl.
        if (rateCount === 1) colX.rateIncl = c.x;
        else colX.rateExcl = c.x;
        continue;
      }
      if (/^per$/i.test(s)) { colX.per = c.x; continue; }
      if (/^disc/i.test(s)) { colX.disc = c.x; continue; }
      if (/^amount$/i.test(s)) { colX.amount = c.x; continue; }
    }
    break;
  }
  const T = 18; // x-position tolerance (pt) — handles minor layout variations

  // ── Line items via detected column classification ─────────────────────────
  let current = null;
  const pushCurrent = () => {
    if (!current) return;
    const name = (current.nameParts || []).join(' ').replace(/\s+/g, ' ').trim();
    if (current.amount != null && name && /[A-Za-z]{2,}/.test(name)) {
      current.partName = name;
      delete current.nameParts;
      if (SERVICE_ITEM_RE.test(current.partName)) {
        result.warnings.push(`Service charge excluded from import: "${current.partName}" (₹${current.amount}) — add manually if needed`);
        current = null;
        return;
      }
      // qty defaults to 1 when it couldn't be read — reviewer can correct it
      current.qty = current.qty ?? 1;
      if (!current.hsnCode) result.warnings.push(`HSN missing for item ${current.serial} ("${current.partName}") — review before importing`);
      current.mathOk = current.rateExclGst != null
        ? Math.abs(current.amount - current.rateExclGst * current.qty) < 0.05
        : true;
      if (!current.mathOk) result.warnings.push(`qty×rate ≠ amount for item ${current.serial}`);
      result.items.push(current);
    } else if (current.serial) {
      result.warnings.push(`Incomplete item row (serial ${current.serial}) — skipped`);
    }
    current = null;
  };

  for (const pageRows of allRows) {
    let inTable = false;
    for (const row of pageRows) {
      const joined = row.cells.map((c) => c.str).join(' ');
      if (/Description\s+of\s+Goods/i.test(joined)) { inTable = true; continue; }
      if (!inTable) continue;
      if (/\(Incl\.?\s*of\s*Tax\)/i.test(joined)) continue; // sub-header
      if (/continued/i.test(joined)) break;

      // Tax footer: stop collecting items when we hit CGST/SGST rows, round-off,
      // or specific footer labels. Use "Taxable Value" (not bare "Taxable") to avoid
      // false stops on column headers like "GST Rate" in item rows.
      const isFooterLabel = /^(OUTPUT\s|Less\s*:|.*ROUND\s*OFF)/i.test(joined);
      const isLoneSubtotal = row.cells.length === 1 && row.cells[0].x >= colX.amount - T && isMoney(row.cells[0].str.trim());
      if (isFooterLabel || isLoneSubtotal
        || /JURISDICTION|Computer Generated|Amount Chargeable|^Total\b|E\. ?& ?O\.E|Declaration|Taxable\s+Value|Output\s+(CGST|SGST|IGST)/i.test(joined)) {
        pushCurrent();
        inTable = false;
        continue;
      }

      // Serial number: just to the left of the description column
      const serialCell = row.cells.find((c) => c.x < colX.desc - 2 && /^\d{1,3}$/.test(c.str));
      if (serialCell) {
        pushCurrent();
        current = { serial: parseInt(serialCell.str, 10), nameParts: [], hsnCode: null, qty: null, unit: null, rateExclGst: null, rateInclGst: null, discountPct: 0, amount: null };
      }
      if (!current) continue;

      for (const c of row.cells) {
        const s = c.str.trim();
        if (!s) continue;
        if (c.x < colX.desc - 2) continue; // serial — already handled

        // Description: between desc column and just before hsn
        if (c.x < colX.hsn - T) { current.nameParts.push(s); continue; }

        // HSN/SAC: 4–8 digit code in the hsn column zone
        if (c.x < colX.qty - T && /^\d{4,8}$/.test(s)) { current.hsnCode = s; continue; }

        // Quantity: numeric value (with optional unit suffix) between hsn and rate columns.
        // Handles: "24", "24.00", "24 Nos", "24 sets", "24 pcs" — any case.
        // Note: Tally sometimes renders qty as "24.00" which satisfies isMoney — we
        // check the qty zone FIRST so it takes priority over the money-value block below.
        if (c.x >= colX.hsn + T && c.x < colX.rateIncl - T) {
          const qm = s.match(/^([\d,]+(?:\.\d+)?)\s*([A-Za-z]{1,8})?$/);
          if (qm) {
            const qv = Math.round(parseFloat(qm[1].replace(/,/g, '')));
            if (qv > 0 && qv < 1_000_000) {
              current.qty = qv;
              if (qm[2]) current.unit = qm[2].toUpperCase();
              continue; // skip isMoney block below
            }
          }
        }

        // Money values: classify by x-position zone relative to detected columns
        if (isMoney(s)) {
          if (c.x >= colX.amount - T) { current.amount = num(s); continue; }
          if (c.x >= colX.disc - T && c.x < colX.amount - T) { current.discountPct = num(s); continue; }
          if (c.x >= colX.rateExcl - T && c.x < colX.disc - T) { current.rateExclGst = num(s); continue; }
          if (c.x >= colX.rateIncl - T) { current.rateInclGst = num(s); continue; }
          continue;
        }

        // per-unit label (Nos, Set, sets, pcs…) in the per column — skip silently
        if (/^[A-Za-z]{1,8}$/.test(s) && c.x >= colX.per - T && c.x < colX.amount - T) continue;
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
      // Require a qualifier (No, No., #, number, num) so we don't match the bare word
      // "INVOICE" in document headers like "TAX INVOICE" and capture "OICE" as the number.
      const m = text.match(/(?:invoice|bill|inv)\b\.?\s*(?:no\.?\s*|number\s*|num\.?\s*|#\s*)[:#-]?\s*([A-Za-z0-9][A-Za-z0-9/-]{1,30})/i);
      if (m && !/^\d{1,2}[-/.]/.test(m[1]) && !/^(date|number|no|num)\b/i.test(m[1])) result.invoiceNumber = m[1].trim();
      // Fallback: "Invoice : ABC123" style (colon immediately after keyword)
      if (!result.invoiceNumber) {
        const m2 = text.match(/(?:invoice|bill)\b\s*:\s*([A-Za-z0-9][A-Za-z0-9/-]{2,30})/i);
        if (m2 && !/^(date|gst|gstin)\b/i.test(m2[1])) result.invoiceNumber = m2[1].trim();
      }
    }
  }
  for (const row of flat.slice(0, 12)) {
    const t = row.cells.map((c) => c.str).join(' ').trim();
    // Exclude document-type headers (any line containing "invoice", lines ending with "invoice",
    // GSTIN labels, and standard copy/format labels).
    const isDocHeader = /(?:(?:tax|gst)\s+invoice|\binvoice\b|\bbill\s+of\b|gstin|original\s+copy|duplicate|triplicate|proforma|credit\s+note|debit\s+note)/i.test(t);
    if (/[A-Za-z]{3,}/.test(t) && !isDocHeader && t.length <= 60) {
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
      if (/\b(grand\s*total|taxable\s*(value|amount|total)|cgst|sgst|igst|round\s*off|amount\s*chargeable|amount\s*in\s*words|declaration|bank\s*details|jurisdiction|e\.?\s*&\s*o\.?e|hsn\s*summary)\b/i.test(joined)) break;
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
        // Skip service/charge line items — they are one-time fees, not inventory parts.
        if (SERVICE_ITEM_RE.test(name)) {
          result.warnings.push(`Service charge excluded from import: "${name}" (₹${amount}) — add manually if needed`);
          continue;
        }
        const rateExclGst = rate;
        // Derive incl-GST rate using 18% (most common for auto parts) when no
        // separate column exists — the review UI lets the owner adjust before saving.
        const rateInclGst = rateExclGst != null ? +(rateExclGst * 1.18).toFixed(2) : null;
        result.items.push({ serial: ++serial, partName: name, hsnCode: hsn, qty: qty ?? 1, unit: null, rateExclGst, rateInclGst, discountPct: 0, amount });
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
  const grandVals = labelMoney(/\b(grand\s*total|total\s*amount|invoice\s*total|amount\s*payable|net\s*payable|bill\s*total|net\s*total|final\s*total|total\s*invoice\s*value|invoice\s*value)\b/i);
  // Fallback: last row containing "total" — its largest money value is the grand total.
  if (!grandVals.length) {
    const allTotalVals = labelMoney(/\btotal\b/i);
    if (allTotalVals.length) grandVals.push(Math.max(...allTotalVals));
  }
  if (grandVals.length) result.grandTotal = Math.max(...grandVals);
  const taxableVals = labelMoney(/\b(taxable|sub\s*total|subtotal|total\s*value|total\s*before\s*tax)\b/i);
  const taxMatch = taxableVals.find((v) => Math.abs(v - result.sumOfItems) <= 1.0);
  result.taxableTotal = taxMatch != null ? taxMatch : (taxableVals.length ? Math.max(...taxableVals) : result.grandTotal);
  result.sumMatches = result.taxableTotal != null && Math.abs(result.sumOfItems - result.taxableTotal) <= 1.0;
  if (!result.items.length) result.warnings.push('No line items detected — the table layout was not recognised. Add items manually.');
  else if (!result.sumMatches) result.warnings.push(`Line items sum to ₹${result.sumOfItems} but the invoice total appears different — review for missing/misread rows.`);

  return result;
}
