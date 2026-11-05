import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button, Input } from '@/shared/ui';
import { fetchFrequencyEnvelopesSvg } from '../api/visualizationApi';
import {
  createSvgFileName,
  getActiveOscillators,
  getPatchBaseName,
  parsePatchJson,
  validatePatch,
} from '../model/patch';
import type {
  PatchVisualizerSource,
  RenderedSvg,
} from '../model/types';
import { OscillatorList } from './OscillatorList';
import styles from './PatchVisualizer.module.css';
import { SvgPreview } from './SvgPreview';

export interface PatchVisualizerProps {
  source?: PatchVisualizerSource | null;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Standalone and externally supplied frequency-envelope visualizer. */
export function PatchVisualizer({ source }: PatchVisualizerProps) {
  const [patchSource, setPatchSource] =
    useState<PatchVisualizerSource | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<
    ReadonlySet<number>
  >(new Set());
  const [renderedSvg, setRenderedSvg] = useState<RenderedSvg | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const requestVersionRef = useRef(0);

  const activeOscillators = useMemo(
    () =>
      patchSource ? getActiveOscillators(patchSource.patch) : [],
    [patchSource],
  );

  const resetPatch = useCallback(() => {
    requestVersionRef.current += 1;
    setPatchSource(null);
    setSelectedIndices(new Set());
    setRenderedSvg(null);
    setError(null);
    setIsRendering(false);
  }, []);

  const loadSource = useCallback(
    (nextSource: { name: string; patch: unknown }) => {
      resetPatch();
      try {
        const patch = validatePatch(nextSource.patch);
        setPatchSource({
          name: getPatchBaseName(nextSource.name),
          patch,
        });
        setSelectedIndices(
          new Set(
            getActiveOscillators(patch).map(({ index }) => index),
          ),
        );
      } catch (loadError) {
        setError(
          getErrorMessage(loadError, 'Could not load the patch.'),
        );
      }
    },
    [resetPatch],
  );

  useEffect(() => {
    if (source) {
      loadSource(source);
    }
  }, [loadSource, source]);

  useEffect(() => {
    const url = renderedSvg?.url;
    return () => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [renderedSvg]);

  useEffect(() => {
    return () => {
      requestVersionRef.current += 1;
    };
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = '';
      if (!file) {
        return;
      }

      resetPatch();
      const loadVersion = requestVersionRef.current;

      if (!/\.json$/i.test(file.name)) {
        setError('Select a .json patch file.');
        return;
      }

      try {
        const text = await file.text();
        if (loadVersion !== requestVersionRef.current) {
          return;
        }
        loadSource({
          name: file.name,
          patch: parsePatchJson(text),
        });
      } catch (loadError) {
        if (loadVersion !== requestVersionRef.current) {
          return;
        }
        resetPatch();
        setError(
          getErrorMessage(
            loadError,
            'Could not read the patch file.',
          ),
        );
      }
    },
    [loadSource, resetPatch],
  );

  const handleToggle = useCallback((index: number) => {
    setSelectedIndices((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
    setError(null);
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIndices(
      new Set(activeOscillators.map(({ index }) => index)),
    );
    setError(null);
  }, [activeOscillators]);

  const handleClear = useCallback(() => {
    setSelectedIndices(new Set());
    setError(null);
  }, []);

  const handleRender = useCallback(async () => {
    if (!patchSource) {
      setError('Load a patch before rendering.');
      return;
    }

    const oscillatorIndices = activeOscillators
      .filter(({ index }) => selectedIndices.has(index))
      .map(({ index }) => index);
    if (oscillatorIndices.length === 0) {
      setError('Select at least one active oscillator.');
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    setIsRendering(true);
    setError(null);
    setRenderedSvg(null);

    try {
      const blob = await fetchFrequencyEnvelopesSvg(
        patchSource.patch,
        oscillatorIndices,
      );
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      setRenderedSvg({
        blob,
        url: URL.createObjectURL(blob),
        fileName: createSvgFileName(patchSource.name),
      });
    } catch (renderError) {
      if (requestVersion === requestVersionRef.current) {
        setError(
          getErrorMessage(
            renderError,
            'Could not render frequency envelopes.',
          ),
        );
      }
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setIsRendering(false);
      }
    }
  }, [activeOscillators, patchSource, selectedIndices]);

  return (
    <div className={styles.container}>
      <div className={styles.uploadRow}>
        <Input
          type="file"
          label="Patch JSON"
          accept=".json,application/json"
          onChange={handleFileChange}
        />
        {patchSource && (
          <p className={styles.patchName}>
            <span>Loaded patch</span>
            <strong>{patchSource.name}</strong>
          </p>
        )}
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {!patchSource && !error && (
        <p className={styles.hint}>
          Load an ArgCreateSynth JSON patch to select active
          oscillators.
        </p>
      )}

      {patchSource && (
        <>
          <div className={styles.selectionToolbar}>
            <p className={styles.selectionStatus}>
              {activeOscillators.length} active ·{' '}
              {selectedIndices.size} selected
            </p>
            <div className={styles.selectionActions}>
              <Button
                type="button"
                variant="secondary"
                disabled={
                  activeOscillators.length === 0 || isRendering
                }
                onClick={handleSelectAll}
              >
                Select all
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={
                  activeOscillators.length === 0 || isRendering
                }
                onClick={handleClear}
              >
                Clear
              </Button>
            </div>
          </div>

          {activeOscillators.length > 0 ? (
            <OscillatorList
              oscillators={activeOscillators}
              selectedIndices={selectedIndices}
              disabled={isRendering}
              onToggle={handleToggle}
            />
          ) : (
            <p className={styles.empty}>
              This patch has no active oscillators.
            </p>
          )}

          <div className={styles.renderActions}>
            <Button
              type="button"
              disabled={activeOscillators.length === 0 || isRendering}
              onClick={handleRender}
            >
              {isRendering ? 'Rendering…' : 'Render'}
            </Button>
          </div>
        </>
      )}

      {renderedSvg && patchSource && (
        <SvgPreview
          rendered={renderedSvg}
          patchName={patchSource.name}
        />
      )}
    </div>
  );
}
