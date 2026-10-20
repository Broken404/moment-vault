import { describe, expect, it } from 'vitest';
import { formatTime, initialSelection, moveEndpoint, parseTime, timeAtPointer } from '../packages/shared/src/range';
import { validatePreferences } from '../packages/shared/src/model';

describe('one shared A/B range', () => {
  it('initializes near the end, including short sources and nonzero seekable starts', () => {
    expect(initialSelection(99, { start: 0, end: 100 })).toEqual({ a: 99, b: 100 });
    expect(initialSelection(100, { start: 98, end: 100 })).toEqual({ a: 98, b: 100 });
  });
  it('preserves the other endpoint and rejects crossing without corrupting selection', () => {
    const original = { a: 30, b: 35 };
    expect(moveEndpoint(original, 'a', 31, { start: 0, end: 7200 })).toEqual({ a: 31, b: 35 });
    expect(() => moveEndpoint(original, 'b', 29, { start: 0, end: 7200 })).toThrow();
    expect(original).toEqual({ a: 30, b: 35 });
  });
  it('maps the actual complete rail rather than thumb width, and supports nonzero domain', () => {
    expect(timeAtPointer(578, 302, 552, { start: 10, end: 30 })).toBe(20);
    expect(timeAtPointer(0, 302, 552, { start: 10, end: 30 })).toBe(10);
    expect(() => timeAtPointer(1, 0, 0, { start: 0, end: 20 })).toThrow();
  });
  it('parses milliseconds without pretending to represent exact video frames', () => {
    expect(parseTime('1:02:03.125')).toBe(3723.125);
    expect(formatTime(3723.125)).toBe('1:02:03.125');
    expect(() => parseTime('1:60')).toThrow();
    expect(() => parseTime('')).toThrow();
  });
});

it('repairs corrupted persisted preferences while keeping valid values', () => {
  expect(validatePreferences({ petOpacity: 0, step: NaN, petPosition: { x: 2, y: -1 } }))
    .toMatchObject({ petOpacity: 0.3, step: 5, petPosition: { x: 1, y: 0 } });
});
