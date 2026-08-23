/**
 * customer-message.test.js — the single source of truth for customer-facing
 * WhatsApp text. Pure functions, no mocks: every branch of every builder.
 */
import { describe, it, expect } from 'vitest';
import {
  STATUS_CUSTOMER_TEXT,
  PROGRESS_CUSTOMER_TEXT,
  buildStatusMessage,
  buildExtraWorkFoundMessage,
  buildCallOutcomeMessage,
  buildProgressMessage,
} from '../../src/lib/customer-message.js';

const BASE_JOB = {
  customer_name: 'Rahul Kumar',
  customer_phone: '9876543210',
  job_number: 'JOB-202601-0001',
  vehicle_make: 'Maruti',
  vehicle_model: 'Swift',
  vehicle_reg: 'KA01AB1234',
};

describe('buildStatusMessage', () => {
  it('includes job number, vehicle, and reg number', () => {
    const { text } = buildStatusMessage(BASE_JOB, 'IN_PROGRESS');
    expect(text).toContain('JOB-202601-0001');
    expect(text).toContain('Maruti Swift (KA01AB1234)');
  });

  it('uses the customer-facing text for every known status', () => {
    for (const [status, line] of Object.entries(STATUS_CUSTOMER_TEXT)) {
      const { text } = buildStatusMessage(BASE_JOB, status);
      expect(text).toContain(line);
    }
  });

  it('falls back to a generic line for an unknown status', () => {
    const { text } = buildStatusMessage(BASE_JOB, 'SOME_NEW_STATUS');
    expect(text).toContain('Status updated: SOME_NEW_STATUS');
  });

  it('falls back to "there" when customer_name is missing', () => {
    const { text } = buildStatusMessage({ ...BASE_JOB, customer_name: null }, 'RECEIVED');
    expect(text).toContain('Hi there,');
  });

  it('omits the reg number when vehicle_reg is missing', () => {
    const { text } = buildStatusMessage({ ...BASE_JOB, vehicle_reg: null }, 'RECEIVED');
    expect(text).toContain('Maruti Swift');
    expect(text).not.toContain('(');
  });

  it('builds a wa.me link with the country code prefixed when missing', () => {
    const { link, text } = buildStatusMessage(BASE_JOB, 'RECEIVED');
    expect(link).toBe(`https://wa.me/919876543210?text=${encodeURIComponent(text)}`);
  });

  it('does not double-prefix a phone number already carrying "91"', () => {
    const { link } = buildStatusMessage({ ...BASE_JOB, customer_phone: '919876543210' }, 'RECEIVED');
    expect(link).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
  });

  it('strips non-digit characters from the phone number before linking', () => {
    const { link } = buildStatusMessage({ ...BASE_JOB, customer_phone: '+91 98765-43210' }, 'RECEIVED');
    expect(link).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
  });

  it('returns a null link when there is no phone number on file', () => {
    const { link, text } = buildStatusMessage({ ...BASE_JOB, customer_phone: null }, 'RECEIVED');
    expect(link).toBeNull();
    expect(text).toBeTruthy(); // text is still generated even without a phone
  });

  it('returns a null link for an empty-string phone number', () => {
    const { link } = buildStatusMessage({ ...BASE_JOB, customer_phone: '' }, 'RECEIVED');
    expect(link).toBeNull();
  });
});

describe('buildExtraWorkFoundMessage', () => {
  const partRequest = { description: 'Brake pad', qty_requested: 2, unit_price: 500 };

  it('includes the part description, quantity, and computed total cost', () => {
    const { text } = buildExtraWorkFoundMessage(BASE_JOB, partRequest);
    expect(text).toContain('Brake pad x2');
    expect(text).toContain('₹1000.00');
  });

  it('omits the cost estimate when unit_price is not set', () => {
    const { text } = buildExtraWorkFoundMessage(BASE_JOB, { ...partRequest, unit_price: null });
    expect(text).toContain('Brake pad x2.');
    expect(text).not.toContain('₹');
  });

  it('defaults qty to 1 in the cost calculation when qty_requested is falsy', () => {
    const { text } = buildExtraWorkFoundMessage(BASE_JOB, { description: 'Bulb', qty_requested: 0, unit_price: 100 });
    expect(text).toContain('₹100.00');
  });

  it('mentions the mechanic will call before proceeding', () => {
    const { text } = buildExtraWorkFoundMessage(BASE_JOB, partRequest);
    expect(text).toContain('call you shortly to confirm');
  });
});

describe('buildProgressMessage', () => {
  it('returns a message for every customer-relevant progress stage', () => {
    for (const [stage, line] of Object.entries(PROGRESS_CUSTOMER_TEXT)) {
      const result = buildProgressMessage(BASE_JOB, stage);
      expect(result).not.toBeNull();
      expect(result.text).toContain(line);
    }
  });

  it('returns null for an internal-only stage (e.g. DIAGNOSIS_DONE) — no customer message', () => {
    expect(buildProgressMessage(BASE_JOB, 'DIAGNOSIS_DONE')).toBeNull();
  });

  it('returns null for an unrecognised stage', () => {
    expect(buildProgressMessage(BASE_JOB, 'NOT_A_STAGE')).toBeNull();
  });

  it('still includes job number and vehicle for a valid stage', () => {
    const { text } = buildProgressMessage(BASE_JOB, 'CLEANING');
    expect(text).toContain('JOB-202601-0001');
    expect(text).toContain('Maruti Swift (KA01AB1234)');
  });
});

describe('buildCallOutcomeMessage', () => {
  const partRequest = { description: 'Clutch plate', qty_requested: 1, unit_price: 1500 };

  it('confirms an APPROVED decision with the part and cost', () => {
    const { text } = buildCallOutcomeMessage(BASE_JOB, { outcome: 'APPROVED', partRequest });
    expect(text).toContain("you've approved: Clutch plate x1 (₹1500.00)");
  });

  it('confirms an APPROVED decision without a cost when unit_price is missing', () => {
    const { text } = buildCallOutcomeMessage(BASE_JOB, { outcome: 'APPROVED', partRequest: { ...partRequest, unit_price: null } });
    expect(text).toContain("you've approved: Clutch plate x1.");
    expect(text).not.toContain('₹');
  });

  it('confirms a REJECTED decision and says work proceeds without the part', () => {
    const { text } = buildCallOutcomeMessage(BASE_JOB, { outcome: 'REJECTED', partRequest });
    expect(text).toContain("you've declined: Clutch plate");
    expect(text).toContain('proceed without it');
  });

  it('falls back to notes for a DISCUSSED outcome tied to a part request', () => {
    const { text } = buildCallOutcomeMessage(BASE_JOB, { outcome: 'DISCUSSED', notes: 'Will decide tomorrow', partRequest });
    expect(text).toContain('Will decide tomorrow');
  });

  it('falls back to a generic line for DISCUSSED with no notes and a part request', () => {
    const { text } = buildCallOutcomeMessage(BASE_JOB, { outcome: 'DISCUSSED', partRequest });
    expect(text).toContain('noted, will follow up.');
  });

  it('uses notes directly when there is no part request', () => {
    const { text } = buildCallOutcomeMessage(BASE_JOB, { outcome: 'NO_ANSWER', notes: 'Tried twice, no pickup' });
    expect(text).toContain('Tried twice, no pickup');
  });

  it('falls back to a generic thanks line with no part request and no notes', () => {
    const { text } = buildCallOutcomeMessage(BASE_JOB, { outcome: 'NO_ANSWER' });
    expect(text).toContain('Thanks for taking the call');
  });

  it('always frames the message as confirming the call just made', () => {
    const { text } = buildCallOutcomeMessage(BASE_JOB, { outcome: 'APPROVED', partRequest });
    expect(text).toContain('confirming our call just now');
  });
});
