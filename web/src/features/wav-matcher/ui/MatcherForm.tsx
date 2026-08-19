import { useState, useRef, useCallback, useEffect } from 'react';
import {
  createMatchJob,
  getJobStatus,
  listJobs,
  downloadJobResult,
  downloadJobParams,
} from '../api/matchWav';
import type {
  JobEntry,
  JobStatus,
  JobListEntry,
} from '../model/types';
import { AudioPlayer, Button, Input } from '@/shared/ui';
import styles from './MatcherForm.module.css';

const CHART_COLOR_LINE = '#3b82f6';
const CHART_COLOR_GRID = '#2a2a2a';
const CHART_COLOR_AXIS = '#555555';
const CHART_COLOR_STAGE = '#f59e0b';

type ViewMode = 'upload' | 'list' | 'detail';
const POLLING_INTERVAL = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function OptimizationChart({
  progress,
  height = 120,
}: {
  progress: {
    iteration: number;
    suppressionPercent: number;
    phase?: 'hpo' | 'cd';
    stageIndex?: number;
  }[];
  height?: number;
}) {
  if (progress.length < 2) return null;

  const padding = { top: 10, right: 10, bottom: 24, left: 40 };
  const width = 560;
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxSup = Math.max(
    ...progress.map((p) => p.suppressionPercent),
    0.01,
  );

  const lastIter = progress[progress.length - 1]?.iteration ?? 0;
  const firstIter = progress[0]?.iteration ?? 1;
  const iterRange = Math.max(lastIter - firstIter, 1);

  const x = (iter: number) =>
    padding.left + ((iter - firstIter) / iterRange) * chartW;
  const y = (sup: number) =>
    padding.top + chartH - (sup / maxSup) * chartH;

  const ticksY = [0, 0.25, 0.5, 0.75, 1].map((f) => maxSup * f);

  // Separate HPO and CD entries for different visual rendering
  const cdEntries = progress.filter((p) => p.phase !== 'hpo');
  const hpoEntries = progress.filter((p) => p.phase === 'hpo');

  const cdPathD = cdEntries
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${x(p.iteration).toFixed(1)} ${y(p.suppressionPercent).toFixed(1)}`,
    )
    .join(' ');

  const hasStages = progress.some((p) => p.stageIndex !== undefined);
  const stageBoundaries: number[] = [];
  if (hasStages) {
    const seenStages = new Set<number>();
    for (const p of progress) {
      const si = p.stageIndex;
      if (si !== undefined && !seenStages.has(si)) {
        seenStages.add(si);
        stageBoundaries.push(p.iteration);
      }
    }
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={styles.chart}>
      {ticksY.map((v, i) => (
        <g key={i}>
          <line
            x1={padding.left}
            y1={y(v)}
            x2={width - padding.right}
            y2={y(v)}
            stroke={CHART_COLOR_GRID}
            strokeDasharray={v === 0 ? undefined : '2 4'}
          />
          <text
            x={padding.left - 4}
            y={y(v) + 3}
            textAnchor="end"
            fontSize="10"
            fill={CHART_COLOR_AXIS}
          >
            {v.toFixed(1)}%
          </text>
        </g>
      ))}
      {stageBoundaries.map((iter, i) => {
        if (i === 0) return null;
        return (
          <line
            key={i}
            x1={x(iter)}
            y1={padding.top}
            x2={x(iter)}
            y2={padding.top + chartH}
            stroke={CHART_COLOR_STAGE}
            strokeDasharray="3 3"
            strokeWidth="1"
          />
        );
      })}
      {hpoEntries.length > 0 && (
        <g>
          {hpoEntries.map((p, i) => (
            <circle
              key={i}
              cx={x(p.iteration)}
              cy={y(p.suppressionPercent)}
              r="2"
              fill="#ef4444"
              opacity="0.6"
            />
          ))}
        </g>
      )}
      {cdPathD && (
        <path
          d={cdPathD}
          fill="none"
          stroke={CHART_COLOR_LINE}
          strokeWidth="2"
        />
      )}
      <text
        x={width / 2}
        y={height - 4}
        textAnchor="middle"
        fontSize="10"
        fill={CHART_COLOR_AXIS}
      >
        Iteration ({firstIter}–{lastIter})
      </text>
    </svg>
  );
}

function JobDetail({
  jobId,
  onBack,
}: {
  jobId: string;
  onBack: () => void;
}) {
  const [job, setJob] = useState<JobEntry | null>(null);
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [error, setError] = useState<string>('');
  const pollRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const fetchJob = async () => {
      try {
        const status = await getJobStatus(jobId);
        if (cancelled) return;
        setJob(status);

        if (
          status.status === 'queued' ||
          status.status === 'running'
        ) {
          pollRef.current = true;
          await sleep(POLLING_INTERVAL);
          if (pollRef.current && !cancelled) {
            await fetchJob();
          }
        }
      } catch {
        if (!cancelled) {
          setError('Failed to fetch job status');
        }
      }
    };

    pollRef.current = true;
    void fetchJob();

    return () => {
      cancelled = true;
      pollRef.current = false;
    };
  }, [jobId]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const handleDownloadResult = async () => {
    try {
      const blob = await downloadJobResult(jobId);
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
    } catch {
      setError('Failed to download result');
    }
  };

  const handleDownloadParams = async () => {
    try {
      const blob = await downloadJobParams(jobId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `synth_params_${jobId.slice(0, 8)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setError('Failed to download params');
    }
  };

  const getStatusLabel = (s: JobStatus): string => {
    switch (s) {
      case 'queued':
        return 'Queued';
      case 'running':
        return 'Running';
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
    }
  };

  const currentSup = (() => {
    if (!job) return 0;
    if (job.progress.length > 0) {
      return (
        job.progress[job.progress.length - 1]?.suppressionPercent ??
        job.suppressionPercent
      );
    }
    return job.suppressionPercent;
  })();

  const stageInfo = (() => {
    if (!job || job.progress.length === 0) return null;
    const last = job.progress[job.progress.length - 1];
    if (!last || last.stageIndex === undefined) return null;
    return {
      current: last.stageIndex + 1,
      total: last.totalStages ?? 0,
      durationMs: last.stageDurationMs ?? 0,
      phase: last.phase ?? 'cd',
    };
  })();

  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <div>
          <h3 className={styles.detailTitle}>
            {job?.name ?? `JOB: ${jobId.slice(0, 12).toUpperCase()}`}
          </h3>
          <div className={styles.detailMeta}>
            OSC: {job?.params.numOscillators ?? '–'} · IT:{' '}
            {job?.params.maxIterations ?? '–'} ·{' '}
            {job?.createdAt
              ? new Date(job.createdAt).toLocaleString()
              : '–'}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'center',
          }}
        >
          {job && (
            <span
              className={`${styles.jobStatus} ${styles[job.status]}`}
            >
              {getStatusLabel(job.status)}
            </span>
          )}
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>

      <div className={styles.suppressionValue}>
        {currentSup.toFixed(2)}%
      </div>

      {job?.status === 'completed' &&
        job.globalSuppressionPercent != null && (
          <div className={styles.detailMeta}>
            GLOBAL (RMS): {job.globalSuppressionPercent.toFixed(2)}% —
            честное подавление по всему сигналу; число выше —
            surrogate J из оптимизации (занижен)
          </div>
        )}

      {stageInfo &&
        (job?.status === 'running' || job?.status === 'queued') && (
          <div className={styles.stageInfo}>
            <span className={styles.stageLabel}>
              STAGE {stageInfo.current}/{stageInfo.total}
            </span>
            <span
              className={styles.phaseBadge}
              style={{
                background:
                  stageInfo.phase === 'hpo'
                    ? '#991b1b55'
                    : '#1e3a5f55',
                color:
                  stageInfo.phase === 'hpo' ? '#ef4444' : '#3b82f6',
              }}
            >
              {stageInfo.phase === 'hpo'
                ? `HPO`
                : `CD ${job.params.maxIterations}it`}
            </span>
            <span className={styles.stageDuration}>
              {stageInfo.durationMs}ms
            </span>
            <div className={styles.stageProgressBar}>
              <div
                className={styles.stageProgressFill}
                style={{
                  width: `${(stageInfo.current / stageInfo.total) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

      {job && job.progress.length > 0 && (
        <OptimizationChart progress={job.progress} />
      )}

      {job?.status === 'failed' && job.errorMessage && (
        <div className={styles.error}>{job.errorMessage}</div>
      )}

      {job?.status === 'completed' && !audioUrl && (
        <div className={styles.resultActions}>
          <Button onClick={handleDownloadResult}>Download WAV</Button>
          <Button onClick={handleDownloadParams}>
            Download JSON
          </Button>
        </div>
      )}

      {audioUrl && (
        <>
          <AudioPlayer url={audioUrl} />
          <div className={styles.resultActions}>
            <Button onClick={handleDownloadParams}>
              Download JSON
            </Button>
          </div>
        </>
      )}

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

function JobListCard({
  job,
  onOpen,
}: {
  job: JobListEntry;
  onOpen: (id: string) => void;
}) {
  const getStatusLabel = (s: JobStatus): string => {
    switch (s) {
      case 'queued':
        return 'Queued';
      case 'running':
        return 'Running';
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
    }
  };

  const formatTime = (iso: string): string => {
    const date = new Date(iso);
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className={styles.jobCard} onClick={() => onOpen(job.id)}>
      <div className={styles.jobHeader}>
        <span className={styles.jobId}>
          {job.name ?? job.id.slice(0, 8).toUpperCase()}
        </span>
        <span className={`${styles.jobStatus} ${styles[job.status]}`}>
          {getStatusLabel(job.status)}
        </span>
      </div>
      <div className={styles.jobMeta}>
        OSC: {job.params.numOscillators} · IT:{' '}
        {job.params.maxIterations}
      </div>
      <div className={styles.jobSuppression}>
        Suppression: {job.suppressionPercent.toFixed(2)}%
        {job.globalSuppressionPercent != null &&
          ` (global: ${job.globalSuppressionPercent.toFixed(2)}%)`}
      </div>
      <div className={styles.jobTime}>
        {formatTime(job.createdAt)}
      </div>
    </div>
  );
}

export function MatcherForm() {
  const [file, setFile] = useState<File | null>(null);
  const [numOscillators, setNumOscillators] = useState('5');
  const [maxIterations, setMaxIterations] = useState('20');
  const [hpo, setHpo] = useState(true);
  const [staged, setStaged] = useState(true);
  const [stageDurationMultiplier, setStageDurationMultiplier] =
    useState('1');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [uploadError, setUploadError] = useState<string>('');
  const [viewMode, setViewMode] = useState<ViewMode>('upload');
  const [jobList, setJobList] = useState<JobListEntry[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(
    null,
  );

  const pollRef = useRef(false);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const startListPolling = useCallback(() => {
    pollRef.current = true;

    const doPoll = async () => {
      if (!pollRef.current) return;
      try {
        const list = await listJobs();
        setJobList(list);

        const stillRunning = list.some(
          (j) => j.status === 'running' || j.status === 'queued',
        );
        if (stillRunning && pollRef.current) {
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
  }, []);

  const stopListPolling = useCallback(() => {
    pollRef.current = false;
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (viewMode === 'list') {
      startListPolling();
    } else {
      stopListPolling();
    }

    return () => {
      stopListPolling();
    };
  }, [viewMode, startListPolling, stopListPolling]);

  useEffect(() => {
    return () => {
      stopListPolling();
    };
  }, [stopListPolling]);

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
      setUploadError('Please select a WAV file');
      setFile(null);
      return;
    }
    setFile(selected);
    setUploadError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file) {
      setError('Please select a WAV file first');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await createMatchJob(file, {
        numOscillators: Number(numOscillators),
        maxIterations: Number(maxIterations),
        hpo,
        stageDurationMultiplier: staged
          ? Number(stageDurationMultiplier)
          : undefined,
        staged,
      });

      await listJobs().then(setJobList);
      setSelectedJobId(null);
      setViewMode('list');
      startListPolling();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to start job',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleJobOpen = (id: string) => {
    setSelectedJobId(id);
    setViewMode('detail');
    stopListPolling();
  };

  const handleBack = () => {
    setSelectedJobId(null);
    setViewMode('list');
    startListPolling();
  };

  const handleShowList = async () => {
    setViewMode('list');
    try {
      const list = await listJobs();
      setJobList(list);
    } catch {
      // ignore
    }
  };

  const handleNewMatch = () => {
    setViewMode('upload');
    setError('');
    setUploadError('');
  };

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <Button
          variant={viewMode === 'upload' ? 'primary' : 'secondary'}
          onClick={handleNewMatch}
        >
          New Match
        </Button>
        <Button
          variant={viewMode === 'list' ? 'primary' : 'secondary'}
          onClick={handleShowList}
        >
          Jobs ({jobList.length})
        </Button>
      </div>

      {viewMode === 'detail' && selectedJobId ? (
        <JobDetail jobId={selectedJobId} onBack={handleBack} />
      ) : viewMode === 'list' ? (
        <div className={styles.jobList}>
          {jobList.length === 0 ? (
            <div className={styles.emptyState}>No jobs yet</div>
          ) : (
            jobList.map((job) => (
              <JobListCard
                key={job.id}
                job={job}
                onOpen={handleJobOpen}
              />
            ))
          )}
        </div>
      ) : (
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.sectionTitle}>Input</div>
          <div className={styles.uploadSection}>
            <label className={styles.fileLabel}>
              <input
                type="file"
                accept=".wav"
                onChange={handleFileChange}
                className={styles.fileInput}
              />
              {file ? file.name : 'Choose a WAV file...'}
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

          <div className={styles.sectionTitle}>Parameters</div>
          <div className={styles.row}>
            <Input
              label="Oscillators"
              type="number"
              min="1"
              max="50"
              step="1"
              value={numOscillators}
              onChange={(e) => setNumOscillators(e.target.value)}
            />
            <Input
              label="Max iterations"
              type="number"
              min="1"
              step="1"
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={staged}
                onChange={(e) => setStaged(e.target.checked)}
                className={styles.checkbox}
              />
              Staged optimization
            </label>
          </div>
          <div className={styles.row}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={hpo}
                onChange={(e) => setHpo(e.target.checked)}
                className={styles.checkbox}
              />
              Hyperparameter optimization (HPO)
            </label>
          </div>
          {staged && (
            <div className={styles.row}>
              <Input
                label="Stage multiplier"
                type="number"
                min="1"
                step="0.5"
                value={stageDurationMultiplier}
                onChange={(e) =>
                  setStageDurationMultiplier(e.target.value)
                }
              />
            </div>
          )}

          {error && <div className={styles.error}>{error}</div>}

          <Button type="submit" disabled={loading || !file}>
            {loading ? 'Starting...' : 'Match Parameters'}
          </Button>
        </form>
      )}
    </div>
  );
}
