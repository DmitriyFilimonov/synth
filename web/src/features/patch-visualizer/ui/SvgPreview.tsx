import type { RenderedSvg } from '../model/types';
import styles from './PatchVisualizer.module.css';

interface SvgPreviewProps {
  rendered: RenderedSvg;
  patchName: string;
}

export function SvgPreview({ rendered, patchName }: SvgPreviewProps) {
  return (
    <div className={styles.preview}>
      <div className={styles.previewHeader}>
        <h3 className={styles.previewTitle}>Preview</h3>
        <a
          href={rendered.url}
          download={rendered.fileName}
          className={styles.download}
        >
          Download SVG
        </a>
      </div>
      <div className={styles.previewFrame}>
        <img
          src={rendered.url}
          alt={`Frequency envelopes for ${patchName}`}
          className={styles.previewImage}
        />
      </div>
    </div>
  );
}
