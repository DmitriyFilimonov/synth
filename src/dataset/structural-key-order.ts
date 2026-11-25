/**
 * Persistent JSON order tokens для exact legacy beam ordering.
 *
 * Rope хранит raw text/backslash-run'ы и shared concat/json-string nodes.
 * Родительские tokens не копируются при вложении. Escaping вычисляется лениво
 * во время чтения, поэтому native parent-first nesting не удваивает память.
 */

/** Обычный текст либо сжатая последовательность backslash code units. */
export type StructuralKeyOrderSegment =
  | { kind: 'text'; text: string }
  | { kind: 'backslashes'; count: number };

/** Persistent raw/concat/json-string token без развёрнутой parent chain. */
export type StructuralKeyOrderToken =
  | {
      kind: 'raw';
      readonly segments: readonly StructuralKeyOrderSegment[];
    }
  | {
      kind: 'concat';
      readonly parts: readonly StructuralKeyOrderToken[];
    }
  | {
      kind: 'json-string';
      readonly value: StructuralKeyOrderToken;
    };

interface SegmentBuilder {
  segments: StructuralKeyOrderSegment[];
}

/** Добавляет обычный текст и объединяет соседние text-сегменты. */
function pushText(builder: SegmentBuilder, text: string): void {
  if (text.length === 0) {
    return;
  }
  const previous = builder.segments[builder.segments.length - 1];
  if (previous?.kind === 'text') {
    previous.text += text;
  } else {
    builder.segments.push({ kind: 'text', text });
  }
}

/** Добавляет backslashes числом, не материализуя строку run. */
function pushBackslashes(
  builder: SegmentBuilder,
  count: number,
): void {
  if (count === 0) {
    return;
  }
  const previous = builder.segments[builder.segments.length - 1];
  if (previous?.kind === 'backslashes') {
    previous.count += count;
  } else {
    builder.segments.push({ kind: 'backslashes', count });
  }
}

/**
 * Создаёт raw token из произвольной string или готового JSON-фрагмента.
 * Функция не экранирует вход и не ссылается на исходную строку.
 *
 * @param raw - Исходный текст или готовый JSON-фрагмент
 * @returns Persistent raw token со сжатыми backslash-run сегментами
 */
export function orderTokenFromRaw(
  raw: string,
): StructuralKeyOrderToken {
  const builder: SegmentBuilder = { segments: [] };
  let textStart = 0;
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== '\\') {
      index += 1;
      continue;
    }
    pushText(builder, raw.slice(textStart, index));
    let runEnd = index + 1;
    while (raw[runEnd] === '\\') {
      runEnd += 1;
    }
    pushBackslashes(builder, runEnd - index);
    index = runEnd;
    textStart = runEnd;
  }
  pushText(builder, raw.slice(textStart));
  return { kind: 'raw', segments: builder.segments };
}

/** Возвращает lowercase `uXXXX` suffix в точности JSON.stringify. */
function unicodeEscape(codeUnit: number): string {
  return `u${codeUnit.toString(16).padStart(4, '0')}`;
}

/** Возвращает named control suffix или lowercase Unicode suffix. */
function controlEscape(codeUnit: number): string {
  const named = new Map<number, string>([
    [8, 'b'],
    [9, 't'],
    [10, 'n'],
    [12, 'f'],
    [13, 'r'],
  ]);
  return named.get(codeUnit) ?? unicodeEscape(codeUnit);
}

/**
 * Применяет JSON string escaping лениво и не копирует raw token.
 * Собственные quotes обрабатывает reader на том же escape level, а value — на
 * следующем, что совпадает с рекурсивным JSON.stringify.
 *
 * @param raw - Token содержимого JSON-строки без окружающих quotes
 * @returns Lazy json-string token со ссылкой на исходный rope
 */
export function jsonStringOrderToken(
  raw: StructuralKeyOrderToken,
): StructuralKeyOrderToken {
  return { kind: 'json-string', value: raw };
}

/**
 * Склеивает JSON elements в shared concat rope без копирования parent.
 *
 * @param elements - Tokens JSON-элементов в исходном порядке
 * @returns Concat token с brackets и separators между элементами
 */
export function jsonArrayOrderToken(
  elements: readonly StructuralKeyOrderToken[],
): StructuralKeyOrderToken {
  const parts: StructuralKeyOrderToken[] = [orderTokenFromRaw('[')];
  for (const [index, element] of elements.entries()) {
    if (index > 0) {
      parts.push(orderTokenFromRaw(','));
    }
    parts.push(element);
  }
  parts.push(orderTokenFromRaw(']'));
  return { kind: 'concat', parts };
}

type ReaderTask =
  | {
      kind: 'node';
      node: StructuralKeyOrderToken;
      escapeCount: number;
    }
  | {
      kind: 'segment';
      segment: StructuralKeyOrderSegment;
      escapeCount: number;
    }
  | {
      kind: 'literal';
      segment: StructuralKeyOrderSegment;
    }
  | { kind: 'quote'; escapeCount: number };

interface OrderReader {
  tasks: ReaderTask[];
}

/** Создаёт lazy reader с явным LIFO-stack вместо recursive call stack. */
function createReader(token: StructuralKeyOrderToken): OrderReader {
  return { tasks: [{ kind: 'node', node: token, escapeCount: 0 }] };
}

/** Возвращает escaped segments одного raw text fragment. */
function escapedTextSegments(
  text: string,
  escapeCount: number,
): StructuralKeyOrderSegment[] {
  if (escapeCount === 0 || text.length === 0) {
    return text.length === 0 ? [] : [{ kind: 'text', text }];
  }
  const builder: SegmentBuilder = { segments: [] };
  let chunkStart = 0;
  let index = 0;
  while (index < text.length) {
    const codeUnit = text.charCodeAt(index);
    const isHighSurrogate = codeUnit >= 0xd800 && codeUnit <= 0xdbff;
    const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
    const isPaired =
      isHighSurrogate &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff;
    if (isPaired) {
      index += 2;
      continue;
    }
    const isQuote = codeUnit === 0x22;
    const isControl = codeUnit <= 0x1f;
    const isLoneSurrogate =
      (isHighSurrogate || isLowSurrogate) && !isPaired;
    if (!isQuote && !isControl && !isLoneSurrogate) {
      index += 1;
      continue;
    }
    pushText(builder, text.slice(chunkStart, index));
    if (isQuote) {
      pushBackslashes(builder, 2 ** escapeCount - 1);
      pushText(builder, '"');
    } else {
      pushBackslashes(builder, 2 ** (escapeCount - 1));
      pushText(builder, controlEscape(codeUnit));
    }
    index += 1;
    chunkStart = index;
  }
  pushText(builder, text.slice(chunkStart));
  return builder.segments;
}

/** Возвращает следующий lazy output segment или null после конца rope. */
function nextSegment(
  reader: OrderReader,
): StructuralKeyOrderSegment | null {
  while (reader.tasks.length > 0) {
    const task = reader.tasks.pop();
    if (task === undefined) {
      return null;
    }
    if (task.kind === 'literal') {
      return task.segment;
    }
    if (task.kind === 'quote') {
      const run = 2 ** task.escapeCount - 1;
      if (run > 0) {
        reader.tasks.push({
          kind: 'literal',
          segment: { kind: 'text', text: '"' },
        });
        return { kind: 'backslashes', count: run };
      }
      return { kind: 'text', text: '"' };
    }
    if (task.kind === 'segment') {
      if (task.segment.kind === 'backslashes') {
        return {
          kind: 'backslashes',
          count: task.segment.count * 2 ** task.escapeCount,
        };
      }
      const segments = escapedTextSegments(
        task.segment.text,
        task.escapeCount,
      );
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index];
        if (segment !== undefined) {
          reader.tasks.push({ kind: 'literal', segment });
        }
      }
      continue;
    }
    const { node, escapeCount } = task;
    if (node.kind === 'raw') {
      for (
        let index = node.segments.length - 1;
        index >= 0;
        index -= 1
      ) {
        const segment = node.segments[index];
        if (segment !== undefined) {
          reader.tasks.push({
            kind: 'segment',
            segment,
            escapeCount,
          });
        }
      }
      continue;
    }
    if (node.kind === 'concat') {
      for (
        let index = node.parts.length - 1;
        index >= 0;
        index -= 1
      ) {
        const nodePart = node.parts[index];
        if (nodePart !== undefined) {
          reader.tasks.push({
            kind: 'node',
            node: nodePart,
            escapeCount,
          });
        }
      }
      continue;
    }
    reader.tasks.push({ kind: 'quote', escapeCount });
    reader.tasks.push({
      kind: 'node',
      node: node.value,
      escapeCount: escapeCount + 1,
    });
    reader.tasks.push({ kind: 'quote', escapeCount });
  }
  return null;
}

interface TokenCursor {
  segment: StructuralKeyOrderSegment | null;
  offset: number;
}

/** Считывает следующий segment reader'а в cursor. */
function readCursor(reader: OrderReader, cursor: TokenCursor): void {
  cursor.segment = nextSegment(reader);
  cursor.offset = 0;
}

/** Возвращает оставшиеся UTF-16 code units текущего сегмента. */
function remaining(cursor: TokenCursor): number {
  const segment = cursor.segment;
  if (segment === null) {
    return 0;
  }
  return segment.kind === 'text'
    ? segment.text.length - cursor.offset
    : segment.count - cursor.offset;
}

/** Продвигает cursor и отмечает конец текущего segment. */
function advanceCursor(
  reader: OrderReader,
  cursor: TokenCursor,
  amount: number,
): void {
  cursor.offset += amount;
  if (remaining(cursor) === 0) {
    cursor.segment = null;
  }
}

/**
 * Совместно пропускает одинаковые shared nodes в обоих readers.
 *
 * @remarks Один и тот же token object при равном escapeCount выдаёт
 *   идентичный suffix. Поэтому удаление этого suffix из обоих потоков
 *   сохраняет итоговый order и не требует ни длины suffix, ни повторного
 *   обхода shared parent.
 */
function skipSharedNodes(
  aReader: OrderReader,
  bReader: OrderReader,
  aCursor: TokenCursor,
  bCursor: TokenCursor,
): void {
  if (aCursor.segment !== null || bCursor.segment !== null) {
    return;
  }
  while (aReader.tasks.length > 0 && bReader.tasks.length > 0) {
    const aTask = aReader.tasks[aReader.tasks.length - 1];
    const bTask = bReader.tasks[bReader.tasks.length - 1];
    if (
      aTask?.kind !== 'node' ||
      bTask?.kind !== 'node' ||
      aTask.node !== bTask.node ||
      aTask.escapeCount !== bTask.escapeCount
    ) {
      return;
    }
    aReader.tasks.pop();
    bReader.tasks.pop();
  }
}

/**
 * Сравнивает ropes в порядке legacy JS strings по UTF-16 code units.
 *
 * @param a - Левый order token
 * @param b - Правый order token
 * @returns Отрицательное число, ноль или положительное число в
 *   лексикографическом порядке
 * @remarks Readers лениво применяют escaping, пропускают общие
 *   backslash-run'ы диапазонами и удаляют одинаковые shared suffixes,
 *   не разворачивая rope в string.
 */
export function compareOrderTokens(
  a: StructuralKeyOrderToken,
  b: StructuralKeyOrderToken,
): number {
  if (a === b) {
    return 0;
  }
  const aReader = createReader(a);
  const bReader = createReader(b);
  const aCursor: TokenCursor = { segment: null, offset: 0 };
  const bCursor: TokenCursor = { segment: null, offset: 0 };
  while (true) {
    skipSharedNodes(aReader, bReader, aCursor, bCursor);
    if (aCursor.segment === null) {
      readCursor(aReader, aCursor);
    }
    if (bCursor.segment === null) {
      readCursor(bReader, bCursor);
    }
    const aSegment = aCursor.segment;
    const bSegment = bCursor.segment;
    if (aSegment === null || bSegment === null) {
      if (aSegment !== null) {
        return 1;
      }
      if (bSegment !== null) {
        return -1;
      }
      return 0;
    }
    if (aSegment.kind === 'text' && bSegment.kind === 'text') {
      const common = Math.min(remaining(aCursor), remaining(bCursor));
      for (let index = 0; index < common; index += 1) {
        const aCode = aSegment.text.charCodeAt(
          aCursor.offset + index,
        );
        const bCode = bSegment.text.charCodeAt(
          bCursor.offset + index,
        );
        if (aCode !== bCode) {
          return aCode - bCode;
        }
      }
      advanceCursor(aReader, aCursor, common);
      advanceCursor(bReader, bCursor, common);
      continue;
    }
    if (
      aSegment.kind === 'backslashes' &&
      bSegment.kind === 'backslashes'
    ) {
      const common = Math.min(remaining(aCursor), remaining(bCursor));
      advanceCursor(aReader, aCursor, common);
      advanceCursor(bReader, bCursor, common);
      continue;
    }
    const textCursor = aSegment.kind === 'text' ? aCursor : bCursor;
    const textSegment = textCursor.segment;
    if (textSegment?.kind === 'text') {
      const textCode = textSegment.text.charCodeAt(textCursor.offset);
      return aSegment.kind === 'text'
        ? textCode - 0x5c
        : 0x5c - textCode;
    }
  }
}

/**
 * Разворачивает rope только для маленьких debug/test fixtures.
 *
 * @param token - Order token, который нужно материализовать
 * @returns Полная legacy string с применённым JSON escaping
 * @remarks Production audit не вызывает эту функцию и не получает
 *   развёрнутые legacy strings.
 */
export function stringifyOrderToken(
  token: StructuralKeyOrderToken,
): string {
  const reader = createReader(token);
  const chunks: string[] = [];
  let segment = nextSegment(reader);
  while (segment !== null) {
    chunks.push(
      segment.kind === 'text'
        ? segment.text
        : '\\'.repeat(segment.count),
    );
    segment = nextSegment(reader);
  }
  return chunks.join('');
}

/** Ограниченная статистика unique rope nodes для memory regression tests. */
export interface StructuralKeyOrderStats {
  nodes: number;
  textUnits: number;
  maxBackslashRun: number;
  maxEscapeDepth: number;
}

/**
 * Считает unique nodes один раз, не дублируя shared parent subtrees.
 *
 * @param token - Корень order rope
 * @returns Ограниченная статистика nodes, text units и escape depth
 */
export function orderTokenStats(
  token: StructuralKeyOrderToken,
): StructuralKeyOrderStats {
  const seen = new Set<StructuralKeyOrderToken>();
  const pending: Array<{
    token: StructuralKeyOrderToken;
    escapeDepth: number;
  }> = [{ token, escapeDepth: 0 }];
  const stats: StructuralKeyOrderStats = {
    nodes: 0,
    textUnits: 0,
    maxBackslashRun: 0,
    maxEscapeDepth: 0,
  };
  while (pending.length > 0) {
    const task = pending.pop();
    if (task === undefined || seen.has(task.token)) {
      continue;
    }
    const current = task.token;
    seen.add(current);
    stats.nodes += 1;
    stats.maxEscapeDepth = Math.max(
      stats.maxEscapeDepth,
      task.escapeDepth,
    );
    if (current.kind === 'raw') {
      for (const segment of current.segments) {
        if (segment.kind === 'text') {
          stats.textUnits += segment.text.length;
        } else {
          stats.maxBackslashRun = Math.max(
            stats.maxBackslashRun,
            segment.count,
          );
        }
      }
    } else if (current.kind === 'concat') {
      for (const part of current.parts) {
        pending.push({ token: part, escapeDepth: task.escapeDepth });
      }
    } else {
      pending.push({
        token: current.value,
        escapeDepth: task.escapeDepth + 1,
      });
    }
  }
  return stats;
}
