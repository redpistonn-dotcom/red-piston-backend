/**
 * Server-authoritative status transition maps.
 * Never trust client to tell you what transition is valid.
 *
 * Status lifecycle (aligned with PDF Section 3):
 *   RECEIVED → IN_PROGRESS → WAITING_PARTS → IN_PROGRESS
 *           ↘ IN_PROGRESS → READY → QC_PASSED → DELIVERED
 *                              ↘ QC_REWORK → IN_PROGRESS (rework loop)
 */

export const VALID_STATUSES = [
  'RECEIVED',
  'IN_PROGRESS',
  'WAITING_PARTS',
  'READY',
  'QC_PASSED',
  'QC_REWORK',
  'DELIVERED',
  'CANCELLED',
];

// Statuses a MECHANIC may transition to from a given current status.
// Keyed by current status; value is the array of allowed next statuses.
export const MECHANIC_TRANSITIONS = {
  RECEIVED:      ['IN_PROGRESS'],
  IN_PROGRESS:   ['WAITING_PARTS', 'READY'],
  WAITING_PARTS: ['IN_PROGRESS'],
  QC_REWORK:     ['IN_PROGRESS'],
};

// Statuses a SHOP_OWNER / SHOP_STAFF may transition to.
export const OWNER_TRANSITIONS = {
  RECEIVED:      ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS:   ['WAITING_PARTS', 'READY', 'CANCELLED'],
  WAITING_PARTS: ['IN_PROGRESS', 'CANCELLED'],
  READY:         ['QC_PASSED', 'QC_REWORK'],
  QC_REWORK:     ['IN_PROGRESS'],
  QC_PASSED:     ['DELIVERED'],
  DELIVERED:     [],
  CANCELLED:     [],
};

export function canMechanicTransition(from, to) {
  return (MECHANIC_TRANSITIONS[from] ?? []).includes(to);
}

export function canOwnerTransition(from, to) {
  return (OWNER_TRANSITIONS[from] ?? []).includes(to);
}

// ── Mechanic work-progress sub-statuses ───────────────────────────────────────
// These live inside IN_PROGRESS (and RECEIVED before start).
// Advancing to READY_FOR_QC triggers a main-status transition to READY.
export const MECHANIC_PROGRESS_STAGES = [
  'VEHICLE_RECEIVED',
  'DIAGNOSIS_DONE',
  'PARTS_ISSUED',
  'REPAIR_STARTED',
  'REPAIR_COMPLETED',
  'CLEANING',
  'READY_FOR_QC',
];

export const PROGRESS_TRIGGERS_STATUS = {
  READY_FOR_QC: 'READY',
};

export function isValidMechanicProgress(stage) {
  return MECHANIC_PROGRESS_STAGES.includes(stage);
}
