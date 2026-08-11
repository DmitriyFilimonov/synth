import { type ForwardedRef, forwardRef, type SelectHTMLAttributes } from 'react';
import styles from './Select.module.css';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
}

export const Select = forwardRef(function Select(
  { label, id, className, children, ...rest }: SelectProps,
  ref: ForwardedRef<HTMLSelectElement>,
) {
  const selectId = id ?? label?.toLowerCase().replace(/\s+/g, '-');

  return (
    <label className={styles.wrapper}>
      {label && <span className={styles.label}>{label}</span>}
      <select
        ref={ref}
        id={selectId}
        className={`${styles.select} ${className ?? ''}`}
        {...rest}
      >
        {children}
      </select>
    </label>
  );
});
