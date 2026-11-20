/** Read installed copies' preferences when the current name has no saved value yet. */
export function readPreference(key: string): string | null {
  return localStorage.getItem(`masterdeck.${key}`) ?? localStorage.getItem(`hubdeck.${key}`);
}

export function writePreference(key: string, value: string): void {
  localStorage.setItem(`masterdeck.${key}`, value);
}
