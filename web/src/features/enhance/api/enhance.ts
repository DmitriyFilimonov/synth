import type {
  CreateEnhanceJobResponse,
  EnhanceAuditEntry,
  EnhanceConfig,
  EnhanceJobEntry,
  EnhanceJobListEntry,
} from '../model/types';

/**
 * Отбрасывает мусор из сырого журнала: бэкенд хранит enhanceAudit
 * как unknown[], поэтому форму каждой записи проверяем в рантайме.
 */
function parseAudit(raw: unknown): EnhanceAuditEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is EnhanceAuditEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { name?: unknown }).name === 'string' &&
      typeof (entry as { detail?: unknown }).detail === 'string',
  );
}

/** Создаёт задание улучшения: шлёт WAV бинарём на POST /api/enhance/job. */
export async function createEnhanceJob(
  file: File,
  config: EnhanceConfig,
): Promise<CreateEnhanceJobResponse> {
  const buffer = await file.arrayBuffer();

  const params = new URLSearchParams();
  params.set('enhancementStrength', String(config.enhancementStrength));
  if (config.maxIterations !== undefined) {
    params.set('maxIterations', String(config.maxIterations));
  }
  if (config.seed !== undefined) {
    params.set('seed', String(config.seed));
  }
  if (file.name) params.set('fileName', file.name);

  const response = await fetch(`/api/enhance/job?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: buffer,
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(
      (error as { error?: string }).error ??
        'Не удалось создать задание улучшения',
    );
  }

  return response.json() as Promise<CreateEnhanceJobResponse>;
}

/**
 * Читает общий список заданий и оставляет только enhance:
 * у них в params записана enhancementStrength.
 */
export async function listEnhanceJobs(): Promise<EnhanceJobListEntry[]> {
  const response = await fetch(`/api/match/jobs?_=${Date.now()}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error('Failed to fetch jobs list');
  }
  const jobs = (await response.json()) as EnhanceJobListEntry[];
  return jobs.filter(
    (job) => job.params?.enhancementStrength !== undefined,
  );
}

/** Читает полный статус задания; журнал улучшения проходит проверку формы. */
export async function getEnhanceJob(id: string): Promise<EnhanceJobEntry> {
  const response = await fetch(
    `/api/match/jobs/${encodeURIComponent(id)}?_=${Date.now()}`,
    { cache: 'no-store' },
  );
  if (!response.ok) {
    throw new Error('Failed to fetch job status');
  }
  const raw = (await response.json()) as Omit<
    EnhanceJobEntry,
    'enhanceAudit'
  > & { enhanceAudit?: unknown };
  return { ...raw, enhanceAudit: parseAudit(raw.enhanceAudit) };
}

/** Скачивает улучшенный WAV общим download-эндпоинтом очереди. */
export async function downloadEnhanceResult(jobId: string): Promise<Blob> {
  const response = await fetch(
    `/api/match/jobs/${encodeURIComponent(jobId)}/download`,
  );
  if (!response.ok) {
    throw new Error('Failed to download result');
  }
  return response.blob();
}
