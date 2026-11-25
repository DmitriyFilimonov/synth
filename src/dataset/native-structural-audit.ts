/**
 * Лёгкий audit-adapter для native structural beam.
 *
 * Модуль только отделяет scalar/path/proposal diagnostics от PCM и solver
 * buffers. Он не рендерит сигнал, не меняет score и не участвует в поиске.
 */
import type {
  JointKQuadratureResult,
  JointKRankDiagnostics,
} from './joint-k-quadrature';
import type { RefitMetrics } from './quadrature-refit';
import type { StructuralBeamCompactNode } from './structural-beam';
import type { StructuralDenseWork } from './structural-work';
import { createStructuralWorkLedger } from './structural-work';
import type {
  NativeStructuralEvaluation,
  NativeStructuralNode,
  NativeStructuralProposal,
  NativeStructuralState,
} from './native-structural-beam';

/** Solver diagnostics без N-мерных raw и quantized PCM. */
export type JointKQuadratureAudit = Omit<
  JointKQuadratureResult,
  'raw' | 'samples'
>;

/** Compact evaluator audit без fixedOffset, basis и PCM. */
export interface NativeStructuralEvaluationAudit {
  proposal: NativeStructuralProposal;
  solver: JointKQuadratureAudit;
  sampleWork: NativeStructuralEvaluation['sampleWork'];
  denseWork: NativeStructuralEvaluation['denseWork'];
  canonicalWork: NativeStructuralEvaluation['canonicalWork'];
  cost: number;
}

/** Значение light node: metrics остаются в `node.score`, путь — в metadata. */
export interface NativeStructuralAuditState {
  evaluation: NativeStructuralEvaluationAudit | null;
}

/** Light native node, который нельзя передать proposer как полный parent. */
export type NativeStructuralCompactNode = StructuralBeamCompactNode<
  NativeStructuralState,
  RefitMetrics,
  NativeStructuralAuditState
>;

/**
 * Compact history сохраняет score и solver diagnostics без N-мерных arrays
 * и order tokens.
 */
export interface NativeStructuralCompactHistoryEntry {
  nodeKey: string;
  candidateKey: string;
  parentKey: string | null;
  depth: number;
  groupSize: number;
  estimatedWork: number;
  cost: number;
  metrics: RefitMetrics;
  proposal: NativeStructuralProposal;
  solver: JointKQuadratureAudit;
  sampleWork: NativeStructuralEvaluation['sampleWork'];
  denseWork: NativeStructuralEvaluation['denseWork'];
  canonicalWork: NativeStructuralEvaluation['canonicalWork'];
}

/** Клонирует только маленькие proposal shapes и slot indices. */
function compactProposal(
  proposal: NativeStructuralProposal,
): NativeStructuralProposal {
  return {
    slots: [...proposal.slots],
    shapes: proposal.shapes.map((shape) => ({ ...shape })),
  };
}

/** Клонирует rank diagnostics размера O(K), не перенося solver basis. */
function compactRankDiagnostics(
  diagnostics: JointKRankDiagnostics | null,
): JointKRankDiagnostics | null {
  if (diagnostics === null) {
    return null;
  }
  return {
    ...diagnostics,
    eigenvalues: [...diagnostics.eigenvalues],
    droppedColumns: diagnostics.droppedColumns.map((column) => ({
      ...column,
    })),
  };
}

/**
 * Убирает raw/PCM из solver result, сохраняя coefficients, fits, rank, stop,
 * rejection history и оба work ledger.
 *
 * @param solver - Полный или уже compact solver result
 * @returns Независимый compact audit без N-мерных solver buffers
 */
export function compactNativeSolver(
  solver: JointKQuadratureAudit,
): JointKQuadratureAudit {
  return {
    coefficients: [...solver.coefficients],
    fits: solver.fits.map((fit) => ({ ...fit })),
    minimumNormCoefficients:
      solver.minimumNormCoefficients === null
        ? null
        : [...solver.minimumNormCoefficients],
    quantizedPcmRss: solver.quantizedPcmRss,
    initialQuantizedPcmRss: solver.initialQuantizedPcmRss,
    rawRss: solver.rawRss,
    saturatedSamples: solver.saturatedSamples,
    diagnostics: compactRankDiagnostics(solver.diagnostics),
    stopReason: solver.stopReason,
    history: solver.history.map((iteration) => ({ ...iteration })),
    work: {
      ...solver.work,
      sampleWork: { ...solver.work.sampleWork },
      denseWork: { ...solver.work.denseWork },
    },
  };
}

/** Отделяет compact evaluator diagnostics от fixedOffset и solver buffers. */
function compactEvaluation(
  evaluation: NativeStructuralEvaluation,
): NativeStructuralEvaluationAudit {
  return {
    proposal: compactProposal(evaluation.proposal),
    solver: compactNativeSolver(evaluation.solver),
    sampleWork: { ...evaluation.sampleWork },
    denseWork: { ...evaluation.denseWork },
    canonicalWork: { ...evaluation.canonicalWork },
    cost: evaluation.cost,
  };
}

/**
 * Создаёт light native value для generic compact lifecycle.
 *
 * @param value - Полное canonical native state
 * @returns Light value только с compact evaluator diagnostics
 * @remarks Patch, rawSum, canonical PCM, contributions, fixedOffset и solver
 *   raw/PCM не копируются и не остаются доступны через скрытые ссылки.
 */
export function compactNativeStructuralValue(
  value: NativeStructuralState,
): NativeStructuralAuditState {
  return {
    evaluation:
      value.evaluation === null
        ? null
        : compactEvaluation(value.evaluation),
  };
}

/**
 * Разворачивает light evaluated nodes в компактную историю вызовов.
 *
 * @param evaluated - Light nodes в фактическом порядке evaluator
 * @returns Compact history без N-мерных arrays и order tokens
 * @throws Error если evaluated node не содержит evaluation или
 *   candidateKey
 */
export function compactNativeStructuralHistory(
  evaluated: readonly NativeStructuralCompactNode[],
): NativeStructuralCompactHistoryEntry[] {
  return evaluated.map((node) => {
    const evaluation = node.value.evaluation;
    if (evaluation === null || node.candidateKey === null) {
      throw new Error(
        'Evaluated native compact node has no evaluation audit',
      );
    }
    return {
      nodeKey: node.nodeKey,
      candidateKey: node.candidateKey,
      parentKey: node.parentKey,
      depth: node.depth,
      groupSize: node.groupSize,
      estimatedWork: node.estimatedWork,
      cost: node.cost,
      metrics: { ...node.score },
      proposal: compactProposal(evaluation.proposal),
      solver: compactNativeSolver(evaluation.solver),
      sampleWork: { ...evaluation.sampleWork },
      denseWork: { ...evaluation.denseWork },
      canonicalWork: { ...evaluation.canonicalWork },
    };
  });
}

/**
 * Суммирует dense-work полного или compact evaluated audit вне W.
 *
 * @param evaluated - Полные или light evaluated nodes одной ветви
 * @returns Суммарный dense-work всех доступных evaluations
 */
export function aggregateNativeStructuralDenseWork(
  evaluated: readonly (
    NativeStructuralNode | NativeStructuralCompactNode
  )[],
): StructuralDenseWork {
  const total = createStructuralWorkLedger().denseWork;
  const categories: (keyof StructuralDenseWork)[] = [
    'gramCellUpdates',
    'jacobiMatrixEntries',
    'jacobiOffDiagonalScans',
    'jacobiRotations',
    'jacobiRotationElementUpdates',
    'pseudoInverseEntries',
  ];
  for (const node of evaluated) {
    const work = node.value.evaluation?.denseWork;
    if (work === undefined) {
      continue;
    }
    for (const category of categories) {
      total[category] += work[category];
    }
  }
  return total;
}
