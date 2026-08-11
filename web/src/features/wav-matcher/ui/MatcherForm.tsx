import { useState, useEffect, useRef, useCallback } from 'react';
import { createMatchJob, getJobStatus, listJobs, downloadJobResult } from '../api/matchWav';
import type { JobEntry, JobStatus, JobListEntry } from '../model/types';
import { Button, Input } from '@/shared/ui';
import styles from './MatcherForm.module.css';
import { AudioPlayer } from '@/features/synth-generator/ui/AudioPlayer';

type ViewMode = 'upload' | 'job-list';
const POLLING_INTERVAL = 10000;
const IDLE_LOCAL_STORAGE_KEY = 'synth-wav-matcher-idle';

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function MatcherForm() {
  const [file, setFile] = useState<File | null>(null);
  const [numOscillators, setNumOscillators] = useState('5');
  const [maxIterations, setMaxIterations] = useState('20');
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [uploadError, setUploadError] = useState<string>('');
  const [activeJobId, setActiveJobId] = useState<string>('');
  const [activeJob, setActiveJob] = useState<JobEntry | null>(null);
  const [jobList, setJobList] = useState<JobListEntry[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('upload');
  const pollRef = useRef<boolean>(false);

  const stopPolling = useCallback(() => {
    pollRef.current = false;
  }, []);

  const fetchJobList = async () => {
    try {
      const list = await listJobs();
      setJobList(list);
    } catch {
      // ignore
    }
  };

  const pollJob = useCallback(
    async (jobId: string) => {
      pollRef.current = true;
      while (pollRef.current) {
        try {
          const status = await getJobStatus(jobId);
          setActiveJob(status);
          await fetchJobList();

          if (status.status === 'completed') {
            stopPolling();
            try {
              const blob = await downloadJobResult(jobId);
              const url = URL.createObjectURL(blob);
              setAudioUrl(url);
            } catch {
              setError('Failed to download result');
            }
            break;
          } else if (status.status === 'failed') {
            stopPolling();
            setError(status.errorMessage ?? 'Job failed');
            break;
          }
        } catch {
          // request failed, keep trying
        }
        await sleep(POLLING_INTERVAL);
      }
    },
    [stopPolling, fetchJobList],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file) {
      setError('Please select a WAV file first');
      return;
    }

    setLoading(true);
    setError('');
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }

    try {
      const job = await createMatchJob(file, {
        numOscillators: Number(numOscillators),
        maxIterations: Number(maxIterations),
      });
      setActiveJobId(job.id);
      setActiveJob(null);
      setAudioUrl('');
      localStorage.setItem(IDLE_LOCAL_STORAGE_KEY, 'false');

      pollJob(job.id);

      setViewMode('upload');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start job');
    } finally {
      setLoading(false);
    }
  };

  const handleJobClick = async (jobId: string) => {
    setActiveJobId(jobId);
    const job = await getJobStatus(jobId);
    setActiveJob(job);

    if (job.status === 'running' || job.status === 'queued') {
      stopPolling();
      await sleep(500);
      pollJob(jobId);
    } else if (job.status === 'completed') {
      try {
        const blob = await downloadJobResult(jobId);
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
      } catch {
        // ignore
      }
    }

    setViewMode('upload');
  };

  useEffect(() => {
    fetchJobList();
    const isIdle = localStorage.getItem(IDLE_LOCAL_STORAGE_KEY) === 'true';
    const prevJobId = localStorage.getItem('synth-wav-matcher-last-job');
    if (!isIdle && prevJobId) {
      pollJob(prevJobId);
    }
    return stopPolling;
  }, [stopPolling, pollJob]);

  useEffect(() => {
    if (activeJobId) {
      localStorage.setItem('synth-wav-matcher-last-job', activeJobId);
    }
  }, [activeJobId]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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

  const getStatusLabel = (status: JobStatus): string => {
    switch (status) {
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

  const getSupressionFromJob = (job: JobEntry | null): number => {
    if (!job) return 0;
    if (job.progress.length > 0) {
      return job.progress[job.progress.length - 1]?.suppressionPercent ?? 0;
    }
    return job.suppressionPercent;
  };

  const formatTime = (iso: string): string => {
    const date = new Date(iso);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  if (viewMode === 'job-list') {
    return (
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <Button
            variant={viewMode === 'upload' ? 'primary' : 'secondary'}
            onClick={() => setViewMode('upload')}
          >
            New Match
          </Button>
          <Button
            variant={viewMode === 'job-list' ? 'primary' : 'secondary'}
            onClick={() => {
              setViewMode('job-list');
              fetchJobList();
            }}
          >
            Jobs ({jobList.length})
          </Button>
        </div>
        <div className={styles.jobList}>
          {jobList.length === 0 && <div>No jobs yet</div>}
          {jobList.map((job) => (
            <div
              key={job.id}
              className={styles.jobCard}
              onClick={() => handleJobClick(job.id)}
            >
              <div className={styles.jobHeader}>
                <span className={styles.jobId}>{job.id.slice(0, 8)}</span>
                <span
                  className={`${styles.jobStatus} ${styles[job.status]}`}
                >
                  {getStatusLabel(job.status)}
                </span>
              </div>
              <div className={styles.jobMeta}>
                Osc: {job.params.numOscillators}, Iters: {job.params.maxIterations}
              </div>
              <div className={styles.jobMeta}>
                Suppression: {job.suppressionPercent.toFixed(2)}%
              </div>
              <div className={styles.jobTime}>
                {formatTime(job.createdAt)}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Button
          variant={viewMode === 'upload' ? 'primary' : 'secondary'}
          onClick={() => setViewMode('upload')}
        >
          New Match
        </Button>
        <Button
          variant={viewMode === 'job-list' ? 'primary' : 'secondary'}
          onClick={() => {
            setViewMode('job-list');
            fetchJobList();
          }}
        >
          Jobs ({jobList.length})
        </Button>
      </div>

      <form className={styles.form} onSubmit={handleSubmit}>
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
          {uploadError && <div className={styles.error}>{uploadError}</div>}
          {file && (
            <div className={styles.fileInfo}>
              {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </div>
          )}
        </div>

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

        {error && <div className={styles.error}>{error}</div>}

        <Button type="submit" disabled={loading || !file}>
          {loading ? 'Starting...' : 'Match Parameters'}
        </Button>

        {activeJobId && activeJob && (
          <div className={styles.progressSection}>
            <div className={styles.progressHeader}>
              <span>Job: {activeJobId.slice(0, 8)}</span>
              <span className={`${styles.jobStatus} ${styles[activeJob.status]}`}>
                {getStatusLabel(activeJob.status)}
              </span>
            </div>
            <div className={styles.suppressionValue}>
              Current: {getSupressionFromJob(activeJob).toFixed(2)}%
            </div>
            {activeJob.progress.length > 0 && (
              <div className={styles.miniChart}>
                {activeJob.progress.map((entry, idx) => {
                  const maxSup = Math.max(...activeJob.progress.map(p => Math.max(0, p.suppressionPercent)));
                  const height = maxSup > 0 ? (Math.max(0, entry.suppressionPercent) / maxSup) * 40 : 0;
                  return (
                    <div
                      key={idx}
                      className={styles.chartBar}
                      style={{ height: `${Math.max(1, height)}px` }}
                      title={`${entry.iteration}: ${entry.suppressionPercent.toFixed(2)}%`}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {audioUrl && <AudioPlayer url={audioUrl} />}
      </form>
    </div>
  );
}
