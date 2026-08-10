/**
 * Вычисляет RMS (среднеквадратичное) значение массива семплов.
 */
export const calculateRMS = (samples: number[]): number => {
  if (samples.length === 0) {
    return 0;
  }

  const sumOfSquares = samples.reduce(
    (acc, sample) => acc + sample * sample,
    0,
  );

  return Math.sqrt(sumOfSquares / samples.length);
};
