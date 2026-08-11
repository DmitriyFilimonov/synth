import {
  type ButtonHTMLAttributes,
  type ForwardedRef,
  forwardRef,
} from 'react';
import styles from './Button.module.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export const Button = forwardRef(function Button(
  { variant = 'primary', className, ...rest }: ButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
) {
  return (
    <button
      ref={ref}
      className={`${styles.button} ${styles[variant]} ${className ?? ''}`}
      {...rest}
    />
  );
});
