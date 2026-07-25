import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearIconPacks, registerIconPacks, resolveIcons } from '../src/icons.js';

// A minimal Iconify pack: one square icon whose body uses `currentColor`, plus the
// pack's default 24×24 canvas, so `iconToSVG` produces a "0 0 24 24" viewBox.
const PACK = {
  prefix: 'test',
  icons: { box: { body: '<rect x="2" y="2" width="20" height="20" fill="currentColor"/>' } },
  width: 24,
  height: 24,
};

describe('icons', () => {
  afterEach(() => {
    clearIconPacks();
    vi.restoreAllMocks();
  });

  it('resolves a registered icon to its viewBox and body', async () => {
    registerIconPacks([{ name: 'test', icons: PACK }]);
    const map = await resolveIcons(['test:box']);
    expect(map.get('test:box')).toEqual({
      viewBox: '0 0 24 24',
      body: '<rect x="2" y="2" width="20" height="20" fill="currentColor"/>',
    });
  });

  it('runs a lazy loader once, caching the pack for later renders', async () => {
    const loader = vi.fn().mockResolvedValue(PACK);
    registerIconPacks([{ name: 'test', loader }]);
    expect((await resolveIcons(['test:box'])).has('test:box')).toBe(true);
    expect((await resolveIcons(['test:box'])).has('test:box')).toBe(true);
    // The loader is consumed on first use, so the second render doesn't refetch.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('skips (with a warning) an unknown pack, a missing icon, and a malformed spec', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerIconPacks([{ name: 'test', icons: PACK }]);
    const map = await resolveIcons(['other:box', 'test:missing', 'noPrefix']);
    expect(map.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('resolves nothing (and touches no pack) for an empty spec set', async () => {
    const map = await resolveIcons([]);
    expect(map.size).toBe(0);
  });

  describe('bpmn pack', () => {
    it('is always available without registration, and survives a clear', async () => {
      clearIconPacks(); // no user packs registered
      const specs = [
        'bpmn:receive',
        'bpmn:send',
        'bpmn:script',
        'bpmn:manual',
        'bpmn:service',
        'bpmn:user',
        'bpmn:rule',
      ];
      const map = await resolveIcons(specs);
      expect(map.size).toBe(specs.length);
      for (const spec of specs) expect(map.get(spec)?.body).toBeTruthy();
    });

    it('rotates the manual glyph 90° clockwise', async () => {
      const map = await resolveIcons(['bpmn:manual']);
      expect(map.get('bpmn:manual')?.body).toContain('rotate(90');
    });

    it('mirrors the loop glyph on its vertical axis (hFlip)', async () => {
      const map = await resolveIcons(['bpmn:loop']);
      // iconToSVG realises an hFlip as a horizontal reflection: scale(-1 1).
      expect(map.get('bpmn:loop')?.body).toContain('scale(-1 1)');
    });

    it('includes the hand-drawn gateway markers', async () => {
      const specs = ['bpmn:exclusive', 'bpmn:inclusive', 'bpmn:parallel', 'bpmn:event'];
      const map = await resolveIcons(specs);
      expect(map.size).toBe(specs.length);
      for (const spec of specs) expect(map.get(spec)?.body).toContain('currentColor');
    });

    it('includes the ad-hoc marker glyph (a tilde)', async () => {
      const map = await resolveIcons(['bpmn:adhoc']);
      expect(map.get('bpmn:adhoc')?.body).toContain('currentColor');
    });

    it('includes the event-type markers in -in and -out variants', async () => {
      const specs = [
        'bpmn:message-in', 'bpmn:message-out',
        'bpmn:timer-in', 'bpmn:timer-out',
        'bpmn:conditional-in', 'bpmn:conditional-out',
        'bpmn:link-in', 'bpmn:link-out',
        'bpmn:error-in', 'bpmn:error-out',
        'bpmn:compensation-in', 'bpmn:compensation-out',
        'bpmn:signal-in', 'bpmn:signal-out',
        'bpmn:escalation-in', 'bpmn:escalation-out',
        'bpmn:cancel-in', 'bpmn:cancel-out',
        'bpmn:multiple-in', 'bpmn:multiple-out',
        'bpmn:parallel-in', 'bpmn:parallel-out',
        'bpmn:termination-out',
      ];
      const map = await resolveIcons(specs);
      expect(map.size).toBe(specs.length);
    });

    it('draws hand-drawn -in markers as outlines and -out as solid fills', async () => {
      const map = await resolveIcons(['bpmn:signal-in', 'bpmn:signal-out']);
      expect(map.get('bpmn:signal-in')?.body).toContain('stroke-width="1.25"');
      expect(map.get('bpmn:signal-out')?.body).toContain('fill="currentColor"');
    });

    it('warns and skips a task type with no bpmn glyph', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const map = await resolveIcons(['bpmn:receive-instance']);
      expect(map.size).toBe(0);
      expect(warn).toHaveBeenCalled();
    });
  });
});
