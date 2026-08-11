import {
  type ForwardedRef,
  forwardRef,
  type InputHTMLAttributes,
} from 'react';
import styles from './Input.module.css';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Input = forwardRef(function Input(
  { label, id, className, ...rest }: InputProps,
  ref: ForwardedRef<HTMLInputElement>,
) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');

  return (
    <label className={styles.wrapper}>
      {label && <span className={styles.label}>{label}</span>}
      <input
        ref={ref}
        id={inputId}
        className={`${styles.input} ${className ?? ''}`}
        {...rest}
      />
    </label>
  );
});
