import { GeneratorForm } from '@/features/synth-generator';
import { MatcherForm } from '@/features/wav-matcher';

export function App() {
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ marginBottom: 24 }}>Synth</h1>
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ marginBottom: 16 }}>Generate</h2>
        <GeneratorForm />
      </section>
      <section>
        <h2 style={{ marginBottom: 16 }}>Match</h2>
        <MatcherForm />
      </section>
    </main>
  );
}
