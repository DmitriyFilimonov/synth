import { SAMPLE_LENGTH_IN_SECONDS } from '../consts';
import {
  ampEnvConfigNormales,
  frequencyEnvelopeCreator,
  MAX_OSCILLATORS,
  oscConfigNormales,
} from '../synth';
import type { ArgCreateSynth } from '../synth';
import { FrequencyEnvelopeInputError } from './types';
import type { FrequencyEnvelopeRenderOptions } from './types';

const SAMPLE_INTERVALS = 500;
const SVG_WIDTH = 1000;
const PLOT_LEFT = 90;
const PLOT_RIGHT = 970;
const PLOT_TOP = 50;
const PLOT_BOTTOM = 410;
const LEGEND_COLUMNS = 4;
const LEGEND_ROW_HEIGHT = 26;
const X_TICK_INTERVALS = 5;
const Y_TICK_INTERVALS = 5;

const COLORS = [
  '#2563eb',
  '#dc2626',
  '#059669',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#ca8a04',
  '#db2777',
  '#4f46e5',
  '#65a30d',
] as const;

type OscillatorGroup = ArgCreateSynth['oscillators'][number];

interface NumericRange {
  min: number;
  max: number;
}

interface SelectedOscillator {
  index: number;
  oscillator: OscillatorGroup;
}

interface CurvePoint {
  time: number;
  frequency: number;
}

interface Curve {
  oscillatorIndex: number;
  color: string;
  points: CurvePoint[];
}

/** Return an object record or reject a malformed input value. */
const readRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new FrequencyEnvelopeInputError(
      `${path} must be an object`,
    );
  }

  return value as Record<string, unknown>;
};

/** Validate one finite numeric field against the synthesizer range. */
const readNumberInRange = (
  value: unknown,
  range: NumericRange,
  path: string,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FrequencyEnvelopeInputError(
      `${path} must be a finite number`,
    );
  }

  if (value < range.min || value > range.max) {
    throw new FrequencyEnvelopeInputError(
      `${path} must be between ${range.min} and ${range.max}`,
    );
  }

  return value;
};

/** Validate the complete patch while allowing unknown extra fields. */
const validatePatch = (patch: ArgCreateSynth): void => {
  const patchRecord = readRecord(patch, 'patch');
  const oscillators = patchRecord.oscillators;

  if (!Array.isArray(oscillators)) {
    throw new FrequencyEnvelopeInputError(
      'patch.oscillators must be an array',
    );
  }

  if (oscillators.length > MAX_OSCILLATORS) {
    throw new FrequencyEnvelopeInputError(
      `patch.oscillators must contain at most ${MAX_OSCILLATORS} items`,
    );
  }

  oscillators.forEach((group, index) => {
    const groupRecord = readRecord(
      group,
      `patch.oscillators[${index}]`,
    );
    const osc = readRecord(
      groupRecord.osc,
      `patch.oscillators[${index}].osc`,
    );
    const ampEnv = readRecord(
      groupRecord.ampEnv,
      `patch.oscillators[${index}].ampEnv`,
    );
    const oscPath = `patch.oscillators[${index}].osc`;
    const ampPath = `patch.oscillators[${index}].ampEnv`;

    readNumberInRange(
      osc.freqBase,
      oscConfigNormales.freqBase,
      `${oscPath}.freqBase`,
    );
    readNumberInRange(
      osc.freqStart,
      oscConfigNormales.freqStart,
      `${oscPath}.freqStart`,
    );
    readNumberInRange(
      osc.duration,
      oscConfigNormales.duration,
      `${oscPath}.duration`,
    );
    readNumberInRange(
      osc.slope,
      oscConfigNormales.slope,
      `${oscPath}.slope`,
    );
    readNumberInRange(
      osc.phase,
      oscConfigNormales.phase,
      `${oscPath}.phase`,
    );

    if (typeof osc.on !== 'boolean') {
      throw new FrequencyEnvelopeInputError(
        `${oscPath}.on must be a boolean`,
      );
    }

    readNumberInRange(
      ampEnv.startLevel,
      ampEnvConfigNormales.startLevel,
      `${ampPath}.startLevel`,
    );
    readNumberInRange(
      ampEnv.duration,
      ampEnvConfigNormales.duration,
      `${ampPath}.duration`,
    );
    readNumberInRange(
      ampEnv.slope,
      ampEnvConfigNormales.slope,
      `${ampPath}.slope`,
    );

    if (ampEnv.endLevel !== undefined) {
      readNumberInRange(
        ampEnv.endLevel,
        ampEnvConfigNormales.endLevel,
        `${ampPath}.endLevel`,
      );
    }
  });
};

/** Select active oscillators and preserve their order in the patch. */
const selectOscillators = (
  patch: ArgCreateSynth,
  oscillatorIndices: unknown,
): SelectedOscillator[] => {
  validatePatch(patch);

  const requestedIndices = new Set<number>();

  if (oscillatorIndices === undefined) {
    patch.oscillators.forEach((oscillator, index) => {
      if (oscillator.osc.on) {
        requestedIndices.add(index);
      }
    });

    if (requestedIndices.size === 0) {
      throw new FrequencyEnvelopeInputError(
        'Patch has no active oscillators',
      );
    }
  } else {
    if (!Array.isArray(oscillatorIndices)) {
      throw new FrequencyEnvelopeInputError(
        'oscillatorIndices must be an array',
      );
    }

    if (oscillatorIndices.length === 0) {
      throw new FrequencyEnvelopeInputError(
        'oscillatorIndices must not be empty',
      );
    }

    oscillatorIndices.forEach((value, position) => {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new FrequencyEnvelopeInputError(
          `oscillatorIndices[${position}] must be an integer`,
        );
      }

      if (value < 0 || value >= patch.oscillators.length) {
        throw new FrequencyEnvelopeInputError(
          `oscillatorIndices[${position}] is out of range`,
        );
      }

      const oscillator = patch.oscillators[value];
      if (oscillator === undefined) {
        throw new FrequencyEnvelopeInputError(
          `oscillatorIndices[${position}] is out of range`,
        );
      }

      if (!oscillator.osc.on) {
        throw new FrequencyEnvelopeInputError(
          `Oscillator ${value + 1} is not active`,
        );
      }

      requestedIndices.add(value);
    });
  }

  return patch.oscillators.flatMap((oscillator, index) =>
    requestedIndices.has(index) ? [{ index, oscillator }] : [],
  );
};

/** Sample each selected curve with the synthesizer's own formula. */
const sampleCurves = (
  selectedOscillators: SelectedOscillator[],
): Curve[] =>
  selectedOscillators.map(({ index, oscillator }) => {
    const config = oscillator.osc;
    const { frequencyEnvelop } = frequencyEnvelopeCreator({
      base: config.freqBase,
      modulation: config.freqStart - config.freqBase,
      duration: config.duration,
      slope: config.slope,
    });
    const points: CurvePoint[] = [];

    for (
      let interval = 0;
      interval <= SAMPLE_INTERVALS;
      interval += 1
    ) {
      const time =
        (SAMPLE_LENGTH_IN_SECONDS * interval) / SAMPLE_INTERVALS;
      points.push({
        time,
        frequency: frequencyEnvelop({ x: time }),
      });
    }

    return {
      oscillatorIndex: index,
      color: COLORS[index % COLORS.length] ?? '#111827',
      points,
    };
  });

/** Format SVG numbers without locale-dependent output. */
const formatNumber = (value: number, digits = 3): string => {
  let formatted = value.toFixed(digits);

  if (formatted.includes('.')) {
    formatted = formatted.replace(/0+$/, '').replace(/\.$/, '');
  }

  return formatted === '-0' ? '0' : formatted;
};

/** Build a standalone SVG document for the sampled curves. */
const buildSvg = (curves: Curve[]): string => {
  let minimumFrequency = Number.POSITIVE_INFINITY;
  let maximumFrequency = Number.NEGATIVE_INFINITY;

  curves.forEach((curve) => {
    curve.points.forEach(({ frequency }) => {
      minimumFrequency = Math.min(minimumFrequency, frequency);
      maximumFrequency = Math.max(maximumFrequency, frequency);
    });
  });

  const logFrequencySpan = Math.log(
    maximumFrequency / minimumFrequency,
  );
  const logPadding =
    logFrequencySpan === 0 ? Math.log(1.05) : logFrequencySpan * 0.08;
  const minimumLogY = Math.log(minimumFrequency) - logPadding;
  const maximumLogY = Math.log(maximumFrequency) + logPadding;

  const plotWidth = PLOT_RIGHT - PLOT_LEFT;
  const plotHeight = PLOT_BOTTOM - PLOT_TOP;
  const logYSpan = maximumLogY - minimumLogY;
  const toSvgX = (time: number): number =>
    PLOT_LEFT + (time / SAMPLE_LENGTH_IN_SECONDS) * plotWidth;
  const toSvgY = (frequency: number): number =>
    PLOT_BOTTOM -
    ((Math.log(frequency) - minimumLogY) / logYSpan) * plotHeight;
  const legendRows = Math.ceil(curves.length / LEGEND_COLUMNS);
  const legendStartY = PLOT_BOTTOM + 70;
  const svgHeight =
    legendStartY + legendRows * LEGEND_ROW_HEIGHT + 10;
  const elements: string[] = [];

  elements.push(
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${svgHeight}" viewBox="0 0 ${SVG_WIDTH} ${svgHeight}" role="img" aria-labelledby="frequency-envelopes-title" font-family="monospace">`,
    '<title id="frequency-envelopes-title">Frequency envelopes</title>',
    '<desc>Frequency in hertz on a logarithmic scale over 0.5 seconds for the selected oscillators.</desc>',
    `<rect width="${SVG_WIDTH}" height="${svgHeight}" fill="#ffffff"/>`,
    '<text x="500" y="28" text-anchor="middle" font-size="20" fill="#111827">Frequency envelopes</text>',
  );

  for (let tick = 0; tick <= X_TICK_INTERVALS; tick += 1) {
    const time = (SAMPLE_LENGTH_IN_SECONDS * tick) / X_TICK_INTERVALS;
    const x = toSvgX(time);
    elements.push(
      `<line x1="${formatNumber(x)}" y1="${PLOT_TOP}" x2="${formatNumber(x)}" y2="${PLOT_BOTTOM}" stroke="#e5e7eb" stroke-width="1"/>`,
      `<text x="${formatNumber(x)}" y="${PLOT_BOTTOM + 24}" text-anchor="middle" font-size="12" fill="#4b5563">${formatNumber(time, 2)}</text>`,
    );
  }

  for (let tick = 0; tick <= Y_TICK_INTERVALS; tick += 1) {
    const frequency = Math.exp(
      minimumLogY + (logYSpan * tick) / Y_TICK_INTERVALS,
    );
    const y = toSvgY(frequency);
    elements.push(
      `<line x1="${PLOT_LEFT}" y1="${formatNumber(y)}" x2="${PLOT_RIGHT}" y2="${formatNumber(y)}" stroke="#e5e7eb" stroke-width="1"/>`,
      `<text x="${PLOT_LEFT - 12}" y="${formatNumber(y + 4)}" text-anchor="end" font-size="12" fill="#4b5563">${formatNumber(frequency, 2)}</text>`,
    );
  }

  elements.push(
    `<rect x="${PLOT_LEFT}" y="${PLOT_TOP}" width="${plotWidth}" height="${plotHeight}" fill="none" stroke="#6b7280" stroke-width="1"/>`,
    '<text x="530" y="458" text-anchor="middle" font-size="14" fill="#111827">Time (s)</text>',
    '<text x="22" y="230" text-anchor="middle" font-size="14" fill="#111827" transform="rotate(-90 22 230)">Frequency (Hz, log)</text>',
  );

  curves.forEach((curve) => {
    const path = curve.points
      .map((point, pointIndex) => {
        const command = pointIndex === 0 ? 'M' : 'L';
        const x = formatNumber(toSvgX(point.time));
        const y = formatNumber(toSvgY(point.frequency));
        return `${command} ${x} ${y}`;
      })
      .join(' ');

    elements.push(
      `<path data-curve="true" data-oscillator-index="${curve.oscillatorIndex}" stroke="${curve.color}" d="${path}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
  });

  curves.forEach((curve, position) => {
    const column = position % LEGEND_COLUMNS;
    const row = Math.floor(position / LEGEND_COLUMNS);
    const columnWidth = plotWidth / LEGEND_COLUMNS;
    const x = PLOT_LEFT + column * columnWidth;
    const y = legendStartY + row * LEGEND_ROW_HEIGHT + 14;
    const label = `OSC ${String(curve.oscillatorIndex + 1).padStart(2, '0')}`;

    elements.push(
      `<g data-legend-item="true" data-oscillator-index="${curve.oscillatorIndex}">`,
      `<line x1="${formatNumber(x)}" y1="${y}" x2="${formatNumber(x + 24)}" y2="${y}" stroke="${curve.color}" stroke-width="3"/>`,
      `<text x="${formatNumber(x + 32)}" y="${y + 4}" font-size="13" fill="#111827">${label}</text>`,
      '</g>',
    );
  });

  elements.push('</svg>');
  return elements.join('\n');
};

/**
 * Render selected frequency envelopes as an autonomous SVG string.
 *
 * @throws FrequencyEnvelopeInputError for an invalid patch or selection.
 */
export const renderFrequencyEnvelopesSvg = (
  patch: ArgCreateSynth,
  options: FrequencyEnvelopeRenderOptions = {},
): string => {
  const optionsRecord = readRecord(options, 'options');
  const selectedOscillators = selectOscillators(
    patch,
    optionsRecord.oscillatorIndices,
  );

  return buildSvg(sampleCurves(selectedOscillators));
};
