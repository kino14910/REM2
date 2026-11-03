/**
 * Rem2 UI kit — static class maps.
 *
 * Tailwind extracts classes from source text, so every class used by the kit
 * must be spelled out here (never composed at runtime).
 */

import type {
  AlertTone,
  BadgeTone,
  ButtonSize,
  ButtonVariant,
  CardPadding,
  DialogSize,
} from './types'

export const buttonVariantClasses: Record<ButtonVariant, string> = {
  primary: 'preset-filled-brand',
  secondary: 'preset-filled-surface-200-800',
  tonal: 'preset-tonal',
  ghost: 'bg-transparent hover:preset-tonal',
  danger: 'preset-filled-error-500',
  link: 'bg-transparent text-primary-500 underline underline-offset-2 hover:text-primary-400',
}

export const buttonSizeClasses: Record<ButtonSize, string> = {
  sm: 'btn-sm',
  base: 'btn-base',
  lg: 'btn-lg',
}

export const iconButtonVariantClasses: Record<
  Exclude<ButtonVariant, 'link'>,
  string
> = {
  primary: 'preset-filled-brand',
  secondary: 'preset-filled-surface-200-800',
  tonal: 'preset-tonal',
  ghost: 'text-surface-600-400 hover:preset-tonal hover:text-surface-950-50',
  danger: 'preset-filled-error-500',
}

export const iconButtonSizeClasses: Record<ButtonSize, string> = {
  sm: 'btn-icon-sm',
  base: 'btn-icon-base',
  lg: 'btn-icon-lg',
}

export const badgeToneClasses: Record<BadgeTone, string> = {
  neutral: 'preset-tonal',
  brand: 'preset-tonal-brand',
  success: 'preset-tonal-success',
  warning: 'preset-tonal-warning',
  error: 'preset-tonal-error',
}

export const alertToneClasses: Record<AlertTone, string> = {
  info: 'preset-tonal',
  success: 'preset-tonal-success',
  warning: 'preset-tonal-warning',
  error: 'preset-tonal-error',
}

export const cardPaddingClasses: Record<CardPadding, string> = {
  none: '',
  sm: 'p-2',
  md: 'p-4',
  lg: 'p-6',
}

export const dialogSizeClasses: Record<DialogSize, string> = {
  sm: 'w-[min(28rem,calc(100vw-2rem))]',
  md: 'w-[min(40rem,calc(100vw-2rem))]',
  lg: 'w-[min(56rem,calc(100vw-2rem))]',
}

/** Shared surface for elevated containers (cards, dialogs, menus). */
export const surfaceClasses =
  'border border-surface-200-800 bg-surface-100-900 text-surface-950-50'
