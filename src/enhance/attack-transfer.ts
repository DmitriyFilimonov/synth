/**
 * Экспериментальный перенос уже найденной высокой атаки в свободные
 * слоты другого патча. Функция не подключена к сервису: сначала C6
 * должен пройти слух и проверку характера.
 */
import type { ArgCreateSynth } from '../synth';
import type { TransformAudit, TransformResult } from './transforms';

/** Правила отбора и переноса высоких компонентов. */
export interface TransferHighAttackArgs {
  /** Основной патч; его активные осцилляторы не меняются. */
  patch: ArgCreateSynth;
  /** Патч, из которого берутся высокие компоненты. */
  attackPatch: ArgCreateSynth;
  /** Минимальная частота включительно; по умолчанию 3000 Гц. */
  minFreqHz?: number;
  /**
   * Минимальная длительность огибающей включительно; по умолчанию
   * 1 мс отсекает более короткие импульсы.
   */
  minDurationSec?: number;
}

/**
 * Переносит самые сильные высокие компоненты в выключенные слоты.
 *
 * @param args - Основной патч, источник атаки и границы отбора
 * @returns При переносе — новый патч и аудит; если подходящих
 *   компонентов или выключенных слотов нет, возвращает исходный
 *   `patch` с `audit: null` и причиной в `skipReason`
 * @remarks Выключенные компоненты источника игнорируются, а оба
 *   порога применяются включительно. Активные осцилляторы основного
 *   патча никогда не заменяются, даже если они занимают исходный
 *   индекс высокого компонента. Компоненты сортируются по убыванию
 *   `startLevel`; при равенстве выше приоритет у меньшего исходного
 *   индекса. Входные патчи не мутируются. Перенос не доказывает
 *   улучшение и не запускает оптимизацию.
 */
export function transferHighAttack(
  args: TransferHighAttackArgs,
): TransformResult {
  const minFreqHz = args.minFreqHz ?? 3000;
  const minDurationSec = args.minDurationSec ?? 0.001;
  const available = args.attackPatch.oscillators
    .map((group, index) => ({ group, index }))
    .filter(
      ({ group }) =>
        group.osc.on &&
        group.osc.freqBase >= minFreqHz &&
        group.ampEnv.duration >= minDurationSec,
    )
    .sort(
      (a, b) =>
        b.group.ampEnv.startLevel - a.group.ampEnv.startLevel ||
        a.index - b.index,
    );
  if (available.length === 0) {
    return {
      patch: args.patch,
      audit: null,
      skipReason:
        'transferHighAttack: нет подходящих высоких компонентов',
    };
  }
  const patch = structuredClone(args.patch);
  let transferred = 0;
  for (let index = 0; index < patch.oscillators.length; index += 1) {
    const target = patch.oscillators[index];
    const source = available[transferred];
    if (target?.osc.on === false && source !== undefined) {
      patch.oscillators[index] = structuredClone(source.group);
      transferred += 1;
    }
  }
  if (transferred === 0) {
    return {
      patch: args.patch,
      audit: null,
      skipReason: 'transferHighAttack: нет выключенных слотов',
    };
  }
  const audit: TransformAudit = {
    name: 'transferHighAttack',
    detail: `перенёс ${transferred} высоких компонентов в выключенные слоты`,
  };
  return { patch, audit };
}
