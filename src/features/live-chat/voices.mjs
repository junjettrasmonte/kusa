/**
 * Curated Piper / Kokoro voice catalogs for Live Chat settings.
 * Gender is derived from the voice id conventions each engine uses.
 */

export const LIVE_CHAT_GENDERS = ['any', 'female', 'male'];
export const LIVE_CHAT_EXPRESSIVENESS = ['calm', 'balanced', 'expressive'];

/** Expressiveness → Kokoro speed multiplier (Piper ignores speed). */
export const EXPRESSIVENESS_SPEED = {
  calm: 0.85,
  balanced: 1.0,
  expressive: 1.25,
};

export const PIPER_VOICES = [
  { id: 'en_US-lessac-medium', label: 'Lessac (US)', gender: 'female' },
  { id: 'en_US-amy-medium', label: 'Amy (US)', gender: 'female' },
  { id: 'en_US-libritts-high', label: 'LibriTTS (US)', gender: 'female' },
  { id: 'en_GB-alba-medium', label: 'Alba (GB)', gender: 'female' },
  { id: 'en_US-ryan-high', label: 'Ryan (US)', gender: 'male' },
  { id: 'en_US-joe-medium', label: 'Joe (US)', gender: 'male' },
  { id: 'en_US-danny-low', label: 'Danny (US)', gender: 'male' },
  { id: 'en_GB-northern_english_male-medium', label: 'Northern (GB)', gender: 'male' },
];

/** Kokoro voice ids: 2nd char is f=female / m=male. */
export const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart', gender: 'female' },
  { id: 'af_bella', label: 'Bella', gender: 'female' },
  { id: 'af_nicole', label: 'Nicole', gender: 'female' },
  { id: 'af_sarah', label: 'Sarah', gender: 'female' },
  { id: 'af_sky', label: 'Sky', gender: 'female' },
  { id: 'bf_emma', label: 'Emma (GB)', gender: 'female' },
  { id: 'bf_isabella', label: 'Isabella (GB)', gender: 'female' },
  { id: 'am_adam', label: 'Adam', gender: 'male' },
  { id: 'am_michael', label: 'Michael', gender: 'male' },
  { id: 'am_fenrir', label: 'Fenrir', gender: 'male' },
  { id: 'am_puck', label: 'Puck', gender: 'male' },
  { id: 'bm_george', label: 'George (GB)', gender: 'male' },
  { id: 'bm_lewis', label: 'Lewis (GB)', gender: 'male' },
];

export function normalizeLiveChatGender(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return LIVE_CHAT_GENDERS.includes(v) ? v : 'any';
}

export function normalizeLiveChatExpressiveness(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return LIVE_CHAT_EXPRESSIVENESS.includes(v) ? v : 'balanced';
}

export function voicesForEngine(tts) {
  // Browser-native voice defaults to Kokoro; Piper catalog kept for legacy prefs.
  if (tts === 'piper') return PIPER_VOICES;
  return KOKORO_VOICES;
}

export function filterVoicesByGender(voices, gender) {
  const g = normalizeLiveChatGender(gender);
  if (g === 'any') return voices;
  return voices.filter((v) => v.gender === g);
}

/**
 * Pick a concrete voice id for the engine + gender preference.
 * Keeps `preferred` when it still matches the gender filter.
 */
export function resolveVoiceId(tts, { gender = 'any', preferred = '' } = {}) {
  const catalog = voicesForEngine(tts);
  const filtered = filterVoicesByGender(catalog, gender);
  const pool = filtered.length ? filtered : catalog;
  const want = String(preferred || '').trim();
  // Prefer English Kokoro voices (a*/b*); never keep a zh/ja/… id as preferred.
  if (tts !== 'piper') {
    const englishPool = pool.filter((v) => /^[ab]/i.test(v.id));
    const englishCatalog = catalog.filter((v) => /^[ab]/i.test(v.id));
    const enPool = englishPool.length ? englishPool : (englishCatalog.length ? englishCatalog : pool);
    if (want && enPool.some((v) => v.id === want)) return want;
    return enPool[0]?.id || 'af_heart';
  }
  if (want && pool.some((v) => v.id === want)) return want;
  if (want && catalog.some((v) => v.id === want) && normalizeLiveChatGender(gender) === 'any') {
    return want;
  }
  return pool[0]?.id || 'en_US-lessac-medium';
}

export function expressivenessSpeed(expressiveness) {
  const key = normalizeLiveChatExpressiveness(expressiveness);
  return EXPRESSIVENESS_SPEED[key] ?? 1.0;
}
