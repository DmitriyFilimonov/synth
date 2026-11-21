import { useState } from 'react';
import type {
  EnhanceJobEntry,
  EnhanceJobListEntry,
  JobStatus,
} from '../model/types';
import { downloadEnhanceResult } from '../api/enhance';
import { AudioPlayer, Button } from '@/shared/ui';
import styles from './EnhanceJobCard.module.css';

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'В очереди',
  running: 'В работе',
  completed: 'Готово',
  failed: 'Ошибка',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '–'
    : `${value.toFixed(2)}%`;
}

/**
 * Карточка enhance-задания: статус, прогресс оптимизации, по
 * завершении — плеер, числа match/enhance и журнал трансформаций.
 */
export function EnhanceJobCard({
  job,
  detail,
}: {
  job: EnhanceJobListEntry;
  detail?: EnhanceJobEntry;
}) {
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState('');

  const progress = detail?.progress ?? [];
  // Доводка продолжает историю за чертой maxIterations: общий
  // бюджет — match плюс доводка.
  const totalIterations = Math.max(
    job.params.maxIterations + (job.params.refineIterations ?? 0),
    1,
  );
  const lastIteration =
    progress.length > 0
      ? (progress[progress.length - 1]?.iteration ?? progress.length)
      : 0;
  const progressPercent =
    job.status === 'completed'
      ? 100
      : Math.min(100, (lastIteration / totalIterations) * 100);
  const currentSuppression =
    progress.length > 0
      ? (progress[progress.length - 1]?.suppressionPercent ??
        job.suppressionPercent)
      : job.suppressionPercent;

  const matchGlobal =
    detail?.globalSuppressionPercent ?? job.globalSuppressionPercent;
  const enhanceGlobal = detail?.enhanceGlobalSuppressionPercent;
  const audit = detail?.enhanceAudit ?? [];

  const downloadBase = (job.name?.trim() || job.id.slice(0, 8)).replace(
    /[\\/:*?"<>|]/g,
    '_',
  );

  const handlePlay = async () => {
    setAudioLoading(true);
    setAudioError('');
    try {
      const blob = await downloadEnhanceResult(job.id);
      setAudioUrl(URL.createObjectURL(blob));
    } catch {
      setAudioError('Не удалось загрузить результат');
    } finally {
      setAudioLoading(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.name}>
          {job.name ?? job.id.slice(0, 8).toUpperCase()}
        </span>
        <span className={`${styles.status} ${styles[job.status]}`}>
          {STATUS_LABELS[job.status]}
        </span>
      </div>

      <div className={styles.meta}>
        сила {job.params.enhancementStrength?.toFixed(2) ?? '–'} ·
        итераций {job.params.maxIterations} · {formatTime(job.createdAt)}
      </div>

      {(job.status === 'running' || job.status === 'queued') && (
        <div className={styles.progressRow}>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className={styles.progressText}>
            {lastIteration}/{totalIterations} ·{' '}
            {currentSuppression.toFixed(2)}%
          </span>
        </div>
      )}

      {job.status === 'failed' && (
        <div className={styles.error}>
          {detail?.errorMessage ?? 'Задание завершилось с ошибкой'}
        </div>
      )}

      {job.status === 'completed' && (
        <>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Match global</span>
              <span className={styles.statValue}>
                {formatPercent(matchGlobal)}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Enhance global</span>
              <span className={styles.statValue}>
                {formatPercent(enhanceGlobal)}
              </span>
            </div>
          </div>

          {audioUrl ? (
            <AudioPlayer
              url={audioUrl}
              downloadName={`${downloadBase}_enhanced.wav`}
            />
          ) : (
            <div className={styles.actions}>
              <Button onClick={handlePlay} disabled={audioLoading}>
                {audioLoading ? 'Загрузка…' : 'Слушать результат'}
              </Button>
            </div>
          )}

          {detail && audit.length > 0 && (
            <div className={styles.audit}>
              <div className={styles.auditTitle}>
                Журнал улучшения · {audit.length}
              </div>
              <ul className={styles.auditList}>
                {audit.map((entry, index) => (
                  <li key={index} className={styles.auditItem}>
                    <span className={styles.auditName}>
                      {entry.name}
                      {entry.oscillatorIndex !== undefined &&
                        ` · osc ${entry.oscillatorIndex}`}
                    </span>
                    <span className={styles.auditDetail}>
                      {entry.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail && audit.length === 0 && (
            <div className={styles.auditEmpty}>
              Трансформации не применились — улучшенный патч совпадает
              с match
            </div>
          )}
        </>
      )}

      {audioError && <div className={styles.error}>{audioError}</div>}
    </div>
  );
}
