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

  let pos = 12;
  const size = buffer.byteLength;
  let fmtOffset = -1;
  let dataOffset = -1;
  let dataSize = 0;

  while (pos + 8 <= size) {
    const chunk = view.getUint32(pos, false);
    const chunkSize = view.getUint32(pos + 4, true);

    if (chunk === 0x666d7420) {
      fmtOffset = pos;
    } else if (chunk === 0x64617461) {
      dataOffset = pos;
      dataSize = chunkSize;
    }

    pos += 8 + chunkSize + (chunkSize % 2);
  }

  if (fmtOffset < 0) {
    throw new Error(`Missing "fmt " chunk`);
  }

  if (dataOffset < 0) {
    throw new Error(`Missing "data" chunk`);
  }

  const audioFormat = view.getUint16(fmtOffset + 8, true);
  if (audioFormat !== 1) {
    throw new Error(
      `Only PCM audio format supported, got ${audioFormat}`,
    );
  }

  const numChannels = view.getUint16(fmtOffset + 10, true);
  if (numChannels !== 1) {
    throw new Error(
      `Only mono WAV files supported, got ${numChannels} channels`,
    );
  }

  const sampleRate = view.getUint32(fmtOffset + 12, true);
  const bitsPerSample = view.getUint16(fmtOffset + 22, true);

  if (bitsPerSample !== 16) {
    throw new Error(
      `Only 16-bit samples supported, got ${bitsPerSample}`,
    );
  }

  const sampleDataOffset = dataOffset + 8;
  const numSamples = dataSize / 2;
  const samples = new Int16Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    samples[i] = view.getInt16(sampleDataOffset + i * 2, true);
  }

  return { samples, sampleRate, bitsPerSample, numChannels };
};
