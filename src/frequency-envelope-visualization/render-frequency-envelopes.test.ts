import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MIN } from '../envelope';
import { synthPreset1 } from '../presets';
import { frequencyEnvelopeCreator, MAX_OSCILLATORS } from '../synth';
import type { ArgCreateSynth } from '../synth';
import {
  FrequencyEnvelopeInputError,
  renderFrequencyEnvelopesSvg,
} from './index';

type OscillatorGroup = ArgCreateSynth['oscillators'][number];

/** Clone the preset so individual tests can mutate it safely. */
const clonePreset = (): ArgCreateSynth => ({
  oscillators: synthPreset1.oscillators.map(({ osc, ampEnv }) => ({
    osc: { ...osc },
    ampEnv: { ...ampEnv },
  })),
});

/** Return the first test oscillator without a non-null assertion. */
const firstOscillator = (patch: ArgCreateSynth): OscillatorGroup => {
  const oscillator = patch.oscillators[0];
  if (oscillator === undefined) {
    throw new Error('Test preset must contain an oscillator');
  }

  return oscillator;
};

/** Create active, inactive, active oscillators at indices 0, 1, 2. */
const createSelectionPatch = (): ArgCreateSynth => {
  const first = firstOscillator(clonePreset());

  return {
    oscillators: [
      {
        osc: { ...first.osc, on: true },
        ampEnv: { ...first.ampEnv },
      },
      {
        osc: {
          ...first.osc,
          freqBase: 220,
          freqStart: 330,
          on: false,
        },
        ampEnv: { ...first.ampEnv },
      },
      {
        osc: {
          ...first.osc,
          freqBase: 660,
          freqStart: 990,
          on: true,
        },
        ampEnv: { ...first.ampEnv },
      },
    ],
  };
};

/** Extract one curve element for path and color assertions. */
const curveTag = (svg: string, index: number): string => {
  const marker = `<path data-curve="true" data-oscillator-index="${index}"`;
  const start = svg.indexOf(marker);
  assert.notEqual(start, -1, `Missing curve for OSC ${index + 1}`);
  const end = svg.indexOf('/>', start);
  assert.notEqual(end, -1, 'Curve element must be closed');
  return svg.slice(start, end + 2);
};

/** Extract the stable stroke color from one curve. */
const curveColor = (svg: string, index: number): string => {
  const color = curveTag(svg, index).match(/stroke="([^"]+)"/)?.[1];
  assert.ok(color, 'Curve must have a stroke color');
  return color;
};

/** Extract the numeric root SVG height. */
const svgHeight = (svg: string): number => {
  const height = svg.match(/<svg[^>]+ height="(\d+)"/)?.[1];
  assert.ok(height, 'SVG must have a height');
  return Number(height);
};

void test('frequency envelope matches the synthesizer formula', () => {
  const { frequencyEnvelop } = frequencyEnvelopeCreator({
    base: 440,
    modulation: 440,
    duration: 0.2,
    slope: 0.8,
  });
  const time = 0.05;
  const expected =
    440 + 440 * Math.exp(Math.log(MIN) * (time / 0.2) ** 0.8);

  assert.equal(frequencyEnvelop({ x: 0 }), 880);
  assert.ok(
    Math.abs(frequencyEnvelop({ x: time }) - expected) < 1e-9,
  );
});

void test('frequency envelope retains its final value after duration', () => {
  const { frequencyEnvelop } = frequencyEnvelopeCreator({
    base: 440,
    modulation: 440,
    duration: 0.2,
    slope: 0.8,
  });
  const atDuration = frequencyEnvelop({ x: 0.2 });

  assert.ok(Math.abs(atDuration - (440 + 440 * MIN)) < 1e-9);
  assert.equal(frequencyEnvelop({ x: 0.5 }), atDuration);
});

void test('renderer creates a standalone SVG with 500 intervals', () => {
  const svg = renderFrequencyEnvelopesSvg(clonePreset());
  const curveCount =
    svg.match(/<path data-curve="true"/g)?.length ?? 0;
  const legendCount =
    svg.match(/<g data-legend-item="true"/g)?.length ?? 0;
  const firstPath = curveTag(svg, 0).match(/ d="([^"]+)"/)?.[1];

  assert.ok(svg.startsWith('<?xml version="1.0"'));
  assert.ok(svg.endsWith('</svg>'));
  assert.equal(curveCount, 2);
  assert.equal(legendCount, 2);
  assert.ok(firstPath, 'Curve must contain path data');
  assert.equal(firstPath.match(/[ML] /g)?.length, 501);
  assert.match(svg, /Time \(s\)/);
  assert.match(svg, /Frequency \(Hz\)/);
  assert.doesNotMatch(svg, /<script|<image|<link/);
});

void test('selection preserves patch order and stable original colors', () => {
  const patch = createSelectionPatch();
  const selected = renderFrequencyEnvelopesSvg(patch, {
    oscillatorIndices: [2, 0],
  });
  const onlyThird = renderFrequencyEnvelopesSvg(patch, {
    oscillatorIndices: [2],
  });
  const firstPosition = selected.indexOf(
    '<path data-curve="true" data-oscillator-index="0"',
  );
  const thirdPosition = selected.indexOf(
    '<path data-curve="true" data-oscillator-index="2"',
  );

  assert.ok(firstPosition >= 0);
  assert.ok(thirdPosition > firstPosition);
  assert.doesNotMatch(selected, /OSC 02/);
  assert.equal(curveColor(onlyThird, 2), curveColor(selected, 2));
  assert.doesNotMatch(onlyThird, /OSC 01|OSC 02/);
  assert.match(onlyThird, /OSC 03/);
});

void test('default selection excludes inactive oscillators', () => {
  const svg = renderFrequencyEnvelopesSvg(createSelectionPatch());

  assert.match(svg, /OSC 01/);
  assert.doesNotMatch(svg, /OSC 02/);
  assert.match(svg, /OSC 03/);
});

void test('invalid oscillator selections are rejected', () => {
  const patch = createSelectionPatch();
  const invalidSelections: readonly (readonly number[])[] = [
    [],
    [1],
    [3],
    [-1],
    [0.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
  ];

  invalidSelections.forEach((oscillatorIndices) => {
    assert.throws(
      () =>
        renderFrequencyEnvelopesSvg(patch, {
          oscillatorIndices,
        }),
      FrequencyEnvelopeInputError,
    );
  });

  assert.throws(
    () =>
      renderFrequencyEnvelopesSvg(patch, {
        oscillatorIndices: ['0'] as unknown as readonly number[],
      }),
    FrequencyEnvelopeInputError,
  );

  patch.oscillators.forEach((oscillator) => {
    oscillator.osc.on = false;
  });
  assert.throws(
    () => renderFrequencyEnvelopesSvg(patch),
    /no active oscillators/,
  );
});

void test('patch validation rejects malformed fields and ranges', () => {
  const nonFinite = clonePreset();
  firstOscillator(nonFinite).osc.freqBase = Number.NaN;

  const outOfRange = clonePreset();
  firstOscillator(outOfRange).osc.duration = 0;

  const source = firstOscillator(clonePreset());
  const tooMany: ArgCreateSynth = {
    oscillators: Array.from({ length: MAX_OSCILLATORS + 1 }, () => ({
      osc: { ...source.osc },
      ampEnv: { ...source.ampEnv },
    })),
  };
  const invalidPatches: readonly ArgCreateSynth[] = [
    null as unknown as ArgCreateSynth,
    {} as ArgCreateSynth,
    nonFinite,
    outOfRange,
    tooMany,
    {
      oscillators: [
        {
          osc: { ...source.osc },
        },
      ],
    } as unknown as ArgCreateSynth,
  ];

  invalidPatches.forEach((patch) => {
    assert.throws(
      () => renderFrequencyEnvelopesSvg(patch),
      FrequencyEnvelopeInputError,
    );
  });
});

void test('optional endLevel and unknown extra fields are accepted', () => {
  const patch = clonePreset() as ArgCreateSynth & {
    description?: string;
  };
  patch.description = 'Unknown fields must be preserved by callers';
  delete firstOscillator(patch).ampEnv.endLevel;

  assert.doesNotThrow(() => renderFrequencyEnvelopesSvg(patch));
});

void test('rendering is deterministic and sizes the legend by rows', () => {
  const patch = clonePreset();
  const source = firstOscillator(patch);

  for (let index = patch.oscillators.length; index < 5; index += 1) {
    patch.oscillators.push({
      osc: {
        ...source.osc,
        freqBase: 300 + index * 100,
        freqStart: 600 + index * 100,
      },
      ampEnv: { ...source.ampEnv },
    });
  }

  const oneCurve = renderFrequencyEnvelopesSvg(patch, {
    oscillatorIndices: [0],
  });
  const fiveCurves = renderFrequencyEnvelopesSvg(patch);

  assert.equal(fiveCurves, renderFrequencyEnvelopesSvg(patch));
  assert.ok(svgHeight(fiveCurves) > svgHeight(oneCurve));
});
