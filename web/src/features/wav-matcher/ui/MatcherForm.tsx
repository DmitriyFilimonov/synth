import { useState } from 'react';
import { matchWav } from '../api/matchWav';
import { Button, Input } from '@/shared/ui';
import styles from './MatcherForm.module.css';
import { AudioPlayer } from '@/features/synth-generator/ui/AudioPlayer';

export function MatcherForm() {
  const [file, setFile] = useState<File | null>(null);
  const [numOscillators, setNumOscillators] = useState('5');
  const [maxIterations, setMaxIterations] = useState('20');
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [uploadError, setUploadError] = useState<string>('');

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
      const blob = await matchWav(file, {
        numOscillators: Number(numOscillators),
        maxIterations: Number(maxIterations),
      });
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Match failed');
    } finally {
      setLoading(false);
    }
  };

  return (
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
        {loading ? 'Matching...' : 'Match Parameters'}
      </Button>

      {audioUrl && <AudioPlayer url={audioUrl} />}
    </form>
  );
}
