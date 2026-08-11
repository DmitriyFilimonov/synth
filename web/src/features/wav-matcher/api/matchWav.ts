import type { MatchConfig, MatchHistoryEntry, MatchTargetInfo } from '../model/types';

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
