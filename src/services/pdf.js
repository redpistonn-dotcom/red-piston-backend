import PdfPrinter from 'pdfmake';
import path from 'path';
import { fileURLToPath } from 'url';

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

export const generateInvoicePdf = (invoice) => {
  const { items, shop } = invoice;

  const tableBody = [
    [
      { text: '#', bold: true },
      { text: 'Part Name', bold: true },
      { text: 'HSN', bold: true },
      { text: 'Qty', bold: true },
      { text: 'Rate', bold: true },
      { text: 'GST%', bold: true },
      { text: 'CGST', bold: true },
      { text: 'SGST', bold: true },
      { text: 'Amount', bold: true },
    ],
    ...items.map((item, i) => [
      i + 1,
      item.partName,
      item.hsnCode || '-',
      item.qty,
      `₹${Number(item.unitPrice).toFixed(2)}`,
      `${item.gstRate}%`,
      `₹${Number(item.cgst).toFixed(2)}`,
      `₹${Number(item.sgst).toFixed(2)}`,
      `₹${Number(item.total).toFixed(2)}`,
    ]),
  ];

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [40, 60, 40, 60],
    content: [
      { text: shop?.name || 'AutoSpace Shop', style: 'header' },
      { text: shop?.address || '', style: 'subheader' },
      { text: `GSTIN: ${shop?.gstin || 'N/A'}`, style: 'subheader' },
      { text: `Phone: ${shop?.phone || ''}`, style: 'subheader' },
      { text: ' ' },
      {
        columns: [
          [
            { text: 'TAX INVOICE', style: 'invoiceTitle' },
            { text: `Invoice No: ${invoice.invoiceNumber}`, style: 'invoiceDetail' },
            { text: `Date: ${new Date(invoice.createdAt).toLocaleDateString('en-IN')}`, style: 'invoiceDetail' },
          ],
          [
            { text: 'Bill To:', bold: true },
            { text: invoice.partyName || 'Walk-in Customer' },
            { text: invoice.partyPhone || '' },
            invoice.partyGstin ? { text: `GSTIN: ${invoice.partyGstin}` } : {},
          ],
        ],
      },
      { text: ' ' },
      {
        table: {
          headerRows: 1,
          widths: [20, '*', 60, 30, 60, 40, 55, 55, 65],
          body: tableBody,
        },
      },
      { text: ' ' },
      {
        columns: [
          { text: '' },
          {
            table: {
              widths: [120, 80],
              body: [
                ['Subtotal', `₹${Number(invoice.subtotal).toFixed(2)}`],
                ['CGST', `₹${Number(invoice.cgst).toFixed(2)}`],
                ['SGST', `₹${Number(invoice.sgst).toFixed(2)}`],
                [{ text: 'TOTAL', bold: true }, { text: `₹${Number(invoice.totalAmount).toFixed(2)}`, bold: true }],
                ['Payment Mode', invoice.paymentMode],
              ],
            },
          },
        ],
      },
    ],
    styles: {
      header: { fontSize: 18, bold: true, alignment: 'center', margin: [0, 0, 0, 4] },
      subheader: { fontSize: 10, alignment: 'center', color: '#555', margin: [0, 0, 0, 2] },
      invoiceTitle: { fontSize: 14, bold: true, color: '#F59E0B' },
      invoiceDetail: { fontSize: 10, margin: [0, 2, 0, 0] },
    },
  };

  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDefinition);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
};
