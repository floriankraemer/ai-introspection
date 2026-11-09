export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'introspect.theme';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Sets `data-theme` on <html>; "system" removes it so the prefers-color-scheme rule applies. */
export function applyThemePref(pref: ThemePref): void {
  if (pref === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', pref);
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable (private mode): the choice just will not persist */
  }
}
