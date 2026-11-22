/** Сохранение всех артефактов прямого CLI-запуска match. */
import { basename } from 'node:path';
import { writeJsonAtomicSync } from './dataset/shared';
import type { MatchResult } from './match';

/** Пути к главному JSON параметров и сопутствующим метаданным. */
export interface MatchArtifactPaths {
  paramsPath: string;
  metadataPath: string;
}

/**
 * Атомарно сохраняет патч и метаданные одного CLI-запуска.
 *
 * @param outputWavPath - Путь к уже синтезированному WAV
 * @param result - Полный результат {@link match}
 * @returns Пути к JSON параметров и метаданных
 * @throws Error если файловая система отклонила запись или rename
 * @remarks Параметры остаются чистым `ArgCreateSynth` и пригодны для
 *   повторного синтеза без конвертации. Metadata ссылается на WAV и
 *   params по имени файла, сохраняет обе метрики, историю, targetInfo
 *   и лучший вектор для продолжения спуска.
 */
export function writeMatchArtifacts(
  outputWavPath: string,
  result: MatchResult,
): MatchArtifactPaths {
  const paramsPath = `${outputWavPath}.params.json`;
  const metadataPath = `${outputWavPath}.metadata.json`;
  writeJsonAtomicSync(paramsPath, result.optimizedConfig);
  writeJsonAtomicSync(metadataPath, {
    wavFile: basename(outputWavPath),
    paramsFile: basename(paramsPath),
    suppressionPercent: result.suppressionPercent,
    globalSuppressionPercent: result.globalSuppressionPercent,
    history: result.history,
    targetInfo: result.targetInfo,
    bestVector: result.optimizedVector,
  });
  return { paramsPath, metadataPath };
}
