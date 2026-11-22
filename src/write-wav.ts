import { writeFileSync } from 'node:fs';

interface ArgWriteWav {
  samples: Int16Array;
  sampleRate: number;
  filePath: string;
}

/**
 * Записывает сэмплы Int16Array в монофонический 16-битный PCM WAV.
 *
 * @param arg - Сэмплы, частота дискретизации и путь назначения
 * @returns Ничего; синхронно записывает файл
 * @throws Error если файл не удалось создать или записать
 * @remarks DataView использует смещение и длину выделенного Buffer,
 *   чтобы заголовок и сэмплы попадали именно в этот буфер.
 */
export const writeWav = ({
  samples,
  sampleRate,
  filePath,
}: ArgWriteWav): void => {
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const bufferSize = 44 + dataSize;

  const buffer = Buffer.alloc(bufferSize);
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645, false);

  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i++) {
    const sample = samples[i];
    if (sample !== undefined) {
      view.setInt16(44 + i * 2, sample, true);
    }
  }

  writeFileSync(filePath, buffer);
};
