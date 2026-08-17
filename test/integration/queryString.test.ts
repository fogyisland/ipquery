import { describe, it, expect } from 'vitest';
import { parseListQuery } from '../../src/web/admin/queryString';

describe('parseListQuery', () => {
  it('parses filters, sort, page, limit, ids', () => {
    const r = parseListQuery(
      'role=admin&disabled=0&since=2026-01-01&sort=-created_at&page=2&limit=50&ids=1,2,3',
      { filters: ['role', 'disabled', 'since'], sort: ['created_at', 'id'] },
    );
    expect(r.filters.role).toBe('admin');
    expect(r.filters.disabled).toBe('0');
    expect(r.filters.since).toBe('2026-01-01');
    expect(r.sort).toEqual({ col: 'created_at', dir: 'desc' });
    expect(r.page).toBe(2);
    expect(r.limit).toBe(50);
    expect(r.ids).toEqual([1, 2, 3]);
  });

  it('rejects unknown filter and sort columns', () => {
    const r = parseListQuery('evil=1&sort=password', { filters: ['role'], sort: ['id'] });
    expect(r.filters.evil).toBeUndefined();
    expect(r.sort).toBeNull();
  });

  it('clamps limit to max 200, defaults page=1 limit=25', () => {
    const r = parseListQuery('limit=99999&page=-5', { filters: [], sort: ['id'] });
    expect(r.limit).toBe(200);
    expect(r.page).toBe(1);
  });

  it('omits empty filters from result', () => {
    const r = parseListQuery('role=admin&disabled=', { filters: ['role', 'disabled'] });
    expect(r.filters.role).toBe('admin');
    expect('disabled' in r.filters).toBe(false);
  });
});
