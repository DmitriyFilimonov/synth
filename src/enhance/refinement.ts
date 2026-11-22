import { mapSynthConfigToVector } from '../synth-config-to-vector';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { OSC_PARAMS } from '../optimize/consts';
import { VECTOR_PARAM_OFFSETS } from '../vector-param-offsets';
import type { CoordinateDescentConfig } from '../optimize/coordinate-descent';
import { limitPeak, type IdentifiabilityMap } from './engine';

/** Настройки короткой доводки, построенной по улучшенному патчу. */
export interface RefinementPlan {
  /** Тот же патч в нормализованном представлении оптимизатора. */
  initialVector: number[];
  /** Анкеры, сохранение флагов и расписание для coordinate descent. */
  config: Partial<CoordinateDescentConfig>;
}

/**
 * Строит стартовый вектор и ограничения для короткой C4-доводки
 * улучшенного патча.
 *
 * @param patch - Улучшенный патч, с которого начинается доводка
 * @param identifiability - Карта вердиктов идентифицируемости
 *   параметров
 * @returns Нормализованный стартовый вектор и переопределения CD
 * @remarks Функция замораживает `anchored`, `unknown` и параметры без
 *   вердикта, а `free` и `prior-owned` оставляет доступными спуску.
 *   Один короткий цикл работает без simulated annealing, пинков,
 *   рестартов и relocation: случайный скачок может стереть структуру,
 *   которую только что добавил движок. Исходные флаги осцилляторов
 *   сохраняются. Вызывающий код подгоняет патч к исходному WAV, а не
 *   к синтезу улучшенного патча.
 */
export function createRefinementPlan(
  patch: ArgCreateSynth,
  identifiability: IdentifiabilityMap,
): RefinementPlan {
  const frozenParameterIndices: number[] = [];
  patch.oscillators.forEach((_group, oscillatorIndex) => {
    for (const [name, offset] of Object.entries(
      VECTOR_PARAM_OFFSETS,
    )) {
      if (name === 'flag') {
        continue;
      }
      const verdict =
        identifiability.params[name]?.verdict ?? 'unknown';
      if (verdict === 'anchored' || verdict === 'unknown') {
        frozenParameterIndices.push(
          oscillatorIndex * OSC_PARAMS + offset,
        );
      }
    }
  });

  return {
    initialVector: mapSynthConfigToVector(patch),
    config: {
      frozenParameterIndices,
      preserveOscillatorFlags: true,
      maxRelocationAttemptsPerOsc: 0,
      saInitialTemp: 0,
      plateauRestartThreshold: Number.MAX_SAFE_INTEGER,
      frequencyStepCoarse: 0.000005,
      phaseStep: 0.0002,
      restartSchedule: [
        {
          startStep: 0.0025,
          minStep: 0.0001,
          label: 'C4_REFINEMENT',
        },
      ],
    },
  };
}

/** Результат потолка пика с учётом анкеров C4. */
export interface RefinementPeakLimit {
  /** Патч после ограничения либо исходный патч при пропуске. */
  patch: ArgCreateSynth;
  /** Показывает, пропущено ли ограничение из-за вердикта startLevel. */
  skipped: boolean;
  /** Причина пропуска для журнала улучшения. */
  skipReason?: string;
}

/**
 * Ограничивает пик после C4, не меняя заякоренный startLevel.
 *
 * @param patch - Патч, полученный после доводки
 * @param identifiability - Карта вердиктов идентифицируемости
 * @param options - Настройки синтеза, включая необязательную модель
 *   фазы
 * @returns Патч, признак пропуска и причину для аудита
 * @remarks При вердикте anchored или unknown функция возвращает исходный
 *   патч без изменений и объясняет пропуск. В остальных случаях она
 *   делегирует ограничение limitPeak с той же моделью фазы.
 */
export function limitRefinementPeak(
  patch: ArgCreateSynth,
  identifiability: IdentifiabilityMap,
  options: { phaseModel?: PhaseModel },
): RefinementPeakLimit {
  const verdict =
    identifiability.params.startLevel?.verdict ?? 'unknown';
  if (verdict === 'anchored' || verdict === 'unknown') {
    return {
      patch,
      skipped: true,
      skipReason: `потолок пика пропущен: startLevel имеет вердикт ${verdict}`,
    };
  }
  return {
    patch: limitPeak(patch, options),
    skipped: false,
  };
}
