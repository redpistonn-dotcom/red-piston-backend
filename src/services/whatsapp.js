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
        broadcast_name: 'RedPiston',
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

// Sends from RedPiston's single WATI business number — WhatsApp Business API
// has no concept of "send as this mechanic's personal number", so the
// message is signed with the mechanic's name in the text instead. Requires
// a WATI template with exactly one body variable ({{1}}) already approved
// on Meta's side; the template name is configurable since every WATI
// account has to create/name its own. Free-form edited text goes in as
// that one variable, so the customer sees exactly what the mechanic wrote.
export const sendJobUpdateWhatsApp = async (phone, text) => {
  const templateName = process.env.WATI_GENERIC_TEMPLATE_NAME || 'job_update';
  return sendWhatsAppMessage(phone, templateName, [{ name: '1', value: text }]);
};

export const sendInvoiceWhatsApp = async (phone, customerName, invoiceNumber, amount, pdfUrl) => {
  return sendWhatsAppMessage(phone, 'invoice_sent', [
    { name: 'customer_name', value: customerName || 'Customer' },
    { name: 'invoice_number', value: invoiceNumber },
    { name: 'amount', value: `₹${Number(amount).toFixed(2)}` },
    { name: 'pdf_link', value: pdfUrl },
  ]);
};
