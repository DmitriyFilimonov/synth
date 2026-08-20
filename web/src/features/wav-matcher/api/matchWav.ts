import type {
  MatchConfig,
  MatchHistoryEntry,
  MatchTargetInfo,
  JobEntry,
  JobListEntry,
  CreateJobResponse,
} from '../model/types';

export async function createMatchJob(
  file: File,
  config: MatchConfig,
): Promise<CreateJobResponse> {
  const buffer = await file.arrayBuffer();

  const params = new URLSearchParams();
  if (config.numOscillators)
    params.set('numOscillators', String(config.numOscillators));
  if (config.maxIterations)
    params.set('maxIterations', String(config.maxIterations));
  if (file.name) params.set('fileName', file.name);

  const response = await fetch(
    `/api/match/job?${params.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: buffer,
    },
  );

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(
      (error as { error?: string }).error ?? 'Failed to create job',
    );
  }

  return response.json() as Promise<CreateJobResponse>;
}

export async function getJobStatus(jobId: string): Promise<JobEntry> {
  const response = await fetch(
    `/api/match/jobs/${jobId}?_=${Date.now()}`,
    { cache: 'no-store' },
  );
  if (!response.ok) {
    throw new Error('Failed to fetch job status');
  }
  return response.json() as Promise<JobEntry>;
}

export async function listJobs(): Promise<JobListEntry[]> {
  const response = await fetch(`/api/match/jobs?_=${Date.now()}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error('Failed to fetch jobs list');
  }
  return response.json() as Promise<JobListEntry[]>;
}

export async function downloadJobResult(
  jobId: string,
): Promise<Blob> {
  const response = await fetch(`/api/match/jobs/${jobId}/download`);
  if (!response.ok) {
    throw new Error('Failed to download result');
  }
  return response.blob();
}

export async function downloadJobParams(
  jobId: string,
): Promise<Blob> {
  const response = await fetch(
    `/api/match/jobs/${jobId}/download-params`,
  );
  if (!response.ok) {
    throw new Error('Failed to download synth params');
  }
  return response.blob();
}

interface MatchResponse {
  history: MatchHistoryEntry[];
  targetInfo: MatchTargetInfo;
  suppressionPercent: number;
  wavBase64: string;
}

export async function matchWav(
  file: File,
  config: MatchConfig,
): Promise<Blob> {
  const base64 = await fileToBase64(file);

  const response = await fetch('/api/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wavBase64: base64,
      numOscillators: config.numOscillators,
      maxIterations: config.maxIterations,
    }),
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(
      (error as { error?: string }).error ?? 'Match failed',
    );
  }

  const data = (await response.json()) as MatchResponse;
  const byteCharacters = atob(data.wavBase64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: 'audio/wav' });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]!);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
