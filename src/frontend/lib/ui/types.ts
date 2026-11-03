/**
 * Rem2 UI kit — shared types.
 *
 * Kept in a plain `.ts` module so components can import types without
 * `.svelte`-to-`.svelte` type imports (tsc does not parse Svelte sources).
 */

import type { Snippet } from 'svelte'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'tonal'
  | 'ghost'
  | 'danger'
  | 'link'

export type ButtonSize = 'sm' | 'base' | 'lg'

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'error'

export type AlertTone = 'info' | 'success' | 'warning' | 'error'

export type CardPadding = 'none' | 'sm' | 'md' | 'lg'

/** Size of a dialog surface (sm ≈ 28rem, md ≈ 40rem, lg ≈ 56rem). */
export type DialogSize = 'sm' | 'md' | 'lg'

export interface SelectOption {
  value: string
  label: string
}

export interface SegmentOption {
  value: string
  label: string
  /** Optional icon; when present the label becomes the accessible name only. */
  icon?: Snippet
}

export interface MenuItem {
  label: string
  /** Optional right-aligned annotation, e.g. a count. */
  detail?: string
  disabled?: boolean
  onSelect: () => void
}
