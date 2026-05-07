import axios from 'axios';

export const sendWhatsAppMessage = async (phone, templateName, params = []) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[WhatsApp] To: ${phone} | Template: ${templateName} | Params:`, params);
    return { success: true, dev: true };
  }

  try {
    const response = await axios.post(
      `${process.env.WATI_API_URL}/sendTemplateMessage?whatsappNumber=91${phone}`,
      {
        template_name: templateName,
        broadcast_name: 'AutoSpace',
        parameters: params.map(p => ({ name: p.name, value: p.value })),
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WATI_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return { success: true };
  } catch (err) {
    console.error('[WhatsApp] Send failed:', err.response?.data || err.message);
    return { success: false, error: err.message };
  }
};

export const sendInvoiceWhatsApp = async (phone, customerName, invoiceNumber, amount, pdfUrl) => {
  return sendWhatsAppMessage(phone, 'invoice_sent', [
    { name: 'customer_name', value: customerName || 'Customer' },
    { name: 'invoice_number', value: invoiceNumber },
    { name: 'amount', value: `₹${Number(amount).toFixed(2)}` },
    { name: 'pdf_link', value: pdfUrl },
  ]);
};
