import { describe, it, expect } from 'vitest';
import { pageBounds } from '../lib/pagination.js';

describe('pageBounds', () => {
  it('returns defaults when params are missing', () => {
    expect(pageBounds(undefined, undefined)).toEqual({ take: 50, skip: 0 });
  });

  it('passes through valid values', () => {
    expect(pageBounds('25', '100')).toEqual({ take: 25, skip: 100 });
  });

  it('clamps negative limit/offset (Prisma would paginate in reverse)', () => {
    expect(pageBounds('-50', '-100')).toEqual({ take: 1, skip: 0 });
  });

  it('caps limit at maxLimit', () => {
    expect(pageBounds('99999', '0')).toEqual({ take: 200, skip: 0 });
    expect(pageBounds('99999', '0', { maxLimit: 100 })).toEqual({ take: 100, skip: 0 });
  });

  it('falls back to defaults on NaN input', () => {
    expect(pageBounds('abc', 'xyz')).toEqual({ take: 50, skip: 0 });
  });

  it('honours custom defLimit', () => {
    expect(pageBounds(undefined, undefined, { defLimit: 40 })).toEqual({ take: 40, skip: 0 });
  });
});
