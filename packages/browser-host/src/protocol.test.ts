import { describe, expect, it } from 'vitest';
import { frameEvent } from './protocol';
describe('untrusted frame messages', () => {
  it('rejects malformed events and oversized field sets', () => {
    expect(frameEvent(null)).toBe(false);
    expect(frameEvent({ action: 'add', values: [] })).toBe(false);
    expect(frameEvent({ action: 'add', values: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i, null])) })).toBe(false);
    expect(frameEvent({ action: 'add', values: { name: { type: 'string', value: 'Read' } } })).toBe(true);
  });
});
