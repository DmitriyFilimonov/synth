import { readFileSync } from 'node:fs';

interface ReadWavResult {
  samples: Int16Array;
  sampleRate: number;
  bitsPerSample: number;
  numChannels: number;
}

export const readWav = (filePath: string): ReadWavResult => {
  const buffer = readFileSync(filePath);
  const view = new DataView(buffer.buffer);

  const riff = view.getUint32(0, false);
  if (riff !== 0x52494646) {
    throw new Error(`Not a WAV file: missing RIFF header`);
  }

  const wave = view.getUint32(8, false);
  if (wave !== 0x57415645) {
    throw new Error(`Not a WAV file: missing WAVE marker`);
  }

  const fmtChunk = view.getUint32(12, false);
  if (fmtChunk !== 0x666d7420) {
    throw new Error(`Missing "fmt " chunk`);
  }

  const fmtSize = view.getUint32(16, true);
  const audioFormat = view.getUint16(20, true);
  if (audioFormat !== 1) {
    throw new Error(
      `Only PCM audio format supported, got ${audioFormat}`,
    );
  }

  const numChannels = view.getUint16(22, true);
  if (numChannels !== 1) {
    throw new Error(
      `Only mono WAV files supported, got ${numChannels} channels`,
    );
  }

  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  if (bitsPerSample !== 16) {
    throw new Error(
      `Only 16-bit samples supported, got ${bitsPerSample}`,
    );
  }

  const fmtChunkStart = 12;
  const dataChunkStart = fmtChunkStart + 8 + fmtSize;
  const dataChunk = view.getUint32(dataChunkStart, false);
  if (dataChunk !== 0x64617461) {
    throw new Error(`Missing "data" chunk`);
  }

  const dataSize = view.getUint32(dataChunkStart + 4, true);
  const dataOffset = dataChunkStart + 8;

  const numSamples = dataSize / 2;
  const samples = new Int16Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    samples[i] = view.getInt16(dataOffset + i * 2, true);
  }

  return { samples, sampleRate, bitsPerSample, numChannels };
};
