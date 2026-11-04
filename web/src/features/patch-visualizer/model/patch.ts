import type { ActiveOscillator, SynthPatch } from './types';

const OSCILLATOR_NUMBER_FIELDS = [
  'freqBase',
  'freqStart',
  'duration',
  'slope',
  'phase',
] as const;

const AMPLITUDE_NUMBER_FIELDS = [
  'startLevel',
  'endLevel',
  'duration',
  'slope',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function validateFiniteFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): void {
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `Invalid patch: ${path}.${field} must be a finite number.`,
      );
    }
  }
}

/** Parse JSON text while preserving patch validation as a separate step. */
export function parsePatchJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown JSON error';
    throw new Error(`Invalid JSON: ${message}`);
  }
}

/** Validate the patch fields needed by the shared visualization API. */
export function validatePatch(value: unknown): SynthPatch {
  if (!isRecord(value) || !Array.isArray(value.oscillators)) {
    throw new Error(
      'Invalid patch: expected an object with an oscillators array.',
    );
  }

  if (
    value.oscillators.length === 0 ||
    value.oscillators.length > 50
  ) {
    throw new Error(
      'Invalid patch: oscillators must contain between 1 and 50 entries.',
    );
  }

  value.oscillators.forEach((entry, index) => {
    const path = `oscillators[${index}]`;
    if (!isRecord(entry) || !isRecord(entry.osc)) {
      throw new Error(
        `Invalid patch: ${path}.osc must be an object.`,
      );
    }

    validateFiniteFields(
      entry.osc,
      OSCILLATOR_NUMBER_FIELDS,
      `${path}.osc`,
    );
    if (typeof entry.osc.on !== 'boolean') {
      throw new Error(
        `Invalid patch: ${path}.osc.on must be a boolean.`,
      );
    }

    if (entry.ampEnv !== undefined) {
      if (!isRecord(entry.ampEnv)) {
        throw new Error(
          `Invalid patch: ${path}.ampEnv must be an object.`,
        );
      }
      validateFiniteFields(
        entry.ampEnv,
        AMPLITUDE_NUMBER_FIELDS,
        `${path}.ampEnv`,
      );
    }
  });

  return value as SynthPatch;
}

/** Return active oscillators with their original zero-based indices. */
export function getActiveOscillators(
  patch: SynthPatch,
): ActiveOscillator[] {
  return patch.oscillators.flatMap((oscillator, index) =>
    oscillator.osc.on ? [{ index, parameters: oscillator.osc }] : [],
  );
}

/** Convert an uploaded file or job name to a patch display name. */
export function getPatchBaseName(name: string): string {
  return name.replace(/\.json$/i, '').trim() || 'patch';
}

/** Build the required download name for a rendered patch. */
export function createSvgFileName(patchName: string): string {
  return `${getPatchBaseName(patchName)}_frequency-envelopes.svg`;
}
