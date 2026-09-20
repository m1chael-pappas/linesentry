import { describe, expect, it } from 'vitest';
import { buildPlant, machineBaseline } from './plant.js';

describe('deterministic plant', () => {
  it('gives a machine the same baseline on every run with the same seed', () => {
    expect(machineBaseline('run-a', 'press-01')).toEqual(machineBaseline('run-a', 'press-01'));
  });

  it('gives different machines different baselines', () => {
    expect(machineBaseline('run-a', 'press-01')).not.toEqual(machineBaseline('run-a', 'press-02'));
  });

  it('changes the whole plant when the seed changes', () => {
    expect(machineBaseline('run-a', 'press-01')).not.toEqual(machineBaseline('run-b', 'press-01'));
  });

  it('keeps a machine identical when the plant around it grows', () => {
    const small = buildPlant(5, 1);
    const large = buildPlant(50, 4);
    expect(large[0]!.base).toEqual(small[0]!.base);
    expect(large[4]!.id).toBe(small[4]!.id);
    expect(large[4]!.base).toEqual(small[4]!.base);
  });

  it('produces the same reading sequence for the same seed', () => {
    const a = buildPlant(1, 1)[0]!;
    const b = buildPlant(1, 1)[0]!;
    const now = 1789000000000;
    const seqA = [0, 1, 2].map((i) => a.readings(now + i * 1000));
    const seqB = [0, 1, 2].map((i) => b.readings(now + i * 1000));
    expect(seqA).toEqual(seqB);
  });
});
