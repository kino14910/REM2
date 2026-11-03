/**
 * Join conditional class names.
 *
 * No merging/overriding: Skeleton utilities are additive, and components put
 * their own classes first so a caller's `class` can win only where both use the
 * same property.
 */
export type ClassValue = string | false | null | undefined

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ')
}
