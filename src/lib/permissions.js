// RBAC permission system for ShopUser roles

export const ROLES = {
  OWNER: "OWNER",
  MANAGER: "MANAGER",
  CASHIER: "CASHIER",
  MECHANIC: "MECHANIC",
  DELIVERY: "DELIVERY",
};

export const ROLE_DEFAULTS = {
  OWNER: [
    "billing.*",
    "inventory.*",
    "party.*",
    "staff.*",
    "report.*",
    "settings.*",
    "workshop.*",
    "purchase.*",
  ],
  MANAGER: [
    "billing.*",
    "inventory.*",
    "party.*",
    "report.*",
    "workshop.*",
    "purchase.*",
  ],
  CASHIER: [
    "billing.create",
    "billing.view",
    "inventory.view",
    "party.view",
    "workshop.view",
  ],
  MECHANIC: [
    "workshop.*",
    "inventory.view",
  ],
  DELIVERY: [
    "billing.view",
    "party.view",
  ],
};

/**
 * Check whether a permission string from a grants list covers the required permission.
 * Supports wildcard: "billing.*" grants any "billing.X".
 *
 * @param {string} granted - A permission string from the user's grants (e.g. "billing.*")
 * @param {string} required - The permission being checked (e.g. "billing.create")
 * @returns {boolean}
 */
function matchesPermission(granted, required) {
  if (granted === required) return true;

  // Wildcard: "billing.*" covers "billing.create", "billing.view", etc.
  if (granted.endsWith(".*")) {
    const namespace = granted.slice(0, -2); // strip the ".*"
    return required === namespace || required.startsWith(namespace + ".");
  }

  return false;
}

/**
 * Determine whether a user has a required permission.
 *
 * Resolution order:
 *   1. Individual permissionsJson overrides (explicit allow/deny per key).
 *   2. ROLE_DEFAULTS for the role.
 *
 * permissionsJson is an object (or a JSON string) mapping permission strings
 * to booleans, e.g. { "billing.delete": false, "report.*": true }.
 * An explicit `false` denies the permission even if the role default allows it.
 *
 * @param {string} role - One of the ROLES values
 * @param {object|string|null} permissionsJson - Per-user permission overrides
 * @param {string} required - The permission to check (e.g. "billing.create")
 * @returns {boolean}
 */
export function hasPermission(role, permissionsJson, required) {
  // Normalise permissionsJson to a plain object
  let overrides = {};
  if (permissionsJson) {
    if (typeof permissionsJson === "string") {
      try {
        overrides = JSON.parse(permissionsJson);
      } catch {
        // Malformed JSON — treat as no overrides
        overrides = {};
      }
    } else if (typeof permissionsJson === "object") {
      overrides = permissionsJson;
    }
  }

  // Check individual overrides first (most specific wins within overrides).
  // Iterate all keys so that a wildcard override like "billing.*": false also works.
  for (const [key, allowed] of Object.entries(overrides)) {
    if (matchesPermission(key, required)) {
      return Boolean(allowed);
    }
  }

  // Fall back to role defaults
  const defaults = ROLE_DEFAULTS[role] ?? [];
  return defaults.some((granted) => matchesPermission(granted, required));
}
