import { useCallback, useState } from 'react';
import {
  PatchVisualizer,
  type PatchVisualizerSource,
} from '@/features/patch-visualizer';
import { GeneratorForm } from '@/features/synth-generator';
import { MatcherForm } from '@/features/wav-matcher';
import styles from './App.module.css';

export function App() {
  const [visualizerSource, setVisualizerSource] =
    useState<PatchVisualizerSource | null>(null);

  const handleVisualize = useCallback(
    (patch: PatchVisualizerSource['patch'], name: string) => {
      setVisualizerSource({ name, patch });
      document.getElementById('visualize')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    },
    [],
  );

  return (
    <main className={styles.layout}>
      <header className={styles.header}>
        <h1 className={styles.logo}>SYNTH</h1>
        <div className={styles.headerDivider} />
        <p className={styles.headerSub}>
          Additive Synthesizer · 44 100 Hz / 16-bit
        </p>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Generate</h2>
        <GeneratorForm />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Match</h2>
        <MatcherForm onVisualize={handleVisualize} />
      </section>

      <section id="visualize" className={styles.section}>
        <h2 className={styles.sectionTitle}>Visualize</h2>
        <PatchVisualizer source={visualizerSource} />
      </section>

      <footer className={styles.footer}>
        <span>synth</span>
      </footer>
    </main>
  );
}
