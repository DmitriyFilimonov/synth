import { MIN } from './envelope';
import {
  ArgCreateSynth,
  oscConfigNormales as oscNormales,
  ampEnvConfigNormales as ampEnvNormales,
} from './synth';

export const mapSynthConfigToVector = (
  arg: ArgCreateSynth,
): number[] =>
  arg.oscillators.flatMap<number>((osc) => {
    if (osc.osc.on) {
      const on = Number(osc.osc.on);

      const freqBase =
        (osc.osc.freqBase - oscNormales.freqBase.min) /
        (oscNormales.freqBase.max - oscNormales.freqBase.min);

      const freqStart =
        (osc.osc.freqStart - oscNormales.freqStart.min) /
        (oscNormales.freqStart.max - oscNormales.freqStart.min);

      const slope =
        (osc.osc.slope - oscNormales.slope.min) /
        (oscNormales.slope.max - oscNormales.slope.min);

      const freqEnvDuration =
        (osc.osc.duration - oscNormales.duration.min) /
        (oscNormales.duration.max - oscNormales.duration.min);

      const phase =
        (osc.osc.phase - oscNormales.phase.min) /
        (oscNormales.phase.max - oscNormales.phase.min);

      const ampEnvDuration =
        (osc.ampEnv.duration - ampEnvNormales.duration.min) /
        (ampEnvNormales.duration.max - ampEnvNormales.duration.min);

      const endLevel =
        ((osc.ampEnv.endLevel ?? MIN) - ampEnvNormales.endLevel.min) /
        (ampEnvNormales.endLevel.max - ampEnvNormales.endLevel.min);

      const ampEnvSlope =
        (osc.ampEnv.slope - ampEnvNormales.slope.min) /
        (ampEnvNormales.slope.max - ampEnvNormales.slope.min);

      const ampEnvStartLevel =
        (osc.ampEnv.startLevel - ampEnvNormales.startLevel.min) /
        (ampEnvNormales.startLevel.max -
          ampEnvNormales.startLevel.min);

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
    }

    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  });
