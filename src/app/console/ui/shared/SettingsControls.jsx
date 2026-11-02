/**
 * Form controls every Settings panel shares.
 *
 * A Field commits when it LOSES FOCUS, not on a submit: typing into a settings
 * field is the whole gesture here, and blurring (or pressing Enter, which blurs
 * on the user's behalf) is the only moment the typed value is definitely final.
 * Nothing is written while the field still holds focus, so a half-typed value
 * can never reach the server. State itself stays with the panel — these controls
 * only route the committed value through onCommit.
 */
export function Field({ label, hint, value, disabled, placeholder, onCommit, type = 'text', resetKey }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-gray-300">{label}</span>
      <input
        type={type}
        defaultValue={value}
        key={`${label}:${resetKey ?? value}`}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onBlur={(e) => {
          const next = e.target.value;
          if (next !== value) onCommit?.(next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-1.5 font-mono text-sm text-gray-100 placeholder:text-gray-600 disabled:opacity-50"
      />
      {hint ? <span className="mt-1 block text-xs text-gray-500">{hint}</span> : null}
    </label>
  );
}

export function Choice({ active, disabled, onClick, label }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
          : 'border-gray-700 bg-gray-950 text-gray-400 hover:border-gray-600 hover:text-gray-200'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {label}
    </button>
  );
}
