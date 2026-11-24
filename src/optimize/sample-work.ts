/** Категории логических проходов длины N в coordinate descent. */
export type CoordinateDescentSampleWorkKind =
  'synth' | 'evaluation' | 'cache';

/** Фактически выполненные N-проходы, а не число итераций или wall time. */
export interface CoordinateDescentSampleWork {
  synth: number;
  evaluation: number;
  cache: number;
  total: number;
}

/** Изменяемый счётчик, который разделяют synth, metric и waveform cache. */
export interface CoordinateDescentSampleWorkCounter {
  values: Omit<CoordinateDescentSampleWork, 'total'>;
}

/** Создаёт пустой счётчик для одного синхронного CD-прогона. */
export function createCoordinateDescentSampleWorkCounter(): CoordinateDescentSampleWorkCounter {
  return {
    values: { synth: 0, evaluation: 0, cache: 0 },
  };
}

/** Добавляет `passes` фактических проходов по `sampleCount` отсчётам. */
export function addCoordinateDescentSampleWork(
  counter: CoordinateDescentSampleWorkCounter | undefined,
  kind: CoordinateDescentSampleWorkKind,
  sampleCount: number,
  passes = 1,
): void {
  if (counter === undefined) {
    return;
  }
  counter.values[kind] += sampleCount * passes;
}

/** Публикует неизменяемую по смыслу сводку с вычисленным total. */
export function snapshotCoordinateDescentSampleWork(
  counter: CoordinateDescentSampleWorkCounter,
): CoordinateDescentSampleWork {
  const values = { ...counter.values };
  return {
    ...values,
    total: values.synth + values.evaluation + values.cache,
  };
}

/**
 * Возвращает последний опубликованный счётчик CD.
 *
 * Пустая история означает, что бюджет не позволил выполнить даже общий
 * startup; в этом случае CD не сделал ни одного N-прохода.
 */
export function sampleWorkFromProgress(
  history: readonly {
    sampleWork?: CoordinateDescentSampleWork;
  }[],
): CoordinateDescentSampleWork {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const sampleWork = history[index]?.sampleWork;
    if (sampleWork !== undefined) {
      return { ...sampleWork };
    }
  }
  return { synth: 0, evaluation: 0, cache: 0, total: 0 };
}
