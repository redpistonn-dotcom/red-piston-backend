/**
 * return-policy.js — category/brand-level return-window overrides.
 *
 * Shop.returnPolicyDays is the shop-wide default. A BRAND override wins over
 * a CATEGORY override, which wins over the shop default — same "flagged, not
 * blocked" behavior as before, just resolved per item instead of per shop.
 */

export async function loadReturnPolicyWindows(prisma, shopId) {
  const rows = await prisma.returnPolicyWindow.findMany({ where: { shopId } });
  const brandMap = new Map();
  const categoryMap = new Map();
  for (const r of rows) {
    if (r.scope === 'BRAND') brandMap.set(r.value, r.days);
    else if (r.scope === 'CATEGORY') categoryMap.set(r.value, r.days);
  }
  return { brandMap, categoryMap };
}

export function resolveReturnPolicyDays(windows, { brand, categoryL1 }, defaultDays) {
  if (brand && windows.brandMap.has(brand)) return windows.brandMap.get(brand);
  if (categoryL1 && windows.categoryMap.has(categoryL1)) return windows.categoryMap.get(categoryL1);
  return defaultDays;
}
