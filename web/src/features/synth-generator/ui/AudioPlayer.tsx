import { useEffect } from 'react';
import styles from './GeneratorForm.module.css';

interface AudioPlayerProps {
  url: string;
}

export function AudioPlayer({ url }: AudioPlayerProps) {
  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return (
    <div className={styles.player}>
      <audio controls src={url} />
      <a download="generated.wav" href={url}>
        Download
      </a>
    </div>
  );
}
