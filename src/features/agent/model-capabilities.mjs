/**
 * What a model id tells us about the request body it accepts.
 *
 * OpenAI-compatible endpoints expose no capability field — `GET /models` lists
 * ids only — so vision support is a name judgement, and it is deliberately
 * three-valued:
 *
 *   true   a known multimodal family — images are sent as image_url parts
 *   false  a known text-only family  — images are replaced by a named note
 *   null   nothing recognised        — send the image and let the endpoint
 *                                     answer; a model that truly cannot see
 *                                     images replies with its own error, which
 *                                     is more honest than dropping the picture
 *                                     behind the user's back.
 *
 * The judgement is kept in one place so the composer (which warns before the
 * prompt is sent) and the loop (which decides what to encode) can never
 * disagree about the same model.
 */
export function supportsVision(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return null;

  // Text-only families. Checked first: "gpt-4o-mini" is multimodal while
  // "o3-mini" is not, so a suffix alone cannot decide anything.
  const textOnly = [
    'gpt-3.5',
    'gpt-2',
    'text-davinci',
    'text-babbage',
    'text-ada',
    'code-davinci',
    'code-babbage',
    'code-cushman',
    'embedding',
    'moderation',
    'whisper',
    'tts-',
    'o1-mini',
    'o3-mini',
    'gpt-4.1-mini',
    'llama-2',
    'llama2',
    'codellama',
    'code-llama',
    'phi-2',
    'deepseek-chat',
    'deepseek-reasoner',
    'deepseek-r1',
    'qwq',
  ];
  if (textOnly.some((needle) => id.includes(needle))) return false;

  // Multimodal families.
  const multimodal = [
    'vision',
    '-vl',
    'vl-',
    'vl.',
    'multimodal',
    'gpt-4o',
    'gpt-4.1',
    'gpt-4.5',
    'chatgpt',
    'gemini',
    'claude',
    'sonet',
    'opus',
    'haiku',
    'llava',
    'moondream',
    'internvl',
    'pixtral',
    'jumbo',
    'nova',
    'omni',
  ];
  if (multimodal.some((needle) => id.includes(needle))) return true;

  // Qwen's chat line is multimodal, its coder line is not — the `vl` marker
  // above already caught the former, so the rest falls through as unknown.
  return null;
}

/**
 * One-line label for the model picker, so the composer can say what a picture
 * would do under this model before the user attaches one.
 * @param {string} model
 * @returns {string} '' when nothing is known
 */
export function visionLabel(model) {
  const supported = supportsVision(model);
  if (supported === true) return 'sees images';
  if (supported === false) return 'text only — images are not sent';
  return '';
}
