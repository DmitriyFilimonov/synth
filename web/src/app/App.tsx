import { GeneratorForm } from '@/features/synth-generator';
import { MatcherForm } from '@/features/wav-matcher';
import styles from './App.module.css';

export function App() {
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
        <MatcherForm />
      </section>

      <footer className={styles.footer}>
        <span>synth</span>
      </footer>
    </main>
  );
}
