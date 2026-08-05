import { envelopeCreator, MIN } from './envelope';
import { plotToSvg } from './visualize';
import { synthPreset } from './presets';

const preset = synthPreset;
const firstOsc = preset.oscillators[0];

if (!firstOsc) {
  throw new Error('No oscillators configured');
}

const kValues = [1];

const ampLines = kValues.map((k) => ({
  fn: (x: number) =>
    envelopeCreator({
      duration: firstOsc.ampEnv.duration,
      max: firstOsc.ampEnv.startLevel,
      min: firstOsc.ampEnv.endLevel,
      slope: k,
    })({ x }),
  label: `k = ${k}`,
}));

plotToSvg({
  lines: ampLines,
  xMin: 0,
  xMax: firstOsc.ampEnv.duration,
  xLabel: 'Время (с)',
  yLabel: 'Амплитуда',
  title: 'Огибающая амплитуды',
  filePath: 'envelope-amplitude.svg',
});

const freqLines = kValues.map((k) => {
  const mod = firstOsc.osc.freqStart - firstOsc.osc.freqBase;
  const fnNorm = envelopeCreator({
    duration: firstOsc.osc.duration,
    max: 1,
    min: MIN,
    slope: k,
  });
  return {
    fn: (x: number) => firstOsc.osc.freqBase + mod * fnNorm({ x }),
    label: `k = ${k}`,
  };
});

plotToSvg({
  lines: freqLines,
  xMin: 0,
  xMax: firstOsc.osc.duration,
  xLabel: 'Время (с)',
  yLabel: 'Частота (Гц)',
  title: 'Огибающая частоты',
  filePath: 'envelope-frequency.svg',
});
