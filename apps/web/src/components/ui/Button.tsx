import type { ButtonHTMLAttributes } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

/**
 * A native <button> with YMT styling. It accepts every normal button
 * attribute (onClick, aria-label, disabled...) through `...rest`.
 * `type` defaults to "button" so it never submits a form by accident.
 */
export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn--${variant} ${className}`.trim()}
      {...rest}
    />
  )
}
