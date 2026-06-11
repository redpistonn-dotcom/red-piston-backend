/**
 * Clamp user-supplied limit/offset query params to safe bounds.
 * Prisma interprets negative take/skip as "from the end", which lets callers
 * bypass pagination caps and scrape in reverse; NaN values throw 500s.
 */
export function pageBounds(limit, offset, { defLimit = 50, maxLimit = 200 } = {}) {
  const take = Math.min(Math.max(parseInt(limit) || defLimit, 1), maxLimit);
  const skip = Math.max(parseInt(offset) || 0, 0);
  return { take, skip };
}
