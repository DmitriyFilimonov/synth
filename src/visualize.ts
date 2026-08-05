import { writeFileSync } from 'node:fs';

interface LineDef {
  fn: (x: number) => number;
  label: string;
  color?: string;
}

interface ArgPlotSvg {
  lines: LineDef[];
  xMin: number;
  xMax: number;
  xLabel: string;
  yLabel: string;
  title: string;
  filePath: string;
  width?: number;
  height?: number;
  points?: number;
}

const COLORS = [
  '#4f46e5',
  '#dc2626',
  '#16a34a',
  '#ea580c',
  '#9333ea',
  '#0891b2',
];

export const plotToSvg = ({
  lines,
  xMin,
  xMax,
  xLabel,
  yLabel,
  title,
  filePath,
  width = 800,
  height = 400,
  points = 500,
}: ArgPlotSvg) => {
  const pad = { top: 40, right: 120, bottom: 50, left: 60 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const allSamples: { x: number; y: number }[][] = [];
  for (const line of lines) {
    const samples: { x: number; y: number }[] = [];
    for (let i = 0; i <= points; i++) {
      const x = xMin + ((xMax - xMin) * i) / points;
      samples.push({ x, y: line.fn(x) });
    }
    allSamples.push(samples);
  }

  let yMin = Math.min(...allSamples.flat().map((s) => s.y));
  let yMax = Math.max(...allSamples.flat().map((s) => s.y));
  const yPad = (yMax - yMin) * 0.1 || 0.1;
  yMin -= yPad;
  yMax += yPad;

  const toSvgX = (x: number) =>
    pad.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const toSvgY = (y: number) =>
    pad.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

  const paths = allSamples.map((samples, li) => {
    const color = lines[li]?.color ?? COLORS[li % COLORS.length];
    const d = samples
      .map(
        (s, i) =>
          `${i === 0 ? 'M' : 'L'} ${toSvgX(s.x).toFixed(1)} ${toSvgY(s.y).toFixed(1)}`,
      )
      .join(' ');
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
  });

  const yTicks = 5;
  const xTicks = 5;
  let yTickLines = '';
  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + ((yMax - yMin) * i) / yTicks;
    const sy = toSvgY(val);
    yTickLines += `<line x1="${pad.left}" y1="${sy.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${sy.toFixed(1)}" stroke="#ddd" stroke-width="1"/>`;
    yTickLines += `<text x="${(pad.left - 8).toFixed(1)}" y="${(sy + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="#666">${val.toFixed(3)}</text>`;
  }

  let xTickLines = '';
  for (let i = 0; i <= xTicks; i++) {
    const val = xMin + ((xMax - xMin) * i) / xTicks;
    const sx = toSvgX(val);
    xTickLines += `<line x1="${sx.toFixed(1)}" y1="${pad.top + plotH}" x2="${sx.toFixed(1)}" y2="${(pad.top + plotH + 5).toFixed(1)}" stroke="#666" stroke-width="1"/>`;
    xTickLines += `<text x="${sx.toFixed(1)}" y="${(pad.top + plotH + 20).toFixed(1)}" text-anchor="middle" font-size="12" fill="#666">${val.toFixed(2)}</text>`;
  }

  const legendX = pad.left + plotW + 15;
  let legend = '';
  lines.forEach((line, i) => {
    const color = line.color ?? COLORS[i % COLORS.length];
    const ly = pad.top + 20 + i * 22;
    legend += `<line x1="${legendX}" y1="${ly}" x2="${(legendX + 20).toFixed(1)}" y2="${ly}" stroke="${color}" stroke-width="2"/>`;
    legend += `<text x="${(legendX + 28).toFixed(1)}" y="${(ly + 4).toFixed(1)}" font-size="12" fill="#333">${line.label}</text>`;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  <text x="${width / 2}" y="24" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">${title}</text>
  <text x="16" y="${height / 2}" text-anchor="middle" font-size="13" fill="#555" transform="rotate(-90 16 ${height / 2})">${yLabel}</text>
  <text x="${width / 2}" y="${(height - 6).toFixed(1)}" text-anchor="middle" font-size="13" fill="#555">${xLabel}</text>
  <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="#fafafa" stroke="#ccc"/>
  ${yTickLines}
  ${xTickLines}
  ${paths.join('\n  ')}
  ${legend}
</svg>`;

  writeFileSync(filePath, svg);
  console.log(`Generated ${filePath}`);
};
