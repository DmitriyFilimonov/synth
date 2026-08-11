import { fetchBlob } from '@/shared/api/fetchBlob';
import type { GenerateRequest } from '../model/types';

export async function generateWav(
  config: GenerateRequest,
): Promise<Blob> {
  return fetchBlob('/api/generate', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}
