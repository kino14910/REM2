/**
 * rem2 UI kit — the single component surface for host views and future
 * plugin UI.
 *
 * Layers:
 *   - Skeleton: design tokens, theme (`data-theme`), presets and element
 *     utilities (`btn`, `input`, `card`, `badge`, `table`, …).
 *   - Bits UI: headless, accessible primitives (Dialog, DropdownMenu,
 *     RadioGroup) that the kit styles with Skeleton classes.
 *
 * Import from this barrel rather than the two packages directly, so a later
 * swap of an underlying primitive stays a one-file change.
 */

export { default as Alert } from './Alert.svelte'
export { default as Badge } from './Badge.svelte'
export { default as Button } from './Button.svelte'
export { default as Card } from './Card.svelte'
export { default as Dialog } from './Dialog.svelte'
export { default as EmptyState } from './EmptyState.svelte'
export { default as Field } from './Field.svelte'
export { default as IconButton } from './IconButton.svelte'
export { default as Menu } from './Menu.svelte'
export { default as Progress } from './Progress.svelte'
export { default as SegmentedControl } from './SegmentedControl.svelte'
export { default as Select } from './Select.svelte'
export { default as Spinner } from './Spinner.svelte'
export { default as TextField } from './TextField.svelte'

export { cn } from './cn'
export type { ClassValue } from './cn'
export type {
  AlertTone,
  BadgeTone,
  ButtonSize,
  ButtonVariant,
  CardPadding,
  DialogSize,
  MenuItem,
  SegmentOption,
  SelectOption,
} from './types'
