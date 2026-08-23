/**
 * Single source of truth for customer-facing WhatsApp text.
 *
 * Every message the mechanic sends to a customer — status change, extra-work
 * request, or call-outcome confirmation — is generated here from the same
 * job-card data shown in the app. The mechanic never free-types the message;
 * they only tap "Send on WhatsApp", so the in-app status and the WhatsApp
 * text can never drift out of sync.
 *
 * Delivery is a wa.me click-to-chat link (pre-filled text, mechanic taps
 * Send in their own WhatsApp) — the same mechanism already used for
 * quotation sharing in routes/workshop/quotation.js. No WhatsApp Business
 * API template approval required.
 */

export const STATUS_CUSTOMER_TEXT = {
  RECEIVED:      'Your vehicle has been received at the workshop and is queued for inspection.',
  IN_PROGRESS:   'Work has started on your vehicle.',
  WAITING_PARTS: 'Your vehicle is on hold — waiting on a part before we can continue.',
  READY:         'Your vehicle is ready and awaiting final quality check.',
  QC_REWORK:     'A quality check flagged an item — a bit more work is being done before handover.',
  QC_PASSED:     'Your vehicle has passed quality check and is ready for pickup.',
  DELIVERED:     'Your vehicle has been delivered. Thank you for choosing us!',
  CANCELLED:     'Your job card has been cancelled.',
};

function vehicleLine(job) {
  const bits = [job.vehicle_make, job.vehicle_model].filter(Boolean).join(' ');
  return job.vehicle_reg ? `${bits} (${job.vehicle_reg})` : bits;
}

function waLink(phone, text) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const withCountry = digits.startsWith('91') ? digits : `91${digits}`;
  return `https://wa.me/${withCountry}?text=${encodeURIComponent(text)}`;
}

// Only the sub-stages actually worth telling a customer about — internal
// bookkeeping stages (diagnosis, parts issued, etc.) stay in-app only.
export const PROGRESS_CUSTOMER_TEXT = {
  REPAIR_STARTED:   'Repair work has begun on your vehicle.',
  REPAIR_COMPLETED: 'Repair work is complete — your vehicle is now being cleaned before handover.',
  CLEANING:         'Your vehicle is being cleaned and will be ready shortly.',
  READY_FOR_QC:      'Your vehicle has finished repair and is now undergoing a final quality check.',
};

export function buildProgressMessage(job, progress) {
  const line = PROGRESS_CUSTOMER_TEXT[progress];
  if (!line) return null; // internal-only stage — no customer message
  const text = [
    `Hi ${job.customer_name || 'there'}, update on your vehicle service:`,
    ``,
    `Job No: ${job.job_number}`,
    `Vehicle: ${vehicleLine(job)}`,
    ``,
    line,
  ].join('\n');
  return { text, link: waLink(job.customer_phone, text) };
}

export function buildStatusMessage(job, status) {
  const line = STATUS_CUSTOMER_TEXT[status] || `Status updated: ${status}`;
  const text = [
    `Hi ${job.customer_name || 'there'}, update on your vehicle service:`,
    ``,
    `Job No: ${job.job_number}`,
    `Vehicle: ${vehicleLine(job)}`,
    ``,
    line,
  ].join('\n');
  return { text, link: waLink(job.customer_phone, text) };
}

export function buildExtraWorkFoundMessage(job, partRequest) {
  const cost = partRequest.unit_price
    ? ` (approx ₹${(Number(partRequest.unit_price) * Number(partRequest.qty_requested || 1)).toFixed(2)})`
    : '';
  const text = [
    `Hi ${job.customer_name || 'there'}, an update on your vehicle:`,
    ``,
    `Job No: ${job.job_number}`,
    `Vehicle: ${vehicleLine(job)}`,
    ``,
    `Additional work found: ${partRequest.description} x${partRequest.qty_requested}${cost}.`,
    `Our mechanic will call you shortly to confirm before proceeding.`,
  ].join('\n');
  return { text, link: waLink(job.customer_phone, text) };
}

export function buildCallOutcomeMessage(job, { outcome, notes, partRequest }) {
  const decisionLine = partRequest
    ? outcome === 'APPROVED'
      ? `As discussed on call, you've approved: ${partRequest.description} x${partRequest.qty_requested}${partRequest.unit_price ? ` (₹${(Number(partRequest.unit_price) * Number(partRequest.qty_requested || 1)).toFixed(2)})` : ''}.`
      : outcome === 'REJECTED'
        ? `As discussed on call, you've declined: ${partRequest.description}. We will proceed without it.`
        : `As discussed on call: ${notes || 'noted, will follow up.'}`
    : notes || 'Thanks for taking the call — noted as discussed.';

  const text = [
    `Hi ${job.customer_name || 'there'}, confirming our call just now:`,
    ``,
    `Job No: ${job.job_number}`,
    `Vehicle: ${vehicleLine(job)}`,
    ``,
    decisionLine,
  ].join('\n');
  return { text, link: waLink(job.customer_phone, text) };
}
