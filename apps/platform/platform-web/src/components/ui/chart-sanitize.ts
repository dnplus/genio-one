export function sanitizeCssString(str: string): string {
  return str.replace(/</g, "\\3c ")
}
