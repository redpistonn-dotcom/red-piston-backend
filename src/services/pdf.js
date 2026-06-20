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

// Fetch an image from a URL and return it as a base64 data URI, or null on failure.
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

// Build the receipt-style document definition shared by all invoice types.
function buildReceiptDef(shop, lines, summaryRows, metaLeft, metaRight, options = {}) {
  const shopName = shop?.name || 'RedPiston Shop';
  const addrParts = [shop?.address, shop?.city, shop?.state, shop?.pincode].filter(Boolean);
  const shopAddr = addrParts.join(', ');
  const shopPhone = shop?.phone || shop?.whatsappNumber || '';
  const shopGstin = shop?.gstin || '';
  const { logoDataUri, title = 'TAX INVOICE' } = options;

  const headerContent = [];

  // Logo (if available) or shop name as large text
  if (logoDataUri) {
    headerContent.push({
      image: logoDataUri,
      width: 90,
      alignment: 'center',
      margin: [0, 0, 0, 8],
    });
    headerContent.push({ text: shopName, style: 'shopName' });
  } else {
    headerContent.push({ text: shopName, style: 'shopName' });
  }

  if (shopAddr) headerContent.push({ text: shopAddr, style: 'shopAddr' });
  if (shopPhone) headerContent.push({ text: `Ph: ${shopPhone}`, style: 'shopAddr' });
  if (shopGstin) headerContent.push({ text: `GSTIN: ${shopGstin}`, style: 'shopAddr' });

  // Divider
  headerContent.push({ canvas: [{ type: 'line', x1: 0, y1: 4, x2: 515, y2: 4, lineWidth: 0.5, lineColor: '#CCCCCC' }] });
  headerContent.push({ text: title, style: 'invoiceTitle', margin: [0, 6, 0, 4] });
  headerContent.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#CCCCCC' }] });
  headerContent.push({ text: ' ', margin: [0, 0, 0, 4] });

  // Meta row: invoice details left, bill-to right
  headerContent.push({
    columns: [
      { stack: metaLeft, width: '55%', fontSize: 9 },
      { stack: metaRight, width: '45%', fontSize: 9, alignment: 'right' },
    ],
    margin: [0, 0, 0, 8],
  });

  // Items table — Qty | Description | HSN | Rate | GST% | Amount
  const tableHeader = [
    { text: 'Qty', bold: true, alignment: 'center', fillColor: '#F3F4F6' },
    { text: 'Description', bold: true, fillColor: '#F3F4F6' },
    { text: 'HSN', bold: true, alignment: 'center', fillColor: '#F3F4F6' },
    { text: 'Rate', bold: true, alignment: 'right', fillColor: '#F3F4F6' },
    { text: 'GST%', bold: true, alignment: 'center', fillColor: '#F3F4F6' },
    { text: 'Amount', bold: true, alignment: 'right', fillColor: '#F3F4F6' },
  ];

  const tableRows = lines.map(line => [
    { text: String(line.qty), alignment: 'center' },
    line.description,
    { text: line.hsn || '-', alignment: 'center' },
    { text: `₹${Number(line.rate).toFixed(2)}`, alignment: 'right' },
    { text: `${line.gstRate || 0}%`, alignment: 'center' },
    { text: `₹${Number(line.amount).toFixed(2)}`, alignment: 'right' },
  ]);

  const tableContent = {
    table: {
      headerRows: 1,
      widths: [30, '*', 45, 60, 38, 65],
      body: [tableHeader, ...tableRows],
    },
    layout: {
      hLineColor: () => '#E5E7EB',
      vLineColor: () => '#E5E7EB',
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
    },
    margin: [0, 0, 0, 8],
  };

  // Summary block (right-aligned)
  const summaryTable = {
    columns: [
      { text: '', width: '*' },
      {
        width: 200,
        table: {
          widths: ['*', 80],
          body: summaryRows.map(([label, value, isBold]) => [
            { text: label, bold: !!isBold, fontSize: isBold ? 10 : 9, border: [false, isBold ? true : false, false, false] },
            { text: value, bold: !!isBold, fontSize: isBold ? 10 : 9, alignment: 'right', border: [false, isBold ? true : false, false, false] },
          ]),
        },
        layout: 'noBorders',
      },
    ],
    margin: [0, 0, 0, 12],
  };

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 40],
    content: [
      ...headerContent,
      tableContent,
      summaryTable,
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#CCCCCC' }] },
      { text: 'Thank you for your business!', style: 'thankYou', margin: [0, 10, 0, 0] },
      { text: 'This is a computer-generated invoice.', style: 'footer' },
    ],
    styles: {
      shopName:    { fontSize: 20, bold: true, alignment: 'center', color: '#111827', margin: [0, 0, 0, 2] },
      shopAddr:    { fontSize: 9,  alignment: 'center', color: '#6B7280', margin: [0, 0, 0, 1] },
      invoiceTitle:{ fontSize: 13, bold: true, alignment: 'center', color: '#8B1E1E', letterSpacing: 1 },
      thankYou:    { fontSize: 11, bold: true, alignment: 'center', color: '#374151' },
      footer:      { fontSize: 8,  alignment: 'center', color: '#9CA3AF', margin: [0, 2, 0, 0] },
    },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#374151' },
  };
}

export const generateInvoicePdf = async (invoice) => {
  const { items, shop } = invoice;

  // Try to fetch the shop logo for the header
  const logoUrl = shop?.logoUrl || shop?.photoUrl || null;
  const logoDataUri = await fetchImageAsDataUri(logoUrl);

  const lines = items.map(item => ({
    qty:     item.qty,
    description: [item.partName, item.brand].filter(Boolean).join(' — '),
    hsn:     item.hsnCode,
    rate:    item.unitPrice,
    gstRate: item.gstRate,
    amount:  item.total,
  }));

  const subtotal     = Number(invoice.subtotal);
  const cgst         = Number(invoice.cgst);
  const sgst         = Number(invoice.sgst);
  const totalAmount  = Number(invoice.totalAmount);

  const summaryRows = [
    ['Subtotal',    `₹${subtotal.toFixed(2)}`],
    [`CGST`,        `₹${cgst.toFixed(2)}`],
    [`SGST`,        `₹${sgst.toFixed(2)}`],
    ['Total',       `₹${totalAmount.toFixed(2)}`, true],
    ['Payment',     invoice.paymentMode || 'CASH'],
  ];
  if (invoice.isCreditSale && invoice.creditAmount) {
    summaryRows.push(['Credit',  `₹${Number(invoice.creditAmount).toFixed(2)}`]);
    summaryRows.push(['Paid',    `₹${Number(invoice.paidAmount || 0).toFixed(2)}`]);
  }

  const dateStr = new Date(invoice.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const metaLeft = [
    { text: `Invoice No: ${invoice.invoiceNumber}`, bold: true },
    { text: `Date: ${dateStr}` },
    { text: `Type: ${invoice.invoiceType || 'RETAIL'}` },
  ];
  const metaRight = [
    { text: 'Bill To:', bold: true },
    { text: invoice.partyName || 'Walk-in Customer' },
    invoice.billingAddress ? { text: invoice.billingAddress } : {},
    invoice.partyGstin ? { text: `GSTIN: ${invoice.partyGstin}` } : {},
  ].filter(r => r.text);

  const docDef = buildReceiptDef(shop, lines, summaryRows, metaLeft, metaRight, { logoDataUri });

  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDef);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
};

// ─── Purchase Order PDF — shared with suppliers ─────────────────────────────
export const generatePurchaseOrderPdf = async (po) => {
  const { items, shop, party } = po;
  const supplierName = party?.name || po.supplierName || 'Supplier';
  const supplierGstin = party?.gstin || po.supplierGstin || null;

  const logoUrl = shop?.logoUrl || shop?.photoUrl || null;
  const logoDataUri = await fetchImageAsDataUri(logoUrl);

  const lines = items.map(item => ({
    qty:         item.orderedQty,
    description: item.partName,
    hsn:         item.hsnCode,
    rate:        item.unitPrice,
    gstRate:     item.gstRate,
    amount:      item.total,
  }));

  const summaryRows = [
    ['Subtotal', `₹${Number(po.subtotal).toFixed(2)}`],
    ['CGST',     `₹${Number(po.cgst).toFixed(2)}`],
    ['SGST',     `₹${Number(po.sgst).toFixed(2)}`],
    ['Total',    `₹${Number(po.totalAmount).toFixed(2)}`, true],
    ['Items',    String(items.length)],
  ];

  const dateStr = new Date(po.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const metaLeft = [
    { text: `PO No: ${po.poNumber}`, bold: true },
    { text: `Date: ${dateStr}` },
    { text: `Status: ${po.status}` },
    po.expectedAt ? { text: `Expected: ${new Date(po.expectedAt).toLocaleDateString('en-IN')}` } : null,
    po.notes ? { text: `Remarks: ${po.notes}`, italics: true } : null,
  ].filter(Boolean);

  const metaRight = [
    { text: 'Supplier:', bold: true },
    { text: supplierName },
    supplierGstin ? { text: `GSTIN: ${supplierGstin}` } : null,
    party?.address ? { text: party.address } : null,
  ].filter(Boolean);

  const docDef = buildReceiptDef(shop, lines, summaryRows, metaLeft, metaRight, {
    logoDataUri,
    title: 'PURCHASE ORDER',
  });

  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDef);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
};
