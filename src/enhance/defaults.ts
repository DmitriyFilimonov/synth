/**
 * Дефолтная карта идентифицируемости (контракт C1 из
 * `docs/spec-kick-enhancement.md`), v0 по первым данным BOg
 * (4 сида, `docs/analysis-2026-11-19-bog-4seeds.md`): частоты
 * устойчивы — анкерим; огибающие как сырые параметры гуляют —
 * отдаём приорам; endLevel залипает на init — владелец приор.
 * Карта пересобирается из датасета; этот дефолт — запасной вариант
 * до тех пор, пока датасет мал.
 */
import { type IdentifiabilityMap } from './engine';

/** Карта v0: руками по первому анализу стабильности. */
export const DEFAULT_IDENTIFIABILITY: IdentifiabilityMap = {
  version: 1,
  params: {
    freqBase: { verdict: 'anchored' },
    freqStart: { verdict: 'anchored' },
    slope: { verdict: 'free' },
    duration: { verdict: 'free' },
    phase: { verdict: 'free' },
    ampEnvDuration: { verdict: 'free' },
    endLevel: { verdict: 'prior-owned' },
    ampEnvSlope: { verdict: 'free' },
    startLevel: { verdict: 'free' },
  },
};
