interface OscillatorParams {
  /** Начальная фаза (рад) */
  initialPhase: number;
  on: boolean;
}

type ArgOscillatorCreator = OscillatorParams;
interface ArgOscillator {
  /** Текущая позиция по времени (с) */
  x: number;
  /** Значение огибающей амплитуды */
  amplitude: number;
  /** Значение огибающей частоты */
  frequency: number;
}

export const oscillatorCreator = (
  argOscillatorCreator: ArgOscillatorCreator,
): ((argOscillator: ArgOscillator) => number) => {
  return (argOscillator: ArgOscillator): number => {
    if (argOscillatorCreator.on) {
      return (
        Math.sin(
          argOscillator.x * argOscillator.frequency * 2 * Math.PI +
            argOscillatorCreator.initialPhase,
        ) * argOscillator.amplitude
      );
    } else {
      return 0;
    }
  };
};
