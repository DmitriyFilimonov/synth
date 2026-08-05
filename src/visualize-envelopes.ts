import { envelopeCreator } from './envelope';
import { plotToSvg } from './visualize';
import { synthPreset } from './presets';

const preset = synthPreset;

const kValues = [0.3, 0.5, 1, 2, 4];

const ampLines = kValues.map((k) => ({
  fn: (x: number) =>
    envelopeCreator({
      duration: preset.ampEnv.duration,
      max: preset.ampEnv.startLevel,
      min: preset.ampEnv.endLevel,
      slope: k,
    })({ x }),
  label: `k = ${k}`,
}));

plotToSvg({
  lines: ampLines,
  xMin: 0,
  xMax: preset.ampEnv.duration,
  xLabel: 'Время (с)',
  yLabel: 'Амплитуда',
  title: 'Огибающая амплитуды',
  filePath: 'envelope-amplitude.svg',
});

const freqLines = kValues.map((k) => {
  const mod = preset.osc.freqStart - preset.osc.freqBase;
  const fnNorm = envelopeCreator({
    duration: preset.osc.duration,
    max: 1,
    min: Number.MIN_VALUE,
    slope: k,
  });
  return {
    fn: (x: number) => preset.osc.freqBase + mod * fnNorm({ x }),
    label: `k = ${k}`,
  };
});

plotToSvg({
  lines: freqLines,
  xMin: 0,
  xMax: preset.osc.duration,
  xLabel: 'Время (с)',
  yLabel: 'Частота (Гц)',
  title: 'Огибающая частоты',
  filePath: 'envelope-frequency.svg',
});
