import { useEffect } from 'react';
import styles from './AudioPlayer.module.css';

interface AudioPlayerProps {
  url: string;
}

export function AudioPlayer({ url }: AudioPlayerProps) {
  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return (
    <div className={styles.wrapper}>
      <audio controls src={url} className={styles.audio} />
      <a
        download="generated.wav"
        href={url}
        className={styles.download}
      >
        Download
      </a>
    </div>
  );
}
