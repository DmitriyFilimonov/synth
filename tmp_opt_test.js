const { optimize } = require('./dist/optimize.js');
const { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } = require('./dist/consts.js');
const sampleRate = 44100;
const lengthSec = 0.1;
const target = [];
for (let i = 0; i < sampleRate * lengthSec; i++) {
  const t = i / sampleRate;
  target.push(Math.sin(2 * Math.PI * 440 * t) * MAX_AMPLITUDE_16_BIT_WAV_ENCODED);
}
// Enable first oscillator (on flag = 1) and set some params to 0.5
const initial = new Array(50 * 10).fill(0);
initial[0] = 1; // first oscillator on
for (let p = 1; p < 10; p++) initial[p] = 0.5;
const result = optimize({ initialVector: initial, targetSignal: target, sampleRate, maxIterations: 200 });
console.log('Best suppression:', result.history[result.history.length - 1].suppressionPercent);
