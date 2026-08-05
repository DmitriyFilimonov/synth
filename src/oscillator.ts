interface ArgOscillator {
  /** Текущая позиция по времени (с) */
  x: number;
  /** Значение огибающей амплитуды */
  amplitude: number;
  /** Значение огибающей частоты */
  frequency: number;
}

export const oscillatorCreator = () => {
  return (argOscillator: ArgOscillator) => {
    return (
      Math.sin(
        argOscillator.x * argOscillator.frequency * 2 * Math.PI,
      ) * argOscillator.amplitude
    );
  };
};
