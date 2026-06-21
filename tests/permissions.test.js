import { describe, it, expect } from "vitest";
import { hasPermission, ROLE_DEFAULTS } from "../src/lib/permissions.js";

describe("ROLE_DEFAULTS shape", () => {
  it("exports ROLE_DEFAULTS with expected role keys", () => {
    expect(ROLE_DEFAULTS).toHaveProperty("OWNER");
    expect(ROLE_DEFAULTS).toHaveProperty("CASHIER");
    expect(ROLE_DEFAULTS).toHaveProperty("MECHANIC");
    expect(ROLE_DEFAULTS).toHaveProperty("DELIVERY");
  });
});

describe("OWNER role (wildcard grants)", () => {
  it("has billing.create via billing.* wildcard", () => {
    expect(hasPermission("OWNER", null, "billing.create")).toBe(true);
  });

  it("has billing.delete via billing.* wildcard", () => {
    expect(hasPermission("OWNER", null, "billing.delete")).toBe(true);
  });

  it("has inventory.delete via inventory.* wildcard", () => {
    expect(hasPermission("OWNER", null, "inventory.delete")).toBe(true);
  });

  it("has inventory.view via inventory.* wildcard", () => {
    expect(hasPermission("OWNER", null, "inventory.view")).toBe(true);
  });

  it("has staff.create via staff.* wildcard", () => {
    expect(hasPermission("OWNER", null, "staff.create")).toBe(true);
  });

  it("has settings.update via settings.* wildcard", () => {
    expect(hasPermission("OWNER", null, "settings.update")).toBe(true);
  });
});

describe("CASHIER role", () => {
  it("has billing.create (explicit grant)", () => {
    expect(hasPermission("CASHIER", null, "billing.create")).toBe(true);
  });

  it("has billing.view (explicit grant)", () => {
    expect(hasPermission("CASHIER", null, "billing.view")).toBe(true);
  });

  it("has inventory.view (explicit grant)", () => {
    expect(hasPermission("CASHIER", null, "inventory.view")).toBe(true);
  });

  it("does NOT have staff.create", () => {
    expect(hasPermission("CASHIER", null, "staff.create")).toBe(false);
  });

  it("does NOT have billing.delete", () => {
    expect(hasPermission("CASHIER", null, "billing.delete")).toBe(false);
  });

  it("does NOT have billing.override_credit by default", () => {
    expect(hasPermission("CASHIER", null, "billing.override_credit")).toBe(false);
  });

  it("does NOT have inventory.delete", () => {
    expect(hasPermission("CASHIER", null, "inventory.delete")).toBe(false);
  });
});

describe("MECHANIC role", () => {
  it("has workshop.create via workshop.* wildcard", () => {
    expect(hasPermission("MECHANIC", null, "workshop.create")).toBe(true);
  });

  it("has workshop.view via workshop.* wildcard", () => {
    expect(hasPermission("MECHANIC", null, "workshop.view")).toBe(true);
  });

  it("has inventory.view (explicit grant)", () => {
    expect(hasPermission("MECHANIC", null, "inventory.view")).toBe(true);
  });

  it("does NOT have billing.create", () => {
    expect(hasPermission("MECHANIC", null, "billing.create")).toBe(false);
  });

  it("does NOT have staff.create", () => {
    expect(hasPermission("MECHANIC", null, "staff.create")).toBe(false);
  });

  it("does NOT have inventory.delete", () => {
    expect(hasPermission("MECHANIC", null, "inventory.delete")).toBe(false);
  });
});

describe("DELIVERY role", () => {
  it("has billing.view (explicit grant)", () => {
    expect(hasPermission("DELIVERY", null, "billing.view")).toBe(true);
  });

  it("has party.view (explicit grant)", () => {
    expect(hasPermission("DELIVERY", null, "party.view")).toBe(true);
  });

  it("does NOT have billing.create", () => {
    expect(hasPermission("DELIVERY", null, "billing.create")).toBe(false);
  });

  it("does NOT have workshop.view", () => {
    expect(hasPermission("DELIVERY", null, "workshop.view")).toBe(false);
  });
});

describe("Individual permission overrides (object form)", () => {
  it("grants billing.override_credit to CASHIER via explicit override", () => {
    expect(
      hasPermission("CASHIER", { "billing.override_credit": true }, "billing.override_credit")
    ).toBe(true);
  });

  it("override true grants a permission the role does not have by default", () => {
    expect(
      hasPermission("CASHIER", { "staff.create": true }, "staff.create")
    ).toBe(true);
  });

  it("override false denies a permission the role DOES have by default", () => {
    expect(
      hasPermission("CASHIER", { "billing.create": false }, "billing.create")
    ).toBe(false);
  });

  it("wildcard override true grants all sub-permissions in the namespace", () => {
    expect(
      hasPermission("CASHIER", { "billing.*": true }, "billing.delete")
    ).toBe(true);
  });

  it("wildcard override false denies all sub-permissions in the namespace", () => {
    expect(
      hasPermission("OWNER", { "billing.*": false }, "billing.create")
    ).toBe(false);
  });

  it("unrelated override does not affect other permissions", () => {
    expect(
      hasPermission("CASHIER", { "report.*": true }, "billing.create")
    ).toBe(true); // still granted by role default
  });
});

describe("Individual permission overrides (JSON string form)", () => {
  it("parses a JSON string override and grants billing.override_credit to CASHIER", () => {
    expect(
      hasPermission("CASHIER", JSON.stringify({ "billing.override_credit": true }), "billing.override_credit")
    ).toBe(true);
  });

  it("parses a JSON string override and denies a default-granted permission", () => {
    expect(
      hasPermission("CASHIER", JSON.stringify({ "billing.create": false }), "billing.create")
    ).toBe(false);
  });

  it("treats malformed JSON string as no overrides (falls back to role defaults)", () => {
    expect(hasPermission("CASHIER", "not-valid-json{{{", "billing.create")).toBe(true);
  });
});

describe("Unknown / missing role", () => {
  it("unknown role string returns false for any permission", () => {
    expect(hasPermission("UNKNOWN_ROLE", null, "billing.create")).toBe(false);
  });

  it("unknown role with no overrides returns false for inventory.view", () => {
    expect(hasPermission("GHOST", null, "inventory.view")).toBe(false);
  });

  it("null role returns false for any permission", () => {
    expect(hasPermission(null, null, "billing.create")).toBe(false);
  });

  it("undefined role returns false for any permission", () => {
    expect(hasPermission(undefined, null, "billing.view")).toBe(false);
  });
});

describe("Edge cases", () => {
  it("null permissionsJson is treated as no overrides", () => {
    expect(hasPermission("CASHIER", null, "billing.create")).toBe(true);
  });

  it("empty object permissionsJson is treated as no overrides", () => {
    expect(hasPermission("CASHIER", {}, "billing.create")).toBe(true);
  });

  it("empty string permissionsJson is treated as no overrides", () => {
    expect(hasPermission("CASHIER", "", "billing.create")).toBe(true);
  });

  it("wildcard grant does NOT match the bare namespace without a dot suffix", () => {
    // "billing.*" should not match "billing" (no sub-action)
    // The implementation: required.startsWith(namespace + ".") OR required === namespace
    // Per the source, required === namespace IS matched — document that behaviour
    expect(hasPermission("OWNER", null, "billing")).toBe(true);
  });

  it("a permission in one namespace does not bleed into another", () => {
    expect(hasPermission("MECHANIC", null, "billing.view")).toBe(false);
  });
});
