/**
 * gst-fy.js — Indian financial-year helpers for GST credit-note compliance.
 *
 * Section 34(2) CGST Act: a credit note can be issued at any time, but it can
 * only reduce output GST liability if declared in a GST return by 30th November
 * following the end of the financial year (Apr–Mar) of the ORIGINAL SALE, or the
 * date of filing the annual return (GSTR-9), whichever is earlier.
 *
 * This module has no GSTR-9 filing-date tracker (none exists in this schema), so
 * isGstAdjustable() checks only the hard 30-Nov cutoff. That is always the same
 * or earlier than the true deadline, so it never lets a shop over-claim GST.
 */

const IST_OFFSET = '+05:30';

/** "2025-26" style financial-year key for a given date (FY runs Apr 1 – Mar 31). */
export function financialYearKey(date) {
  const d = new Date(date);
  const endYear = d.getUTCMonth() >= 3 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  return `${endYear - 1}-${String(endYear).slice(2)}`;
}

/** 30 November following the end of the financial year containing `originalInvoiceDate`. */
export function gstCreditNoteDeadline(originalInvoiceDate) {
  const d = new Date(originalInvoiceDate);
  // FY end calendar year (the "Mar 31" year), then +1 more year to reach the following Nov.
  const fyEndYear = d.getUTCMonth() >= 3 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  return new Date(`${fyEndYear + 1}-11-30T23:59:59${IST_OFFSET}`);
}

/**
 * Whether a credit note issued on `issueDate` for a sale made on `originalInvoiceDate`
 * can still reduce output GST liability.
 */
export function isGstAdjustable(originalInvoiceDate, issueDate = new Date()) {
  return new Date(issueDate) <= gstCreditNoteDeadline(originalInvoiceDate);
}

/** "YYYY-MM" for the GST period a credit note is being declared in. */
export function currentGstPeriod(date = new Date()) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Whether the given shop has locked the GST period a credit note would
 * declare into — e.g. the accountant already filed/reconciled that month.
 * A locked period forces the note to COMMERCIAL regardless of the Section 34
 * deadline check, same as isGstAdjustable() returning false.
 */
export async function isPeriodLocked(prisma, shopId, period) {
  const lock = await prisma.gstPeriodLock.findUnique({
    where: { shopId_period: { shopId, period } },
  });
  return !!lock;
}
