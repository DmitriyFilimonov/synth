import { plotToSvg } from './visualize';
import { assessCancellationQuality } from './cancellation-assessment';
import { calculateRMS } from './rms';

interface ArgMatchVisualize {
  targetSignal: number[];
  synthSignal: number[];
  sampleRate: number;
  outputPath: string;
  history: { iteration: number; suppressionPercent: number }[];
}

const decimate = (
  signal: number[],
  targetLength: number,
): number[] => {
  if (signal.length <= targetLength) {
    return signal;
  }
  const step = signal.length / targetLength;
  const result: number[] = [];
  for (let i = 0; i < targetLength; i++) {
    const idx = Math.floor(i * step);
    const sample = signal[idx];
    if (sample !== undefined) {
      result.push(sample);
    }
  }
  return result;
};

export const matchVisualize = (arg: ArgMatchVisualize): void => {
  const DISPLAY_SAMPLES = 1000;

  const targetDecimated = decimate(arg.targetSignal, DISPLAY_SAMPLES);
  const synthDecimated = decimate(arg.synthSignal, DISPLAY_SAMPLES);

  const residualDecimated = targetDecimated.map(
    (t, i) => t - (synthDecimated[i] ?? 0),
  );

  const maxTime = arg.targetSignal.length / arg.sampleRate;
  const maxValue = Math.abs(
    Math.max(
      ...targetDecimated,
      ...synthDecimated,
      ...residualDecimated,
    ),
  );
  const yRange = maxValue > 0 ? maxValue : 1;

  plotToSvg({
    lines: [
      {
        fn: (x: number) => {
          const idx = Math.round(
            (x / maxTime) * (targetDecimated.length - 1),
          );
          return targetDecimated[idx] ?? 0;
        },
        label: 'Original',
        color: '#4f46e5',
      },
      {
        fn: (x: number) => {
          const idx = Math.round(
            (x / maxTime) * (synthDecimated.length - 1),
          );
          return synthDecimated[idx] ?? 0;
        },
        label: 'Synth',
        color: '#dc2626',
      },
      {
        fn: (x: number) => {
          const idx = Math.round(
            (x / maxTime) * (residualDecimated.length - 1),
          );
          return residualDecimated[idx] ?? 0;
        },
        label: 'Residual',
        color: '#999999',
      },
    ],
    xMin: 0,
    xMax: maxTime,
    xLabel: 'Time (s)',
    yLabel: 'Amplitude',
    title: 'Match Result: Original vs Synth vs Residual',
    filePath: `${arg.outputPath}-signal.svg`,
    width: 1200,
    height: 400,
    points: DISPLAY_SAMPLES,
  });

  if (arg.history.length > 0) {
    const maxIteration =
      arg.history[arg.history.length - 1]?.iteration ?? 0;

    plotToSvg({
      lines: [
        {
          fn: (x: number) => {
            const idx = Math.round(
              (x / maxIteration) * (arg.history.length - 1),
            );
            const entry = arg.history[idx];
            return entry?.suppressionPercent ?? 0;
          },
          label: 'Suppression %',
          color: '#16a34a',
        },
      ],
      xMin: 0,
      xMax: maxIteration,
      xLabel: 'Iteration',
      yLabel: 'Suppression %',
      title: 'Optimization Progress',
      filePath: `${arg.outputPath}-progress.svg`,
      width: 800,
      height: 400,
    });
  }

  const assessment = assessCancellationQuality({
    target: targetDecimated,
    generated: synthDecimated.map((s) => -s),
  });

  const targetRMS = calculateRMS(targetDecimated);
  const synthRMS = calculateRMS(synthDecimated);

  console.log(
    `Match visualization saved to ${arg.outputPath}-signal.svg`,
  );
  console.log(
    `Optimization progress saved to ${arg.outputPath}-progress.svg`,
  );
  console.log(
    `Final suppression: ${assessment.suppressionPercent.toFixed(2)}%`,
  );
  console.log(
    `Target RMS: ${targetRMS.toFixed(2)}, Synth RMS: ${synthRMS.toFixed(2)}`,
  );
};
