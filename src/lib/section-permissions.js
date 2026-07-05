/**
 * section-permissions.js — maps sidebar section keys (see ERPShell.tsx
 * NAV_ITEMS) to the dot-namespace permission strings from lib/permissions.js.
 *
 * Used only to translate a shop owner's section picks (at invite time or when
 * editing an existing staff member) into the `permissions` JSON stored on
 * ShopUser, so the EXISTING requirePermission() API gates keep working for
 * sections-driven staff. `sections` itself (not this map) is the authoritative
 * source for nav visibility and frontend route access — this is a secondary,
 * best-effort projection onto the older permission-string system.
 */

export const SECTION_KEYS = [
  'dashboard', 'inventory', 'pos', 'parties', 'workshop', 'workshop-mp',
  'history', 'reports', 'orders', 'gstr', 'audit', 'staff', 'shop-settings',
  'returns', 'purchase-returns', 'warranty',
];

// Every namespace here must exist in lib/permissions.js ROLE_DEFAULTS.OWNER —
// that list is the full set of namespaces the rest of the app actually checks.
const SECTION_TO_NAMESPACES = {
  dashboard: [],
  inventory: ['inventory.*'],
  pos: ['billing.*'],
  parties: ['party.*'],
  workshop: ['workshop.*'],
  'workshop-mp': ['workshop.*'],
  history: ['inventory.*'],
  reports: ['report.*'],
  orders: ['billing.*'],
  gstr: ['billing.*'],
  audit: ['report.*'],
  staff: ['staff.*'],
  'shop-settings': ['settings.*'],
  returns: ['billing.*'],
  'purchase-returns': ['purchase.*'],
  warranty: ['billing.*'],
};

const ALL_NAMESPACES = [...new Set(Object.values(SECTION_TO_NAMESPACES).flat())];

/**
 * Build a `permissions` JSON object that explicitly grants every namespace
 * reachable from `sections` and explicitly denies every other namespace —
 * deliberately not relying on ROLE_DEFAULTS fallback, so a staff member's
 * effective access matches exactly what was picked, nothing implied by role.
 */
export function permissionsFromSections(sections) {
  const granted = new Set(sections.flatMap((s) => SECTION_TO_NAMESPACES[s] || []));
  const permissions = {};
  for (const ns of ALL_NAMESPACES) {
    permissions[ns] = granted.has(ns);
  }
  return permissions;
}

export function isValidSection(key) {
  return SECTION_KEYS.includes(key);
}
