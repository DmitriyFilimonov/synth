import { useEffect } from 'react';
import styles from './AudioPlayer.module.css';

interface AudioPlayerProps {
  url: string;
  downloadName?: string;
}

export function AudioPlayer({
  url,
  downloadName = 'generated.wav',
}: AudioPlayerProps) {
  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return (
    <div className={styles.wrapper}>
      <audio controls src={url} className={styles.audio} />
      <a
        download={downloadName}
        href={url}
        className={styles.download}
      >
        Download
      </a>
    </div>
  );
}
