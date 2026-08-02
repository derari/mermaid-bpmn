import { describe, expect, it } from 'vitest';
import { captionLines, wrapCaption } from '../src/layout/text.js';

// A deterministic stand-in for the SVG text measurer: every character is 8 wide.
const measure = (text: string): number => text.length * 8;
const CHAR = 8;
const width = (chars: number): number => chars * CHAR;

const linesOf = (caption: string): string[] => captionLines(caption);

describe('wrapCaption', () => {
  it('leaves a caption that already fits alone', () => {
    expect(wrapCaption('short', width(10), measure)).toBe('short');
  });

  it('breaks between words so no line is wider than the box', () => {
    const wrapped = wrapCaption('one two three four', width(9), measure);
    expect(linesOf(wrapped)).toEqual(['one two', 'three', 'four']);
    for (const line of linesOf(wrapped)) expect(measure(line)).toBeLessThanOrEqual(width(9));
  });

  it('fills each line as far as it goes', () => {
    expect(linesOf(wrapCaption('aa bb cc dd', width(5), measure))).toEqual(['aa bb', 'cc dd']);
  });

  it('wraps each explicit line on its own, keeping the break', () => {
    expect(linesOf(wrapCaption('one two\nthree four', width(3), measure))).toEqual([
      'one',
      'two',
      'thr',
      'ee',
      'fou',
      'r',
    ]);
  });

  it('collapses the whitespace it wraps on', () => {
    expect(linesOf(wrapCaption('one   two', width(3), measure))).toEqual(['one', 'two']);
  });

  // A single word can be wider than the shape; it has to be cut somewhere.
  it('breaks a word that does not fit a line of its own', () => {
    expect(linesOf(wrapCaption('abcdefgh', width(3), measure))).toEqual(['abc', 'def', 'gh']);
  });

  it('starts an over-wide word on a fresh line', () => {
    expect(linesOf(wrapCaption('ab cdefgh', width(3), measure))).toEqual(['ab', 'cde', 'fgh']);
  });

  it('makes progress even when a single character overflows', () => {
    expect(linesOf(wrapCaption('abc', width(0.5), measure))).toEqual(['a', 'b', 'c']);
  });

  it('truncates the last line with an ellipsis once it runs out of lines', () => {
    const wrapped = wrapCaption('one two three four', width(5), measure, 2);
    expect(linesOf(wrapped)).toEqual(['one', 'two…']);
  });

  it('shortens the last line so the ellipsis still fits', () => {
    const wrapped = wrapCaption('aaaaa bbbbb ccccc', width(5), measure, 2);
    expect(linesOf(wrapped)).toEqual(['aaaaa', 'bbbb…']);
  });

  it('keeps a caption that fits the line budget free of an ellipsis', () => {
    expect(wrapCaption('one two', width(3), measure, 2)).toBe('one\ntwo');
  });

  it('returns the caption untouched when there is no width to fit it into', () => {
    expect(wrapCaption('one two', 0, measure)).toBe('one two');
    expect(wrapCaption('one two', -10, measure)).toBe('one two');
  });

  it('returns the caption untouched when no line is allowed', () => {
    expect(wrapCaption('one two', width(3), measure, 0)).toBe('one two');
  });

  it('leaves an empty caption alone', () => {
    expect(wrapCaption('', width(10), measure)).toBe('');
  });
});
