/**
 * Joins class names, skipping falsy values.
 * Convention: a component's `className` prop is for layout (margins, width, grid placement), not
 * for overriding its variant styles; use the variant props for that.
 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
