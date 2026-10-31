export function readJsonSet(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

export function writeJsonSet(key, set) {
  localStorage.setItem(key, JSON.stringify([...set]));
}

export function readLocal(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
