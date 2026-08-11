import { type ChangeEvent, useState } from 'react';
import { generateWav } from '../api/generate';
import { fetchPresets } from '../api/presets';
import type {
  GenerateRequest,
  OscillatorConfig,
} from '../model/types';
import { AudioPlayer } from './AudioPlayer';
import { Button, Input, Select } from '@/shared/ui';
import styles from './GeneratorForm.module.css';

const DEFAULT_OSCILLATOR: OscillatorConfig = {
  freqBase: 440,
  freqStart: 440,
  duration: 0.5,
  slope: 0.8,
  phase: 0,
  on: true,
};

export function GeneratorForm() {
  const [mode, setMode] = useState<'preset' | 'oscillators'>(
    'preset',
  );
  const [presets, setPresets] = useState<string[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [oscillators, setOscillators] = useState<OscillatorConfig[]>([
    { ...DEFAULT_OSCILLATOR },
  ]);
  const [duration, setDuration] = useState('0.5');
  const [sampleRate, setSampleRate] = useState('44100');
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const loadPresets = async () => {
    try {
      const res = await fetchPresets();
      setPresets(res.presets);
      if (res.defaultPreset && !selectedPreset) {
        setSelectedPreset(res.defaultPreset);
      }
    } catch {
      setError('Failed to load presets');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }

    try {
      const config: GenerateRequest = {
        duration: Number(duration),
        sampleRate: Number(sampleRate),
      };

      if (mode === 'preset' && selectedPreset) {
        config.preset = selectedPreset;
      } else {
        config.oscillators = oscillators.filter((o) => o.on);
      }

      const blob = await generateWav(config);
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Generation failed',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleOscillatorChange = (
    index: number,
    field: keyof OscillatorConfig,
    value: string | boolean,
  ) => {
    setOscillators((prev) => {
      const next = [...prev];
      const item = { ...next[index]! };
      if (field === 'on') {
        item.on = value as boolean;
      } else {
        (item as Record<string, unknown>)[field] = Number(value);
      }
      next[index] = item;
      return next;
    });
  };

  const addOscillator = () => {
    setOscillators((prev) => [...prev, { ...DEFAULT_OSCILLATOR }]);
  };

  const removeOscillator = (index: number) => {
    setOscillators((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.row}>
        <Button
          type="button"
          variant="secondary"
          onClick={loadPresets}
        >
          Load presets
        </Button>
      </div>

      <div className={styles.modeToggle}>
        <label>
          <input
            type="radio"
            checked={mode === 'preset'}
            onChange={() => setMode('preset')}
          />
          Preset
        </label>
        <label>
          <input
            type="radio"
            checked={mode === 'oscillators'}
            onChange={() => setMode('oscillators')}
          />
          Oscillators
        </label>
      </div>

      {mode === 'preset' && presets.length > 0 && (
        <Select
          label="Preset"
          value={selectedPreset}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            setSelectedPreset(e.target.value)
          }
        >
          {presets.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
      )}

      {mode === 'oscillators' && (
        <div className={styles.oscillators}>
          {oscillators.map((osc, i) => (
            <div key={i} className={styles.oscillatorCard}>
              <div className={styles.oscHeader}>
                <span>Oscillator {i + 1}</span>
                {oscillators.length > 1 && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => removeOscillator(i)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <div className={styles.oscGrid}>
                <Input
                  label="freqBase"
                  type="number"
                  step="1"
                  value={osc.freqBase}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleOscillatorChange(
                      i,
                      'freqBase',
                      e.target.value,
                    )
                  }
                />
                <Input
                  label="freqStart"
                  type="number"
                  step="1"
                  value={osc.freqStart}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleOscillatorChange(
                      i,
                      'freqStart',
                      e.target.value,
                    )
                  }
                />
                <Input
                  label="duration"
                  type="number"
                  step="0.1"
                  value={osc.duration}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleOscillatorChange(
                      i,
                      'duration',
                      e.target.value,
                    )
                  }
                />
                <Input
                  label="slope"
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  value={osc.slope}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleOscillatorChange(i, 'slope', e.target.value)
                  }
                />
                <Input
                  label="phase"
                  type="number"
                  step="0.1"
                  value={osc.phase}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleOscillatorChange(i, 'phase', e.target.value)
                  }
                />
                <label className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={osc.on}
                    onChange={(e) =>
                      handleOscillatorChange(
                        i,
                        'on',
                        e.target.checked,
                      )
                    }
                  />
                  On
                </label>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={addOscillator}
          >
            + Add oscillator
          </Button>
        </div>
      )}

      <div className={styles.row}>
        <Input
          label="Duration (s)"
          type="number"
          step="0.1"
          min="0.1"
          value={duration}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            setDuration(e.target.value)
          }
        />
        <Input
          label="Sample Rate"
          type="number"
          step="1"
          value={sampleRate}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            setSampleRate(e.target.value)
          }
        />
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <Button type="submit" disabled={loading}>
        {loading ? 'Generating...' : 'Generate'}
      </Button>

      {audioUrl && <AudioPlayer url={audioUrl} />}
    </form>
  );
}
