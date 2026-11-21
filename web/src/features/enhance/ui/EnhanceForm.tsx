import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createEnhanceJob,
  getEnhanceJob,
  listEnhanceJobs,
} from '../api/enhance';
import type {
  EnhanceJobEntry,
  EnhanceJobListEntry,
} from '../model/types';
import { Button, Input } from '@/shared/ui';
import { EnhanceJobCard } from './EnhanceJobCard';
import styles from './EnhanceForm.module.css';

const POLLING_INTERVAL = 1000;

/**
 * Форма улучшения бочки: выбирает WAV, силу улучшения и (опционально)
 * параметры прогона, создаёт задание и следит за очередью. Активные
 * задания опрашивает каждую секунду, детали завершённых читает один
 * раз и кладёт в кеш.
 */
export function EnhanceForm() {
  const [file, setFile] = useState<File | null>(null);
  const [strength, setStrength] = useState('0.5');
  const [maxIterations, setMaxIterations] = useState('');
  const [seed, setSeed] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [jobs, setJobs] = useState<EnhanceJobListEntry[]>([]);
  const [details, setDetails] = useState<
    Record<string, EnhanceJobEntry>
  >({});

  const pollRef = useRef(false);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Реф держит кеш деталей для цикла опроса (state там устарел бы),
  // setDetails лишь триггерит ререндер с теми же данными.
  const detailsRef = useRef<Record<string, EnhanceJobEntry>>({});

  const refreshDetails = useCallback(
    async (list: EnhanceJobListEntry[]) => {
      // Активные задания опрашиваем каждый цикл ради прогресса,
      // завершённые и упавшие — пока не попадут в кеш. Кеш снятый
      // с работающего задания обновляем при смене статуса: аудит
      // и финальные числа пишутся в самом конце, иначе карточка
      // навсегда показывала бы пустой журнал со словами
      // «трансформации не применились».
      const targets = list.filter((job) => {
        if (job.status === 'running' || job.status === 'queued') {
          return true;
        }
        const cached = detailsRef.current[job.id];
        if (cached === undefined) {
          return true;
        }
        return cached.status !== job.status;
      });
      if (targets.length === 0) return;

      const entries = await Promise.all(
        targets.map(async (job) => {
          try {
            return await getEnhanceJob(job.id);
          } catch {
            return null;
          }
        }),
      );
      let changed = false;
      for (const entry of entries) {
        if (entry === null) continue;
        detailsRef.current[entry.id] = entry;
        changed = true;
      }
      if (changed) setDetails({ ...detailsRef.current });
    },
    [],
  );

  const stopPolling = useCallback(() => {
    pollRef.current = false;
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = true;

    const doPoll = async () => {
      if (!pollRef.current) return;
      try {
        const list = await listEnhanceJobs();
        if (!pollRef.current) return;
        setJobs(list);
        await refreshDetails(list);
        const stillActive = list.some(
          (job) =>
            job.status === 'running' || job.status === 'queued',
        );
        if (stillActive && pollRef.current) {
          pollTimeoutRef.current = setTimeout(
            doPoll,
            POLLING_INTERVAL,
          );
        }
      } catch {
        if (pollRef.current) {
          pollTimeoutRef.current = setTimeout(
            doPoll,
            POLLING_INTERVAL,
          );
        }
      }
    };

    void doPoll();
  }, [refreshDetails]);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  const handleFileChange = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const selected = e.target.files?.[0];
    if (!selected) {
      setFile(null);
      setUploadError('');
      return;
    }
    if (!selected.name.toLowerCase().endsWith('.wav')) {
      setUploadError('Выберите WAV-файл');
      setFile(null);
      return;
    }
    setFile(selected);
    setUploadError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file) {
      setError('Сначала выберите WAV-файл');
      return;
    }

    const strengthValue = Number(strength);
    if (
      !Number.isFinite(strengthValue) ||
      strengthValue < 0 ||
      strengthValue > 1
    ) {
      setError('Сила улучшения должна быть числом от 0 до 1');
      return;
    }

    const iterationsValue =
      maxIterations.trim() === '' ? undefined : Number(maxIterations);
    if (
      iterationsValue !== undefined &&
      (!Number.isFinite(iterationsValue) || iterationsValue < 1)
    ) {
      setError('Число итераций должно быть положительным');
      return;
    }

    const seedValue = seed.trim() === '' ? undefined : Number(seed);
    if (seedValue !== undefined && !Number.isFinite(seedValue)) {
      setError('Сид должен быть числом');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await createEnhanceJob(file, {
        enhancementStrength: strengthValue,
        maxIterations: iterationsValue,
        seed: seedValue,
      });
      // Перезапускаем опрос, чтобы новое задание появилось сразу.
      stopPolling();
      startPolling();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Не удалось создать задание',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.sectionTitle}>Исходник</div>
        <div className={styles.uploadSection}>
          <label className={styles.fileLabel}>
            <input
              type="file"
              accept=".wav"
              onChange={handleFileChange}
              className={styles.fileInput}
            />
            {file ? file.name : 'Выберите WAV-файл...'}
          </label>
          {uploadError && (
            <div className={styles.error}>{uploadError}</div>
          )}
          {file && (
            <div className={styles.fileInfo}>
              {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </div>
          )}
        </div>

        <div className={styles.sectionTitle}>Улучшение</div>
        <div className={styles.fieldGroup}>
          <span className={styles.fieldLabel}>Сила улучшения</span>
          <div className={styles.strengthRow}>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={strength}
              onChange={(e) => setStrength(e.target.value)}
              className={styles.slider}
            />
            <span className={styles.strengthValue}>
              {Number(strength).toFixed(2)}
            </span>
          </div>
          <span className={styles.hint}>
            0 — не менять патч после match, 1 — полностью к приорам
          </span>
        </div>

        <details className={styles.advanced}>
          <summary className={styles.advancedSummary}>
            Дополнительно
          </summary>
          <div className={styles.advancedBody}>
            <Input
              label="Итерации"
              title="Бюджет оптимизации match-стадии; пусто — дефолт бэкенда (100)"
              type="number"
              min="1"
              step="1"
              placeholder="100"
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
            />
            <Input
              label="Сид"
              title="Сид ГПСЧ оптимизатора; пусто — дефолтный сид"
              type="number"
              step="1"
              placeholder="по умолчанию"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
            />
          </div>
        </details>

        {error && <div className={styles.error}>{error}</div>}

        <Button type="submit" disabled={loading || !file}>
          {loading ? 'Запускаю...' : 'Улучшить'}
        </Button>
      </form>

      <div className={styles.listSection}>
        <div className={styles.sectionTitle}>
          Задания ({jobs.length})
        </div>
        {jobs.length === 0 ? (
          <div className={styles.emptyState}>Заданий пока нет</div>
        ) : (
          <div className={styles.jobList}>
            {jobs.map((job) => (
              <EnhanceJobCard
                key={job.id}
                job={job}
                detail={details[job.id]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
