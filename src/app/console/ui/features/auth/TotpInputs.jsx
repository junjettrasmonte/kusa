import { useEffect, useRef, useState } from 'react';

const BOXES = 6;

/** Controlled 6-digit TOTP inputs without page chrome. */
export function TotpInputs({ onComplete, busy, autoFocus = true }) {
  const [digits, setDigits] = useState(() => Array(BOXES).fill(''));
  const refs = useRef([]);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  function emitIfFull(next) {
    const code = next.join('');
    if (code.length === BOXES && next.every(Boolean)) onComplete?.(code);
  }

  function handleChange(index, event) {
    const raw = event.target.value.replace(/\D/g, '');
    if (!raw) {
      const next = [...digits];
      next[index] = '';
      setDigits(next);
      return;
    }
    if (raw.length > 1) {
      const chars = raw.slice(0, BOXES - index).split('');
      const next = [...digits];
      chars.forEach((ch, offset) => {
        next[index + offset] = ch;
      });
      setDigits(next);
      refs.current[Math.min(index + chars.length, BOXES - 1)]?.focus();
      emitIfFull(next);
      return;
    }
    const next = [...digits];
    next[index] = raw;
    setDigits(next);
    if (index < BOXES - 1) refs.current[index + 1]?.focus();
    emitIfFull(next);
  }

  function handleKeyDown(index, event) {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      event.preventDefault();
      const next = [...digits];
      next[index - 1] = '';
      setDigits(next);
      refs.current[index - 1]?.focus();
    }
  }

  function handlePaste(event) {
    const text = event.clipboardData?.getData('text') || '';
    const chars = text.replace(/\D/g, '').slice(0, BOXES).split('');
    if (!chars.length) return;
    event.preventDefault();
    const next = Array(BOXES).fill('');
    chars.forEach((ch, i) => {
      next[i] = ch;
    });
    setDigits(next);
    refs.current[Math.min(chars.length, BOXES) - 1]?.focus();
    emitIfFull(next);
  }

  return (
    <div className="flex justify-center gap-2" onPaste={handlePaste}>
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={6}
          value={digit}
          disabled={busy}
          aria-label={`Digit ${index + 1}`}
          onChange={(event) => handleChange(index, event)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          className="h-12 w-10 rounded-lg border border-gray-700 bg-gray-950 text-center text-lg font-semibold text-gray-100 outline-none focus:border-emerald-500 disabled:opacity-50"
        />
      ))}
    </div>
  );
}
