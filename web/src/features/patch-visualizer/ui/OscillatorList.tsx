import type { ActiveOscillator } from '../model/types';
import styles from './PatchVisualizer.module.css';

interface OscillatorListProps {
  oscillators: ActiveOscillator[];
  selectedIndices: ReadonlySet<number>;
  disabled: boolean;
  onToggle: (index: number) => void;
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

export function OscillatorList({
  oscillators,
  selectedIndices,
  disabled,
  onToggle,
}: OscillatorListProps) {
  return (
    <div className={styles.oscillatorList}>
      {oscillators.map(({ index, parameters }) => {
        const selected = selectedIndices.has(index);
        return (
          <label
            key={index}
            className={`${styles.oscillator} ${
              selected ? styles.selected : ''
            }`}
          >
            <input
              type="checkbox"
              checked={selected}
              disabled={disabled}
              aria-label={`Select oscillator ${index + 1}`}
              onChange={() => onToggle(index)}
            />
            <span className={styles.oscillatorNumber}>
              #{index + 1}
            </span>
            <span className={styles.parameters}>
              <span className={styles.parameter}>
                <span className={styles.parameterLabel}>Start</span>
                <span className={styles.parameterValue}>
                  {formatNumber(parameters.freqStart)} Hz
                </span>
              </span>
              <span className={styles.parameter}>
                <span className={styles.parameterLabel}>Base</span>
                <span className={styles.parameterValue}>
                  {formatNumber(parameters.freqBase)} Hz
                </span>
              </span>
              <span className={styles.parameter}>
                <span className={styles.parameterLabel}>
                  Duration
                </span>
                <span className={styles.parameterValue}>
                  {formatNumber(parameters.duration * 1000)} ms
                </span>
              </span>
              <span className={styles.parameter}>
                <span className={styles.parameterLabel}>Slope</span>
                <span className={styles.parameterValue}>
                  {formatNumber(parameters.slope)}
                </span>
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
