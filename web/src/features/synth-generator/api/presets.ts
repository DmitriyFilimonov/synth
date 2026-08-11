import { fetchApi } from '@/shared/api/client';
import type { PresetsResponse } from '../model/types';

export async function fetchPresets(): Promise<PresetsResponse> {
  return fetchApi<PresetsResponse>('/presets');
}
