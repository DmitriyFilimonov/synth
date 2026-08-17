import { writeFileSync } from 'node:fs';

interface ArgWriteWav {
  samples: Int16Array;
  sampleRate: number;
  filePath: string;
}

export const writeWav = ({
  samples,
  sampleRate,
  filePath,
}: ArgWriteWav): void => {
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const bufferSize = 44 + dataSize;

  const buffer = Buffer.alloc(bufferSize);
  const view = new DataView(buffer.buffer);

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
