export const MIN = 0.001;

export interface ArgEvelopCreator {
  /**0 > max ≤1 */
  max: number;
  /**0 > min ≤ 0.001*/
  min?: number;
  /**s */
  duration: number;
  /**кривизна (по умолчанию 1) */
  slope: number;
}

export interface ArgEnvelope {
  /**s */
  x: number;
}

export const envelopeCreator =
  (argEnvelopCreator: ArgEvelopCreator) => (arg: ArgEnvelope) => {
    if (
      argEnvelopCreator.min !== undefined &&
      typeof argEnvelopCreator.min === 'number' &&
      argEnvelopCreator?.min <= 0
    ) {
      throw new Error(
        'Ошибка определения минимального значения огибающей. Должно быть > 0.',
      );
    }

    return (
      Math.E **
      (Math.log(argEnvelopCreator.min ?? MIN) *
        (arg.x / argEnvelopCreator.duration) **
          (argEnvelopCreator.slope ?? 1))
    );
  };
