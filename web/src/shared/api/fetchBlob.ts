export async function fetchBlob(
  path: string,
  options?: RequestInit,
): Promise<Blob> {
  const response = await fetch(path, {
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

  return response.blob();
}
