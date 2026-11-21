/** Статус задания в очереди бэкенда. */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

/** Точка истории оптимизации: suppression на конкретной итерации. */
export interface ProgressEntry {
  iteration: number;
  suppressionPercent: number;
}

/** Запись журнала улучшения: какая трансформация что сделала. */
export interface EnhanceAuditEntry {
  /** Машинное имя трансформации. */
  name: string;
  /** Индекс осциллятора, которого коснулась правка. */
  oscillatorIndex?: number;
  /** Человекочитаемое описание правки. */
  detail: string;
}

/** Параметры, с которыми создали задание. */
export interface EnhanceJobParams {
  numOscillators: number;
  maxIterations: number;
  /** Сила улучшения 0..1; присутствует только у enhance-заданий. */
  enhancementStrength?: number;
  seed?: number;
  /** Бюджет доводки вторым match; 0 или отсутствие — без доводки. */
  refineIterations?: number;
}

/** Элемент списка заданий (GET /api/match/jobs). */
export interface EnhanceJobListEntry {
  id: string;
  /** Человекочитаемое имя задания (может отсутствовать у старых). */
  name?: string;
  status: JobStatus;
  suppressionPercent: number;
  globalSuppressionPercent?: number | null;
  params: EnhanceJobParams;
  createdAt: string;
  updatedAt: string;
}

/** Полный статус задания (GET /api/match/jobs/:id). */
export interface EnhanceJobEntry {
  id: string;
  name?: string;
  status: JobStatus;
  progress: ProgressEntry[];
  params: EnhanceJobParams;
  suppressionPercent: number;
  /** Честный global suppression match-патча к исходному сигналу. */
  globalSuppressionPercent?: number | null;
  /** Честный global suppression улучшенного WAV к исходному. */
  enhanceGlobalSuppressionPercent?: number | null;
  /** Журнал применённых трансформаций (уже проверен по форме). */
  enhanceAudit: EnhanceAuditEntry[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

/** Настройки, которые форма передаёт в createEnhanceJob. */
export interface EnhanceConfig {
  /** Сила улучшения: 0 — не трогать патч после match, 1 — к приорам. */
  enhancementStrength: number;
  maxIterations?: number;
  seed?: number;
}

/** Ответ POST /api/enhance/job. */
export interface CreateEnhanceJobResponse {
  id: string;
}
