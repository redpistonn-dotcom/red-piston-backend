import PdfPrinter from 'pdfmake';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fonts = {
  Roboto: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

const printer = new PdfPrinter(fonts);

// ─── Date helper ──────────────────────────────────────────────────────────────
// Always render invoice dates in IST. Production servers run in UTC, so a bill
// created early morning IST (e.g. 03:00 IST = 21:30 UTC the previous day) would
// otherwise print the previous day's date. Forcing Asia/Kolkata fixes that.
function fmtDateIST(value, opts = { day: '2-digit', month: 'short', year: 'numeric' }) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-IN', { ...opts, timeZone: 'Asia/Kolkata' });
}

// ─── GST breakup helper ───────────────────────────────────────────────────────
// Groups line items by their GST rate and returns CGST/SGST rows carrying the
// applicable percentage, e.g. [ ['OUTPUT CGST @ 9%', '245.00'], ['OUTPUT SGST @ 9%', '245.00'] ].
// For a single-rate invoice this yields one CGST + one SGST row; mixed-rate
// invoices produce a labelled pair per rate. Falls back to the invoice-level
// totals (with a derived rate) when line items lack per-item tax fields.
function gstSummaryRows(items, invoiceCgst, invoiceSgst, subtotal) {
  const byRate = new Map();
  for (const it of (items || [])) {
    const rate = Number(it.gstRate || 0);
    if (rate <= 0) continue;
    const cur = byRate.get(rate) || { cgst: 0, sgst: 0 };
    cur.cgst += Number(it.cgst || 0);
    cur.sgst += Number(it.sgst || 0);
    byRate.set(rate, cur);
  }

  // Fallback: no usable per-item tax data → derive a single rate from totals.
  if (byRate.size === 0) {
    const derived = subtotal > 0 ? (Number(invoiceCgst) / subtotal) * 100 : 0;
    const half = fmtPct(derived);
    return [
      [`OUTPUT CGST${half ? ` @ ${half}%` : ''}`, Number(invoiceCgst).toFixed(2)],
      [`OUTPUT SGST${half ? ` @ ${half}%` : ''}`, Number(invoiceSgst).toFixed(2)],
    ];
  }

  const rows = [];
  for (const rate of [...byRate.keys()].sort((a, b) => a - b)) {
    const { cgst, sgst } = byRate.get(rate);
    const half = fmtPct(rate / 2);
    rows.push([`OUTPUT CGST @ ${half}%`, cgst.toFixed(2)]);
    rows.push([`OUTPUT SGST @ ${half}%`, sgst.toFixed(2)]);
  }
  return rows;
}

// Format a percentage without trailing ".00" (9 not 9.00, 2.5 stays 2.5).
function fmtPct(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

// ─── Image helper ────────────────────────────────────────────────────────────
async function fetchImageAsDataUri(url) {
  if (!url) return null;
  try {
    const buf = await new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      protocol.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
    const mime = url.match(/\.(png|jpg|jpeg|webp)/i)?.[1]?.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// ─── Number to words (Indian system) ─────────────────────────────────────────
function numberToWords(num) {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const n = Math.floor(num);
  if (n === 0) return 'Zero';
  function convert(n) {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : '');
    if (n < 1000) return a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + convert(n % 100) : '');
    if (n < 100000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + convert(n % 1000) : '');
    if (n < 10000000) return convert(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + convert(n % 100000) : '');
    return convert(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + convert(n % 10000000) : '');
  }
  return 'INR ' + convert(n) + ' Only';
}

// ─── Shared seller block (top-left of header) ─────────────────────────────────
// Builds the seller info stack used in every page header
function sellerStack(shop) {
  const shopName   = shop?.name   || 'Shri Mahesh Automobiles';
  const shopAddr   = [shop?.address, shop?.city, shop?.state, shop?.pincode].filter(Boolean).join(', ');
  const shopPhone  = shop?.phone  || shop?.whatsappNumber || '';
  const shopGstin  = shop?.gstin  || '';
  const shopEmail  = shop?.email  || '';
  const shopState  = shop?.state  || '';
  const shopStateCode = shop?.stateCode || '';

  const lines = [
    { text: shopName, bold: true, fontSize: 9 },
  ];
  if (shopAddr) lines.push({ text: shopAddr, fontSize: 8 });
  if (shopPhone) lines.push({ text: `Ph : ${shopPhone}`, fontSize: 8 });
  if (shopGstin) lines.push({ text: `GSTIN/UIN : ${shopGstin}`, fontSize: 8 });
  if (shopState) lines.push({ text: `State Name : ${shopState}${shopStateCode ? ', Code : ' + shopStateCode : ''}`, fontSize: 8 });
  if (shopEmail) lines.push({ text: `E-Mail : ${shopEmail}`, fontSize: 8 });
  return lines;
}

// ─── Invoice fields grid (top-right of header) ───────────────────────────────
// Two-column key/value table matching the screenshot
function invoiceFieldsTable(fields) {
  // fields: array of [label, value] pairs, rendered as a 4-column table (label | value | label | value)
  const rows = [];
  for (let i = 0; i < fields.length; i += 2) {
    const left  = fields[i]   || ['', ''];
    const right = fields[i+1] || ['', ''];
    rows.push([
      { text: left[0],  fontSize: 8, bold: true,  border: [true, true, false, true] },
      { text: left[1],  fontSize: 8,               border: [false, true, true, true] },
      { text: right[0], fontSize: 8, bold: true,  border: [true, true, false, true] },
      { text: right[1], fontSize: 8,               border: [false, true, true, true] },
    ]);
  }
  return {
    table: {
      widths: [70, 80, 70, '*'],
      body: rows,
    },
    layout: {
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
      hLineWidth: () => 0.4,
      vLineWidth: () => 0.4,
    },
  };
}

// ─── Per-page header builder ──────────────────────────────────────────────────
// pageNum: 1-based, totalPages: optional hint, invoice: full invoice object
function buildPageHeader(shop, invoiceFields, buyerBlock, pageNum, title, invoiceNo, dated) {
  const pageLabel = pageNum === 1 ? title : `${title}(Page  ${pageNum})`;

  return [
    // Title row
    {
      text: pageLabel,
      fontSize: 11,
      bold: true,
      alignment: 'center',
      margin: [0, 0, 0, 2],
    },
    // Main header box: seller left | invoice fields right
    {
      table: {
        widths: ['38%', '62%'],
        body: [[
          // LEFT: seller info (spans consignee + buyer rows visually via rowSpan trick)
          {
            stack: sellerStack(shop),
            border: [true, true, false, true],
            margin: [2, 2, 2, 2],
          },
          // RIGHT: invoice fields grid
          {
            stack: [invoiceFieldsTable(invoiceFields)],
            border: [true, true, true, true],
            margin: [0, 0, 0, 0],
          },
        ]],
      },
      layout: {
        hLineColor: () => '#000000',
        vLineColor: () => '#000000',
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
      },
      margin: [0, 0, 0, 0],
    },
    // Buyer (Bill to) block
    {
      table: {
        widths: ['100%'],
        body: [[
          { stack: buyerBlock, border: [true, false, true, true], margin: [2, 2, 2, 2], fontSize: 8 },
        ]],
      },
      layout: {
        hLineColor: () => '#000000',
        vLineColor: () => '#000000',
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
      },
      margin: [0, 0, 0, 0],
    },
  ];
}

// ─── Dynamic product table header & widths ────────────────────────────────────
function productTableHeader({ showOem = false, showMrp = false } = {}) {
  const cols = [
    { text: 'Sl\nNo.', bold: true, alignment: 'center', fontSize: 8, fillColor: '#F3F4F6' },
    { text: 'Description of Goods', bold: true, fontSize: 8, fillColor: '#F3F4F6' },
  ];
  if (showOem) cols.push({ text: 'OEM No.', bold: true, alignment: 'center', fontSize: 8, fillColor: '#F3F4F6' });
  cols.push(
    { text: 'HSN/SAC', bold: true, alignment: 'center', fontSize: 8, fillColor: '#F3F4F6' },
    { text: 'Quantity', bold: true, alignment: 'center', fontSize: 8, fillColor: '#F3F4F6' },
    { text: 'Rate\n(Incl. of Tax)', bold: true, alignment: 'center', fontSize: 8, fillColor: '#F3F4F6' }
  );
  if (showMrp) cols.push({ text: 'MRP', bold: true, alignment: 'right', fontSize: 8, fillColor: '#F3F4F6' });
  cols.push(
    { text: 'Rate', bold: true, alignment: 'center', fontSize: 8, fillColor: '#F3F4F6' },
    { text: 'per', bold: true, alignment: 'center', fontSize: 8, fillColor: '#F3F4F6' },
    { text: 'Disc.\n%', bold: true, alignment: 'center', fontSize: 8, fillColor: '#F3F4F6' },
    { text: 'Amount', bold: true, alignment: 'right', fontSize: 8, fillColor: '#F3F4F6' }
  );
  return cols;
}

function getTableWidths({ showOem = false, showMrp = false } = {}) {
  if (showOem && showMrp) return [22, '*', 56, 45, 40, 48, 42, 42, 22, 28, 56];
  if (showOem) return [24, '*', 60, 48, 44, 52, 46, 24, 32, 60];
  if (showMrp) return [24, '*', 50, 44, 52, 44, 46, 24, 32, 60];
  return ['*', 60, 60, 28, 60, 50, 28, 40, 70];
}

// ─── Per-page footer ──────────────────────────────────────────────────────────
function buildPageFooter() {
  return [
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#999999' }] },
    { text: 'SUBJECT TO HYDERABAD JURISDICTION', fontSize: 7, alignment: 'center', margin: [0, 2, 0, 0] },
    { text: 'This is a Computer Generated Invoice', fontSize: 7, alignment: 'center', margin: [0, 1, 0, 0] },
  ];
}

// ─── Last-page summary/footer block ──────────────────────────────────────────
function buildLastPageSummary(invoice, totalQty) {
  const subtotal    = Number(invoice.subtotal    || 0);
  const cgst        = Number(invoice.cgst        || 0);
  const sgst        = Number(invoice.sgst        || 0);
  const totalAmount = Number(invoice.totalAmount || 0);
  const roundOff    = Number(invoice.roundOff    || 0);
  const pan         = invoice.shop?.pan || '';

  const summaryRows = [
    ...gstSummaryRows(invoice.items, cgst, sgst, subtotal),
    ['ROUND OFF',    `${roundOff !== 0 ? (roundOff > 0 ? '' : '(-)') + Math.abs(roundOff).toFixed(2) : '0.00'}`],
    ['Total',        `${totalAmount.toFixed(2)}`, true],
  ];

  return [
    // Summary rows (right-aligned, spanning the last column area)
    {
      table: {
        widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
        body: summaryRows.map(([label, value, bold]) => [
          { text: '', border: [true, false, false, false] },
          { text: '', border: [false, false, false, false] },
          { text: '', border: [false, false, false, false] },
          { text: '', border: [false, false, false, false] },
          { text: '', border: [false, false, false, false] },
          { text: label, bold: !!bold, fontSize: bold ? 9 : 8, italics: !bold, border: [false, false, false, bold ? true : false], colSpan: 3 },
          {}, {},
          { text: value, bold: !!bold, fontSize: bold ? 9 : 8, alignment: 'right', border: [false, false, true, bold ? true : false] },
        ]),
      },
      layout: {
        hLineColor: () => '#000000',
        vLineColor: () => '#000000',
        hLineWidth: () => 0.4,
        vLineWidth: () => 0.4,
      },
      margin: [0, 0, 0, 0],
    },
    // Total row
    {
      table: {
        widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
        body: [[
          { text: 'Total', bold: true, fontSize: 9, border: [true, true, false, true] },
          { text: '', border: [false, true, false, true] },
          { text: '', border: [false, true, false, true] },
          { text: `${totalQty} NOS`, bold: true, fontSize: 9, alignment: 'center', border: [false, true, false, true] },
          { text: '', border: [false, true, false, true] },
          { text: '', border: [false, true, false, true] },
          { text: '', border: [false, true, false, true] },
          { text: '', border: [false, true, false, true] },
          { text: `₹ ${totalAmount.toFixed(2)}`, bold: true, fontSize: 9, alignment: 'right', border: [false, true, true, true] },
        ]],
      },
      layout: {
        hLineColor: () => '#000000',
        vLineColor: () => '#000000',
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
      },
      margin: [0, 0, 0, 0],
    },
    // Amount in words + E. & O.E.
    {
      columns: [
        { text: `Amount Chargeable (in words)\n${numberToWords(totalAmount)}`, fontSize: 8, width: '*' },
        { text: 'E. & O.E', fontSize: 8, alignment: 'right', width: 'auto' },
      ],
      margin: [0, 4, 0, 4],
    },
    // PAN + Declaration + Signatory
    {
      table: {
        widths: ['60%', '40%'],
        body: [[
          {
            stack: [
              pan ? { text: `Company's PAN    :  ${pan}`, fontSize: 8, bold: true } : { text: '' },
              { text: 'Declaration', fontSize: 8, bold: true, margin: [0, 4, 0, 0] },
              { text: '1. GOODS ONCE SOLD NOT TAKEN BACK', fontSize: 7, italics: true },
              { text: "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.", fontSize: 7, italics: true },
            ],
            border: [true, true, false, true],
            margin: [2, 2, 2, 2],
          },
          {
            stack: [
              { text: `for ${invoice.shop?.name || 'Shri Mahesh Automobiles'}`, fontSize: 8, alignment: 'center' },
              { text: '\n\n\n', fontSize: 8 },
              { text: 'Authorised Signatory', fontSize: 8, alignment: 'center' },
            ],
            border: [true, true, true, true],
            margin: [2, 2, 2, 2],
          },
        ]],
      },
      layout: {
        hLineColor: () => '#000000',
        vLineColor: () => '#000000',
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
      },
      margin: [0, 0, 0, 6],
    },
  ];
}

// ─── TAX INVOICE PDF ──────────────────────────────────────────────────────────
export const generateInvoicePdf = async (invoice, opts = {}) => {
  const { items, shop } = invoice;
  const showOem = opts.showOem === true || opts.showOem === 'true';
  const showMrp = opts.showMrp === true || opts.showMrp === 'true';

  const logoUrl    = shop?.logoUrl || shop?.photoUrl || null;
  const logoDataUri = await fetchImageAsDataUri(logoUrl);

  const dateStr = fmtDateIST(invoice.createdAt);

  // Invoice fields for the right-side grid (label/value pairs, 2 per row)
  const orderIdVal = String(invoice.invoiceId || invoice.orderNo || invoice.marketplaceOrderId || '');
  const invoiceFields = [
    ['Invoice No.', String(invoice.invoiceNumber || '')],
    ['Dated', dateStr],
    ['Order ID', orderIdVal],
    ['Mode/Terms of Payment', invoice.paymentMode || ''],
    ['Terms of Delivery', invoice.termsOfDelivery || ''],
    ['', ''],
  ];

  // Buyer block
  const buyerBlock = [
    { text: 'Buyer (Bill to)', bold: true, fontSize: 8 },
    { text: invoice.partyName || 'Walk-in Customer', bold: true, fontSize: 9, margin: [0, 1, 0, 2] },
  ];
  if (invoice.partyPhone)     buyerBlock.push({ text: `Phone        :  ${invoice.partyPhone}`, fontSize: 8, margin: [0, 1, 0, 1] });
  if (invoice.billingAddress || invoice.customerAddress) buyerBlock.push({ text: invoice.billingAddress || invoice.customerAddress, fontSize: 8, margin: [0, 1, 0, 1] });
  if (invoice.partyGstin)     buyerBlock.push({ text: `GSTIN/UIN    :  ${invoice.partyGstin}`, fontSize: 8, margin: [0, 1, 0, 1] });
  if (shop?.state)            buyerBlock.push({ text: `State Name   :  ${shop.state}${shop.stateCode ? ', Code : ' + shop.stateCode : ''}`, fontSize: 8, margin: [0, 1, 0, 1] });
  if (invoice.vehicleReg)     buyerBlock.push({ text: `Vehicle Reg  :  ${invoice.vehicleReg}`, fontSize: 8, bold: true, margin: [0, 1, 0, 1] });
  if (invoice.notes)          buyerBlock.push({ text: `Remarks      :  ${invoice.notes}`, fontSize: 8, margin: [0, 1, 0, 1] });

  // Product rows
  const itemRows = items.map((item, idx) => {
    const oemVal = item.oemNumber || item.inventory?.masterPart?.primaryOemNumber || (Array.isArray(item.inventory?.masterPart?.oemNumbers) ? item.inventory.masterPart.oemNumbers[0] : '') || '—';
    const mrpVal = item.mrp !== undefined && item.mrp !== null ? Number(item.mrp).toFixed(2) : (item.inventory?.masterPart?.mrp ? Number(item.inventory.masterPart.mrp).toFixed(2) : '—');
    const row = [
      { text: String(idx + 1),                           alignment: 'center', fontSize: 8 },
      { text: [item.partName, item.brand].filter(Boolean).join(' — '), fontSize: 8 },
    ];
    if (showOem) row.push({ text: oemVal, alignment: 'center', fontSize: 8 });
    row.push(
      { text: item.hsnCode || '',                        alignment: 'center', fontSize: 8 },
      { text: `${item.qty} NOS`,                         alignment: 'center', fontSize: 8, bold: true },
      { text: (Number(item.total) / Number(item.qty)).toFixed(2), alignment: 'right', fontSize: 8 }
    );
    if (showMrp) row.push({ text: mrpVal, alignment: 'right', fontSize: 8 });
    row.push(
      { text: Number(item.unitPrice).toFixed(2),         alignment: 'right',  fontSize: 8 },
      { text: 'NOS',                                     alignment: 'center', fontSize: 8 },
      { text: item.discountPercent ? `${item.discountPercent}` : '', alignment: 'center', fontSize: 8 },
      { text: Number(item.total).toFixed(2),             alignment: 'right',  fontSize: 8 }
    );
    return row;
  });

  const totalQty = items.reduce((s, i) => s + Number(i.qty), 0);

  const pageHeader = buildPageHeader(shop, invoiceFields, buyerBlock, 1, 'TAX INVOICE', invoice.invoiceNumber, dateStr);

  const docDef = {
    pageSize: 'A4',
    pageMargins: [30, 175, 30, 60],

    // Repeating header on every page
    header: (currentPage) => {
      const pageHeaderN = buildPageHeader(shop, invoiceFields, buyerBlock, currentPage, 'TAX INVOICE', invoice.invoiceNumber, dateStr);
      return { stack: pageHeaderN, margin: [30, 20, 30, 0] };
    },

    // Repeating footer on every page
    footer: () => ({
      stack: buildPageFooter(),
      margin: [30, 0, 30, 10],
    }),

    content: [

      // Product table
      {
        table: {
          headerRows: 1,
          widths: getTableWidths({ showOem, showMrp }),
          body: [productTableHeader({ showOem, showMrp }), ...itemRows],
          dontBreakRows: false,
          keepWithHeaderRows: 1,
        },
        layout: {
          hLineColor: () => '#000000',
          vLineColor: () => '#000000',
          hLineWidth: () => 0.4,
          vLineWidth: () => 0.4,
        },
        margin: [0, 0, 0, 0],
      },

      // Last-page summary/footer
      ...buildLastPageSummary(invoice, totalQty),
    ],

    styles: {
      header: { fontSize: 9, color: '#374151' },
    },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#374151' },
  };

  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDef);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
};

// ─── EXCHANGE INVOICE PDF ──────────────────────────────────────────────────────
// Two sections: Returned Items + New Items Issued, same header/footer design
export const generateExchangeInvoicePdf = async (exchangeOrder) => {
  const { salesReturn, newInvoice, shop } = exchangeOrder || {};
  const creditNote = salesReturn?.creditNote;

  const logoUrl    = shop?.logoUrl || shop?.photoUrl || null;
  const logoDataUri = await fetchImageAsDataUri(logoUrl);

  const dateStr = fmtDateIST(newInvoice?.createdAt);
  const originalInvoiceNo = salesReturn?.invoice?.invoiceNumber || '';

  const orderIdVal = String(newInvoice?.invoiceId || newInvoice?.orderNo || exchangeOrder?.exchangeId || '');
  const invoiceFields = [
    ['Exchange No.', String(exchangeOrder?.exchangeNo || '')],
    ['Dated', dateStr],
    ['New Invoice No.', String(newInvoice?.invoiceNumber || '')],
    ['Order ID', orderIdVal],
    ['Return No.', String(salesReturn?.returnNo || salesReturn?.returnId || '')],
    ['Original Invoice', originalInvoiceNo],
    ['Mode/Terms of Payment', newInvoice?.paymentMode || ''],
    ['Reason', (salesReturn?.reason || '').replace(/_/g, ' ')],
  ];

  const partyName  = newInvoice?.partyName  || salesReturn?.party?.name  || 'Walk-in Customer';
  const partyPhone = newInvoice?.partyPhone || salesReturn?.party?.phone || '';
  const partyGstin = newInvoice?.partyGstin || salesReturn?.party?.gstin || '';
  const partyAddr  = newInvoice?.billingAddress || newInvoice?.customerAddress || '';

  const buyerBlock = [
    { text: 'Customer (Bill to)', bold: true, fontSize: 8 },
    { text: partyName, bold: true, fontSize: 9, margin: [0, 1, 0, 2] },
  ];
  if (partyPhone) buyerBlock.push({ text: `Phone        :  ${partyPhone}`, fontSize: 8, margin: [0, 1, 0, 1] });
  if (partyAddr)  buyerBlock.push({ text: partyAddr, fontSize: 8, margin: [0, 1, 0, 1] });
  if (partyGstin) buyerBlock.push({ text: `GSTIN/UIN    :  ${partyGstin}`, fontSize: 8, margin: [0, 1, 0, 1] });
  if (shop?.state) buyerBlock.push({ text: `State Name   :  ${shop.state}${shop.stateCode ? ', Code : ' + shop.stateCode : ''}`, fontSize: 8, margin: [0, 1, 0, 1] });
  if (newInvoice?.vehicleReg) buyerBlock.push({ text: `Vehicle Reg  :  ${newInvoice.vehicleReg}`, fontSize: 8, bold: true, margin: [0, 1, 0, 1] });
  if (newInvoice?.notes) buyerBlock.push({ text: `Remarks      :  ${newInvoice.notes}`, fontSize: 8, margin: [0, 1, 0, 1] });

  // Returned items rows
  const oldItemRows = (salesReturn?.items || []).map((item, idx) => {
    const name = item.invoiceItem?.partName || item.inventory?.masterPart?.partName || 'Item';
    const hsn  = item.invoiceItem?.hsnCode  || item.inventory?.masterPart?.hsnCode  || '';
    const amt  = Number(item.taxableValue || 0) + Number(item.cgst || 0) + Number(item.sgst || 0);
    return [
      { text: String(idx + 1),                  alignment: 'center', fontSize: 8 },
      { text: name,                              fontSize: 8 },
      { text: hsn,                               alignment: 'center', fontSize: 8 },
      { text: `${item.qty || 0} NOS`,                 alignment: 'center', fontSize: 8, bold: true },
      { text: Number(item.unitPrice || 0).toFixed(2), alignment: 'right',  fontSize: 8 },
      { text: Number(item.unitPrice || 0).toFixed(2), alignment: 'right',  fontSize: 8 },
      { text: 'NOS',                             alignment: 'center', fontSize: 8 },
      { text: '',                                alignment: 'center', fontSize: 8 },
      { text: amt.toFixed(2),                    alignment: 'right',  fontSize: 8 },
    ];
  });

  // New items rows
  const newItemRows = (newInvoice?.items || []).map((item, idx) => [
    { text: String(idx + 1),                               alignment: 'center', fontSize: 8 },
    { text: [item.partName, item.brand].filter(Boolean).join(' — '), fontSize: 8 },
    { text: item.hsnCode || '',                            alignment: 'center', fontSize: 8 },
    { text: `${item.qty || 0} NOS`,                             alignment: 'center', fontSize: 8, bold: true },
    { text: Number(item.unitPrice || 0).toFixed(2),             alignment: 'right',  fontSize: 8 },
    { text: Number(item.unitPrice || 0).toFixed(2),             alignment: 'right',  fontSize: 8 },
    { text: 'NOS',                                         alignment: 'center', fontSize: 8 },
    { text: item.discountPercent ? `${item.discountPercent}` : '', alignment: 'center', fontSize: 8 },
    { text: Number(item.total || 0).toFixed(2),                 alignment: 'right',  fontSize: 8 },
  ]);

  const oldTotal   = Number(creditNote?.totalAmount || 0);
  const newTotal   = Number(newInvoice?.totalAmount  || 0);
  const netAmount  = Number(exchangeOrder?.netAmount || 0);
  const settlementLabel = exchangeOrder?.settlementType === 'COLLECT'
    ? 'Additional Amount Collected'
    : exchangeOrder?.settlementType === 'REFUND'
    ? 'Refund / Credit Balance'
    : 'Even Exchange — No Balance Due';

  const totalQtyOld = (salesReturn?.items || []).reduce((s, i) => s + Number(i.qty || 0), 0);
  const totalQtyNew = (newInvoice?.items || []).reduce((s, i) => s + Number(i.qty || 0), 0);

  const pageHeader = buildPageHeader(shop, invoiceFields, buyerBlock, 1, 'EXCHANGE INVOICE', exchangeOrder.exchangeNo, dateStr);

  const tableLayout = {
    hLineColor: () => '#000000',
    vLineColor: () => '#000000',
    hLineWidth: () => 0.4,
    vLineWidth: () => 0.4,
  };

  const docDef = {
    pageSize: 'A4',
    pageMargins: [30, 175, 30, 60],

    header: (currentPage) => {
      const pageHeaderN = buildPageHeader(shop, invoiceFields, buyerBlock, currentPage, 'EXCHANGE INVOICE', exchangeOrder.exchangeNo, dateStr);
      return { stack: pageHeaderN, margin: [30, 20, 30, 0] };
    },

    footer: () => ({
      stack: buildPageFooter(),
      margin: [30, 0, 30, 10],
    }),

    content: [

      // Returned items section
      { text: 'RETURNED ITEM(S)', bold: true, fontSize: 9, color: '#8B1E1E', margin: [0, 4, 0, 2] },
      {
        table: {
          headerRows: 1,
          widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
          body: [productTableHeader(), ...oldItemRows],
        },
        layout: tableLayout,
        margin: [0, 0, 0, 0],
      },
      // Old total row
      {
        table: {
          widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
          body: [[
            { text: 'Returned Total', bold: true, fontSize: 8 },
            {}, {}, { text: `${totalQtyOld} NOS`, alignment: 'center', fontSize: 8, bold: true },
            {}, {}, {}, {},
            { text: `₹ ${oldTotal.toFixed(2)}`, bold: true, alignment: 'right', fontSize: 8 },
          ]],
        },
        layout: tableLayout,
        margin: [0, 0, 0, 10],
      },

      // New items section
      { text: 'NEW ITEM(S) ISSUED', bold: true, fontSize: 9, color: '#8B1E1E', margin: [0, 4, 0, 2] },
      {
        table: {
          headerRows: 1,
          widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
          body: [productTableHeader(), ...newItemRows],
        },
        layout: tableLayout,
        margin: [0, 0, 0, 0],
      },
      // New total row
      {
        table: {
          widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
          body: [[
            { text: 'New Items Total', bold: true, fontSize: 8 },
            {}, {}, { text: `${totalQtyNew} NOS`, alignment: 'center', fontSize: 8, bold: true },
            {}, {}, {}, {},
            { text: `₹ ${newTotal.toFixed(2)}`, bold: true, alignment: 'right', fontSize: 8 },
          ]],
        },
        layout: tableLayout,
        margin: [0, 0, 0, 10],
      },

      // Settlement summary
      {
        columns: [
          { text: '', width: '*' },
          {
            width: 250,
            table: {
              widths: ['*', 90],
              body: [
                [
                  { text: 'Old Item Value (Credited)', fontSize: 8, border: [false, false, false, false] },
                  { text: `₹ ${oldTotal.toFixed(2)}`, fontSize: 8, alignment: 'right', border: [false, false, false, false] },
                ],
                [
                  { text: 'New Item Value (Charged)', fontSize: 8, border: [false, false, false, false] },
                  { text: `₹ ${newTotal.toFixed(2)}`, fontSize: 8, alignment: 'right', border: [false, false, false, false] },
                ],
                [
                  { text: settlementLabel, fontSize: 9, bold: true, border: [false, true, false, true] },
                  { text: `₹ ${Math.abs(netAmount).toFixed(2)}`, fontSize: 9, bold: true, alignment: 'right', border: [false, true, false, true] },
                ],
              ],
            },
            layout: 'noBorders',
          },
        ],
        margin: [0, 0, 0, 10],
      },

      // Signatory box
      {
        table: {
          widths: ['60%', '40%'],
          body: [[
            {
              stack: [
                shop?.pan ? { text: `Company's PAN    :  ${shop.pan}`, fontSize: 8, bold: true } : { text: '' },
                { text: 'Declaration', fontSize: 8, bold: true, margin: [0, 4, 0, 0] },
                { text: '1. GOODS ONCE SOLD NOT TAKEN BACK', fontSize: 7, italics: true },
                { text: "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.", fontSize: 7, italics: true },
              ],
              border: [true, true, false, true],
              margin: [2, 2, 2, 2],
            },
            {
              stack: [
                { text: `for ${shop?.name || 'Shri Mahesh Automobiles'}`, fontSize: 8, alignment: 'center' },
                { text: '\n\n\n', fontSize: 8 },
                { text: 'Authorised Signatory', fontSize: 8, alignment: 'center' },
              ],
              border: [true, true, true, true],
              margin: [2, 2, 2, 2],
            },
          ]],
        },
        layout: {
          hLineColor: () => '#000000',
          vLineColor: () => '#000000',
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
        },
        margin: [0, 0, 0, 6],
      },
    ],

    styles: {
      header: { fontSize: 9, color: '#374151' },
    },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#374151' },
  };

  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDef);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
};

// ─── SALES RETURN INVOICE PDF ────────────────────────────────────────────────
// Generates a printable Credit Note / Return Invoice in the same style as the
// TAX INVOICE and EXCHANGE INVOICE.
export const generateReturnInvoicePdf = async (salesReturn) => {
  const { items = [], invoice: origInvoice, creditNote, shop } = salesReturn || {};

  const dateStr = fmtDateIST(salesReturn?.createdAt);
  const originalInvoiceNo = origInvoice?.invoiceNumber || '';

  const orderIdVal = String(salesReturn?.returnId || '');
  const invoiceFields = [
    ['Return No.',        String(salesReturn?.returnNo || salesReturn?.returnId || '')],
    ['Dated',            dateStr],
    ['Original Invoice', originalInvoiceNo],
    ['Reason',           (salesReturn?.reason || '').replace(/_/g, ' ')],
    ['Refund Mode',      salesReturn?.refundMode || ''],
    ['Order ID',         orderIdVal],
  ];

  const partyName  = salesReturn?.party?.name  || origInvoice?.partyName  || 'Walk-in Customer';
  const partyPhone = salesReturn?.party?.phone || origInvoice?.partyPhone || '';
  const partyGstin = salesReturn?.party?.gstin || origInvoice?.partyGstin || '';
  const partyAddr  = origInvoice?.billingAddress || origInvoice?.customerAddress || '';

  const buyerBlock = [
    { text: 'Customer (Bill to)', bold: true, fontSize: 8 },
    { text: partyName, bold: true, fontSize: 9, margin: [0, 1, 0, 2] },
  ];
  if (partyPhone) buyerBlock.push({ text: `Phone        :  ${partyPhone}`, fontSize: 8, margin: [0, 1, 0, 1] });
  if (partyAddr)  buyerBlock.push({ text: partyAddr, fontSize: 8, margin: [0, 1, 0, 1] });
  if (partyGstin) buyerBlock.push({ text: `GSTIN/UIN    :  ${partyGstin}`, fontSize: 8, margin: [0, 1, 0, 1] });
  if (shop?.state) buyerBlock.push({ text: `State Name   :  ${shop.state}${shop.stateCode ? ', Code : ' + shop.stateCode : ''}`, fontSize: 8, margin: [0, 1, 0, 1] });
  if (origInvoice?.vehicleReg) buyerBlock.push({ text: `Vehicle Reg  :  ${origInvoice.vehicleReg}`, fontSize: 8, bold: true, margin: [0, 1, 0, 1] });
  if (salesReturn?.notes || origInvoice?.notes) buyerBlock.push({ text: `Remarks      :  ${salesReturn?.notes || origInvoice?.notes}`, fontSize: 8, margin: [0, 1, 0, 1] });

  const itemRows = items.map((item, idx) => {
    const name = item.invoiceItem?.partName || item.inventory?.masterPart?.partName || 'Item';
    const hsn  = item.invoiceItem?.hsnCode  || item.inventory?.masterPart?.hsnCode  || '';
    const amt  = Number(item.taxableValue || 0) + Number(item.cgst || 0) + Number(item.sgst || 0);
    return [
      { text: String(idx + 1),                  alignment: 'center', fontSize: 8 },
      { text: name,                              fontSize: 8 },
      { text: hsn,                               alignment: 'center', fontSize: 8 },
      { text: `${item.qty || 0} NOS`,                 alignment: 'center', fontSize: 8, bold: true },
      { text: Number(item.unitPrice || 0).toFixed(2), alignment: 'right',  fontSize: 8 },
      { text: Number(item.unitPrice || 0).toFixed(2), alignment: 'right',  fontSize: 8 },
      { text: 'NOS',                             alignment: 'center', fontSize: 8 },
      { text: '',                                alignment: 'center', fontSize: 8 },
      { text: amt.toFixed(2),                    alignment: 'right',  fontSize: 8 },
    ];
  });

  const totalQty    = items.reduce((s, i) => s + Number(i.qty || 0), 0);
  const totalAmount = Number(creditNote?.totalAmount || 0);
  const cgst        = Number(creditNote?.cgst || 0);
  const sgst        = Number(creditNote?.sgst || 0);
  const retTaxable  = totalAmount - cgst - sgst;
  const retPct      = retTaxable > 0 ? fmtPct((cgst / retTaxable) * 100) : '';
  const cgstLabel   = `OUTPUT CGST${retPct ? ` @ ${retPct}%` : ''}`;
  const sgstLabel   = `OUTPUT SGST${retPct ? ` @ ${retPct}%` : ''}`;

  const tableLayout = {
    hLineColor: () => '#000000',
    vLineColor: () => '#000000',
    hLineWidth: () => 0.4,
    vLineWidth: () => 0.4,
  };

  const docDef = {
    pageSize: 'A4',
    pageMargins: [30, 175, 30, 60],

    header: (currentPage) => {
      const hdr = buildPageHeader(shop, invoiceFields, buyerBlock, currentPage, 'CREDIT NOTE / RETURN INVOICE', salesReturn.returnNo || salesReturn.returnId, dateStr);
      return { stack: hdr, margin: [30, 20, 30, 0] };
    },

    footer: () => ({
      stack: buildPageFooter(),
      margin: [30, 0, 30, 10],
    }),

    content: [
      {
        table: {
          headerRows: 1,
          widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
          body: [productTableHeader(), ...itemRows],
        },
        layout: tableLayout,
        margin: [0, 0, 0, 0],
      },
      // Summary rows
      {
        table: {
          widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
          body: [
            [
              { text: '', border: [true, false, false, false] }, {}, {}, {},
              { text: cgstLabel, italics: true, fontSize: 8, border: [false, false, false, false], colSpan: 3 }, {}, {},
              { text: '', border: [false, false, false, false] },
              { text: cgst.toFixed(2), alignment: 'right', fontSize: 8, border: [false, false, true, false] },
            ],
            [
              { text: '', border: [true, false, false, false] }, {}, {}, {},
              { text: sgstLabel, italics: true, fontSize: 8, border: [false, false, false, false], colSpan: 3 }, {}, {},
              { text: '', border: [false, false, false, false] },
              { text: sgst.toFixed(2), alignment: 'right', fontSize: 8, border: [false, false, true, false] },
            ],
            [
              { text: '', border: [true, false, false, true] }, {}, {}, {},
              { text: 'Total Credit', bold: true, fontSize: 9, border: [false, false, false, true], colSpan: 3 }, {}, {},
              { text: '', border: [false, false, false, true] },
              { text: totalAmount.toFixed(2), bold: true, fontSize: 9, alignment: 'right', border: [false, false, true, true] },
            ],
          ],
        },
        layout: tableLayout,
        margin: [0, 0, 0, 0],
      },
      {
        table: {
          widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
          body: [[
            { text: 'Total', bold: true, fontSize: 9, border: [true, true, false, true] },
            {}, {}, { text: `${totalQty} NOS`, bold: true, alignment: 'center', fontSize: 9, border: [false, true, false, true] },
            {}, {}, {}, {},
            { text: `₹ ${totalAmount.toFixed(2)}`, bold: true, alignment: 'right', fontSize: 9, border: [false, true, true, true] },
          ]],
        },
        layout: tableLayout,
        margin: [0, 0, 0, 4],
      },
      {
        columns: [
          { text: `Amount Chargeable (in words)\n${numberToWords(totalAmount)}`, fontSize: 8, width: '*' },
          { text: 'E. & O.E', fontSize: 8, alignment: 'right', width: 'auto' },
        ],
        margin: [0, 4, 0, 4],
      },
      {
        table: {
          widths: ['60%', '40%'],
          body: [[
            {
              stack: [
                shop?.pan ? { text: `Company's PAN    :  ${shop.pan}`, fontSize: 8, bold: true } : { text: '' },
                { text: 'Declaration', fontSize: 8, bold: true, margin: [0, 4, 0, 0] },
                { text: '1. GOODS ONCE SOLD NOT TAKEN BACK', fontSize: 7, italics: true },
                { text: "We declare that this credit note shows the actual value of goods returned and that all particulars are true and correct.", fontSize: 7, italics: true },
              ],
              border: [true, true, false, true],
              margin: [2, 2, 2, 2],
            },
            {
              stack: [
                { text: `for ${shop?.name || 'Shri Mahesh Automobiles'}`, fontSize: 8, alignment: 'center' },
                { text: '\n\n\n', fontSize: 8 },
                { text: 'Authorised Signatory', fontSize: 8, alignment: 'center' },
              ],
              border: [true, true, true, true],
              margin: [2, 2, 2, 2],
            },
          ]],
        },
        layout: {
          hLineColor: () => '#000000',
          vLineColor: () => '#000000',
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
        },
        margin: [0, 0, 0, 6],
      },
    ],

    styles: { header: { fontSize: 9, color: '#374151' } },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#374151' },
  };

  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDef);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
};

// ─── PURCHASE ORDER PDF ───────────────────────────────────────────────────────
export const generatePurchaseOrderPdf = async (po) => {
  const { items, shop, party } = po;
  const supplierName  = party?.name  || po.supplierName  || 'Supplier';
  const supplierGstin = party?.gstin || po.supplierGstin || null;

  const logoUrl    = shop?.logoUrl || shop?.photoUrl || null;
  const logoDataUri = await fetchImageAsDataUri(logoUrl);

  const dateStr = fmtDateIST(po.createdAt);

  const invoiceFields = [
    ['PO No.',  String(po.poNumber || '')],
    ['Dated',   dateStr],
    ['Status',  po.status || ''],
    ['Expected', po.expectedAt ? fmtDateIST(po.expectedAt, { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''],
    ['Items',   String(items.length)],
    ['Remarks', po.notes || ''],
    ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
  ];

  const buyerBlock = [
    { text: 'Supplier', bold: true, fontSize: 8 },
    { text: supplierName, bold: true, fontSize: 9 },
  ];
  if (supplierGstin)  buyerBlock.push({ text: `GSTIN/UIN    :  ${supplierGstin}`, fontSize: 8 });
  if (party?.address) buyerBlock.push({ text: party.address, fontSize: 8 });

  const itemRows = items.map((item, idx) => [
    { text: String(idx + 1),                       alignment: 'center', fontSize: 8 },
    { text: item.partName || '',                   fontSize: 8 },
    { text: item.hsnCode || '',                    alignment: 'center', fontSize: 8 },
    { text: `${item.orderedQty} NOS`,              alignment: 'center', fontSize: 8, bold: true },
    { text: Number(item.unitPrice).toFixed(2),     alignment: 'right',  fontSize: 8 },
    { text: Number(item.unitPrice).toFixed(2),     alignment: 'right',  fontSize: 8 },
    { text: 'NOS',                                 alignment: 'center', fontSize: 8 },
    { text: '',                                    alignment: 'center', fontSize: 8 },
    { text: Number(item.total).toFixed(2),         alignment: 'right',  fontSize: 8 },
  ]);

  const totalQty    = items.reduce((s, i) => s + Number(i.orderedQty), 0);
  const totalAmount = Number(po.totalAmount || 0);
  const cgst        = Number(po.cgst || 0);
  const sgst        = Number(po.sgst || 0);
  const poTaxable   = totalAmount - cgst - sgst;
  const poPct       = poTaxable > 0 ? fmtPct((cgst / poTaxable) * 100) : '';
  const poCgstLabel = `CGST${poPct ? ` @ ${poPct}%` : ''}`;
  const poSgstLabel = `SGST${poPct ? ` @ ${poPct}%` : ''}`;

  const pageHeader = buildPageHeader(shop, invoiceFields, buyerBlock, 1, 'PURCHASE ORDER', po.poNumber, dateStr);

  const tableLayout = {
    hLineColor: () => '#000000',
    vLineColor: () => '#000000',
    hLineWidth: () => 0.4,
    vLineWidth: () => 0.4,
  };

  const docDef = {
    pageSize: 'A4',
    pageMargins: [30, 175, 30, 60],

    header: (currentPage) => {
      const pageHeaderN = buildPageHeader(shop, invoiceFields, buyerBlock, currentPage, 'PURCHASE ORDER', po.poNumber, dateStr);
      return { stack: pageHeaderN, margin: [30, 20, 30, 0] };
    },

    footer: () => ({
      stack: buildPageFooter(),
      margin: [30, 0, 30, 10],
    }),

    content: [
      {
        table: {
          headerRows: 1,
          widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
          body: [productTableHeader(), ...itemRows],
        },
        layout: tableLayout,
        margin: [0, 0, 0, 0],
      },
      // PO summary
      {
        table: {
          widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
          body: [
            [
              { text: '', border: [true, false, false, false] },
              {}, {}, {},
              { text: poCgstLabel, italics: true, fontSize: 8, border: [false, false, false, false], colSpan: 3 },
              {}, {},
              { text: '', border: [false, false, false, false] },
              { text: cgst.toFixed(2), alignment: 'right', fontSize: 8, border: [false, false, true, false] },
            ],
            [
              { text: '', border: [true, false, false, false] },
              {}, {}, {},
              { text: poSgstLabel, italics: true, fontSize: 8, border: [false, false, false, false], colSpan: 3 },
              {}, {},
              { text: '', border: [false, false, false, false] },
              { text: sgst.toFixed(2), alignment: 'right', fontSize: 8, border: [false, false, true, false] },
            ],
          ],
        },
        layout: tableLayout,
        margin: [0, 0, 0, 0],
      },
      {
        table: {
          widths: ['*', 60, 60, 28, 60, 50, 28, 40, 70],
          body: [[
            { text: 'Total', bold: true, fontSize: 9, border: [true, true, false, true] },
            {}, {}, { text: `${totalQty} NOS`, bold: true, alignment: 'center', fontSize: 9, border: [false, true, false, true] },
            {}, {}, {}, {},
            { text: `₹ ${totalAmount.toFixed(2)}`, bold: true, alignment: 'right', fontSize: 9, border: [false, true, true, true] },
          ]],
        },
        layout: tableLayout,
        margin: [0, 0, 0, 4],
      },
      {
        columns: [
          { text: `Amount Chargeable (in words)\n${numberToWords(totalAmount)}`, fontSize: 8, width: '*' },
          { text: 'E. & O.E', fontSize: 8, alignment: 'right', width: 'auto' },
        ],
        margin: [0, 4, 0, 4],
      },
      {
        table: {
          widths: ['60%', '40%'],
          body: [[
            {
              stack: [
                shop?.pan ? { text: `Company's PAN    :  ${shop.pan}`, fontSize: 8, bold: true } : { text: '' },
                { text: 'Terms & Conditions', fontSize: 8, bold: true, margin: [0, 4, 0, 0] },
                { text: '1. Subject to Hyderabad jurisdiction.', fontSize: 7, italics: true },
              ],
              border: [true, true, false, true],
              margin: [2, 2, 2, 2],
            },
            {
              stack: [
                { text: `for ${shop?.name || 'Shri Mahesh Automobiles'}`, fontSize: 8, alignment: 'center' },
                { text: '\n\n\n', fontSize: 8 },
                { text: 'Authorised Signatory', fontSize: 8, alignment: 'center' },
              ],
              border: [true, true, true, true],
              margin: [2, 2, 2, 2],
            },
          ]],
        },
        layout: {
          hLineColor: () => '#000000',
          vLineColor: () => '#000000',
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
        },
        margin: [0, 0, 0, 6],
      },
    ],

    styles: {
      header: { fontSize: 9, color: '#374151' },
    },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#374151' },
  };

  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDef);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
};
