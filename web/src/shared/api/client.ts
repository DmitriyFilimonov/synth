const API_BASE = import.meta.env.VITE_API_URL ?? '';

export async function fetchApi<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(
      (error as { error?: string }).error ?? 'Request failed',
    );
  }

  return response.json() as Promise<T>;
}
