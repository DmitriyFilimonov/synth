import { MIN } from './envelope';
import {
  ArgCreateSynth,
  oscConfigNormales as oscNormales,
  ampEnvConfigNormales as ampEnvNormales,
} from './synth';

type SynthConfigToVector = (
  arg: ArgCreateSynth,
) => (readonly [number, number])[];

export const mapSynthConfigToVector: SynthConfigToVector = (arg) =>
  arg.oscillators.flatMap<readonly [number, number]>((osc) => {
    if (osc.osc.on) {
      const on = [Number(osc.osc.on), oscNormales.on.step] as const;

      const freqBase = [
        (osc.osc.freqBase - oscNormales.freqBase.min) /
          (oscNormales.freqBase.max - oscNormales.freqBase.min),
        oscNormales.freqBase.step,
      ] as const;

      const freqStart = [
        (osc.osc.freqStart - oscNormales.freqStart.min) /
          (oscNormales.freqStart.max - oscNormales.freqStart.min),
        oscNormales.freqStart.step,
      ] as const;

      const slope = [
        (osc.osc.slope - oscNormales.slope.min) /
          (oscNormales.slope.max - oscNormales.slope.min),
        oscNormales.slope.step,
      ] as const;

      const freqEnvDuration = [
        (osc.osc.duration - oscNormales.duration.min) /
          (oscNormales.duration.max - oscNormales.duration.min),
        oscNormales.duration.step,
      ] as const;

      const phase = [
        (osc.osc.phase - oscNormales.phase.min) /
          (oscNormales.phase.max - oscNormales.phase.min),
        oscNormales.phase.step,
      ] as const;

      const ampEnvDuration = [
        (osc.ampEnv.duration - ampEnvNormales.duration.min) /
          (ampEnvNormales.duration.max - ampEnvNormales.duration.min),
        ampEnvNormales.duration.step,
      ] as const;

      const endLevel = [
        ((osc.ampEnv.endLevel ?? MIN) - ampEnvNormales.endLevel.min) /
          (ampEnvNormales.endLevel.max - ampEnvNormales.endLevel.min),
        ampEnvNormales.endLevel.step,
      ] as const;

      const ampEnvSlope = [
        (osc.ampEnv.slope - ampEnvNormales.slope.min) /
          (ampEnvNormales.slope.max - ampEnvNormales.slope.min),
        ampEnvNormales.slope.step,
      ] as const;

      const ampEnvStartLevel = [
        (osc.ampEnv.startLevel - ampEnvNormales.startLevel.min) /
          (ampEnvNormales.startLevel.max -
            ampEnvNormales.startLevel.min),
        ampEnvNormales.startLevel.step,
      ] as const;

      return [
        on,
        freqBase,
        freqStart,
        slope,
        freqEnvDuration,
        phase,
        ampEnvDuration,
        endLevel,
        ampEnvSlope,
        ampEnvStartLevel,
      ];
    } else {
      return [
        [0, 0] as const,
        [0, 0] as const,
        [0, 0] as const,
        [0, 0] as const,
        [0, 0] as const,
        [0, 0] as const,
        [0, 0] as const,
        [0, 0] as const,
        [0, 0] as const,
        [0, 0] as const,
      ];
    }
  });
