import { useEffect, useRef, useState } from 'react';

const BAND_COUNT = 48;
/** Compact size when the Live Chat drawer is docked under the composer. */
const BOTTOM_SIZE = 96;
/** Side-dock diameters as a fraction of the parent drawer (aside) width. */
const SPEAK_D_OF_DRAWER = 0.30;
const LISTEN_D_OF_DRAWER = 0.60;

/**
 * Walk up to the right-docked drawer aside and return its width.
 * @param {HTMLElement | null} el
 * @returns {number}
 */
function parentDrawerWidth(el) {
  let node = el;
  while (node) {
    if (node.getAttribute?.('aria-label') === 'Docked drawer') {
      return node.clientWidth || 0;
    }
    node = node.parentElement;
  }
  return el?.clientWidth || 0;
}

/**
 * Smooth closed path through polar sample points (midpoint quadratic loop).
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{ x: number, y: number }>} points
 */
function strokeSmoothLoop(ctx, points) {
  const n = points.length;
  if (n < 3) return;
  const mid = (i, j) => ({
    x: (points[i].x + points[j].x) * 0.5,
    y: (points[i].y + points[j].y) * 0.5,
  });
  const start = mid(n - 1, 0);
  ctx.moveTo(start.x, start.y);
  for (let i = 0; i < n; i += 1) {
    const next = (i + 1) % n;
    const m = mid(i, next);
    ctx.quadraticCurveTo(points[i].x, points[i].y, m.x, m.y);
  }
  ctx.closePath();
}

/**
 * Filled ribbon between a base circle and a smooth amplitude wave.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{
 *   cx: number,
 *   cy: number,
 *   baseR: number,
 *   bands: Float32Array | number[],
 *   amp: number,
 *   outward: boolean,
 *   innerColor: string,
 *   tipColor: string,
 *   strokeRgb: string,
 *   lineW: number,
 * }} opts
 */
function drawGradientWave(ctx, opts) {
  const {
    cx, cy, baseR, bands, amp, outward,
    innerColor, tipColor, strokeRgb, lineW,
  } = opts;
  const n = bands.length;
  if (n < 3 || amp < 0.5) return;

  /** @type {Array<{ x: number, y: number }>} */
  const wave = new Array(n);
  /** @type {Array<{ x: number, y: number }>} */
  const base = new Array(n);
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const mag = Math.min(1, Math.max(0, bands[i] ?? 0));
    peak = Math.max(peak, mag);
    const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const r = outward
      ? baseR + mag * amp
      : Math.max(2, baseR - mag * amp);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    wave[i] = { x: cx + c * r, y: cy + s * r };
    base[i] = { x: cx + c * baseR, y: cy + s * baseR };
  }
  if (peak < 0.02) {
    // Quiet: hairline guide that fades out radially.
    const quiet = ctx.createRadialGradient(cx, cy, Math.max(1, baseR - 2), cx, cy, baseR + 2);
    quiet.addColorStop(0, `rgba(${strokeRgb}, 0)`);
    quiet.addColorStop(0.55, `rgba(${strokeRgb}, 0.22)`);
    quiet.addColorStop(1, `rgba(${strokeRgb}, 0)`);
    ctx.beginPath();
    ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
    ctx.strokeStyle = quiet;
    ctx.lineWidth = Math.max(0.6, lineW * 0.35);
    ctx.stroke();
    return;
  }

  // Fill fades toward the live tip → transparent.
  const tipR = outward ? baseR + amp : Math.max(2, baseR - amp);
  const fill = ctx.createRadialGradient(
    cx,
    cy,
    outward ? baseR : tipR,
    cx,
    cy,
    outward ? tipR : baseR,
  );
  if (outward) {
    fill.addColorStop(0, innerColor);
    fill.addColorStop(0.55, tipColor);
    fill.addColorStop(1, 'rgba(0, 0, 0, 0)');
  } else {
    fill.addColorStop(0, 'rgba(0, 0, 0, 0)');
    fill.addColorStop(0.45, tipColor);
    fill.addColorStop(1, innerColor);
  }

  // Ribbon: smooth wave edge, then reverse along the base circle.
  ctx.beginPath();
  strokeSmoothLoop(ctx, wave);
  const baseRev = base.slice().reverse();
  strokeSmoothLoop(ctx, baseRev);
  ctx.fillStyle = fill;
  ctx.fill('evenodd');

  // Thin live-edge stroke, radial gradient → transparent at the tip.
  const edge = ctx.createRadialGradient(
    cx,
    cy,
    outward ? baseR : tipR,
    cx,
    cy,
    outward ? tipR : baseR,
  );
  if (outward) {
    edge.addColorStop(0, `rgba(${strokeRgb}, 0.35)`);
    edge.addColorStop(0.65, `rgba(${strokeRgb}, 0.2)`);
    edge.addColorStop(1, `rgba(${strokeRgb}, 0)`);
  } else {
    edge.addColorStop(0, `rgba(${strokeRgb}, 0)`);
    edge.addColorStop(0.35, `rgba(${strokeRgb}, 0.2)`);
    edge.addColorStop(1, `rgba(${strokeRgb}, 0.35)`);
  }
  ctx.beginPath();
  strokeSmoothLoop(ctx, wave);
  ctx.strokeStyle = edge;
  ctx.lineWidth = Math.max(0.6, lineW * 0.4);
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/**
 * Dual concentric live-audio spectrum for an open Live voice session.
 * Center shows the agent avatar; inner (red) = speaking; outer (blue) = listening.
 * Side-docked: ring diameters are 30% / 60% of the parent drawer width.
 *
 * @param {{
 *   phase: string,
 *   dock?: 'bottom' | 'right',
 *   avatarUrl?: string,
 *   getLevels: (bandCount?: number) => ({
 *     bands?: number[],
 *     rms?: number,
 *     source?: string,
 *     listen?: { bands: number[], rms: number },
 *     speak?: { bands: number[], rms: number },
 *   } | null),
 * }} props
 */
export function LiveVoiceSpectrum({ phase, getLevels, avatarUrl = '', dock = 'bottom' }) {
  const wrapRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const canvasRef = useRef(/** @type {HTMLCanvasElement|null} */ (null));
  const speakSmoothRef = useRef(new Float32Array(BAND_COUNT));
  const listenSmoothRef = useRef(new Float32Array(BAND_COUNT));
  const speakPulseRef = useRef(0);
  const listenPulseRef = useRef(0);
  const side = dock === 'right';
  /** Canvas square side (px). */
  const [size, setSize] = useState(BOTTOM_SIZE);
  /** Parent drawer width used for side-dock ring diameters (px). */
  const [drawerW, setDrawerW] = useState(BOTTOM_SIZE);

  useEffect(() => {
    if (!side) {
      setSize(BOTTOM_SIZE);
      setDrawerW(BOTTOM_SIZE);
      return undefined;
    }
    const el = wrapRef.current;
    if (!el) {
      setSize(BOTTOM_SIZE);
      setDrawerW(BOTTOM_SIZE);
      return undefined;
    }
    const apply = () => {
      // Canvas fits the padded content box (avoids horizontal drawer scroll).
      // Ring diameters still use the parent aside width (30% / 60%).
      const contentW = Math.max(120, el.clientWidth || 0);
      const drawer = Math.max(contentW, parentDrawerWidth(el));
      const nextSize = Math.max(120, Math.floor(contentW));
      setDrawerW((prev) => (prev === drawer ? prev : drawer));
      setSize((prev) => (prev === nextSize ? prev : nextSize));
    };
    apply();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(apply);
    const aside = el.closest('[aria-label="Docked drawer"]') || el;
    ro.observe(aside);
    ro.observe(el);
    return () => ro.disconnect();
  }, [side]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const half = size / 2;
    const cx = half;
    const cy = half;
    const refW = side ? drawerW : size;
    // Diameters → radii (side: 30%/60% of drawer width; bottom: same fractions of canvas).
    const speakR = refW * (side ? SPEAK_D_OF_DRAWER : 0.30) * 0.5;
    const listenR = refW * (side ? LISTEN_D_OF_DRAWER : 0.60) * 0.5;
    const gap = Math.max(4, listenR - speakR);
    const avatarR = Math.max(14, Math.min(speakR * 0.85, speakR - 2));
    // Speak wave grows outward; listen wave grows inward into the same gap.
    const speakAmp = Math.max(4, gap * 0.92);
    const listenAmp = Math.max(4, gap * 0.92);
    const lineW = Math.max(1, size / 90);

    let raf = 0;
    const tick = (now) => {
      const speaking = phase === 'speaking';
      const listening = phase === 'listening';
      const levels = typeof getLevels === 'function' ? getLevels(BAND_COUNT) : null;

      const speakBands = levels?.speak?.bands ?? (speaking ? levels?.bands : null);
      const listenBands = levels?.listen?.bands ?? (listening || !speaking ? levels?.bands : null);
      const speakRms = typeof levels?.speak?.rms === 'number'
        ? levels.speak.rms
        : (speaking && typeof levels?.rms === 'number' ? levels.rms : 0);
      const listenRms = typeof levels?.listen?.rms === 'number'
        ? levels.listen.rms
        : ((!speaking && typeof levels?.rms === 'number') ? levels.rms : 0);

      const speakAmbient = speaking ? 0.2 + 0.16 * Math.sin(now / 180) : 0.04;
      const listenAmbient = listening
        ? 0.07
        : speaking
          ? 0.03
          : 0.08 + 0.05 * Math.sin(now / 320);
      const speakDrive = Math.max(speakAmbient, Math.min(1, speakRms * 1.35));
      const listenDrive = Math.max(listenAmbient, Math.min(1, listenRms * 1.8));
      speakPulseRef.current += (speakDrive - speakPulseRef.current) * 0.28;
      listenPulseRef.current += (listenDrive - listenPulseRef.current) * 0.28;

      const speakSmooth = speakSmoothRef.current;
      const listenSmooth = listenSmoothRef.current;
      for (let i = 0; i < BAND_COUNT; i += 1) {
        const speakRaw = speakBands?.[i] ?? 0;
        const listenRaw = listenBands?.[i] ?? 0;
        // Neighbor blend so the wave reads continuous, not spiky.
        const speakPrev = speakBands?.[(i - 1 + BAND_COUNT) % BAND_COUNT] ?? speakRaw;
        const speakNext = speakBands?.[(i + 1) % BAND_COUNT] ?? speakRaw;
        const listenPrev = listenBands?.[(i - 1 + BAND_COUNT) % BAND_COUNT] ?? listenRaw;
        const listenNext = listenBands?.[(i + 1) % BAND_COUNT] ?? listenRaw;
        const speakBlended = speakRaw * 0.5 + speakPrev * 0.25 + speakNext * 0.25;
        const listenBlended = listenRaw * 0.5 + listenPrev * 0.25 + listenNext * 0.25;
        const speakTarget = Math.max(
          speakBlended,
          speaking ? speakPulseRef.current * (0.35 + 0.65 * ((i % 5) / 4)) : 0,
        );
        const listenTarget = Math.max(listenBlended, listening ? listenPulseRef.current * 0.15 : 0);
        speakSmooth[i] += (speakTarget - speakSmooth[i]) * 0.32;
        listenSmooth[i] += (listenTarget - listenSmooth[i]) * 0.32;
      }

      ctx.clearRect(0, 0, size, size);

      const energy = Math.max(speakPulseRef.current, listenPulseRef.current);
      const glow = speakR + energy * (refW * 0.08);
      const grad = ctx.createRadialGradient(cx, cy, avatarR * 0.35, cx, cy, glow + refW * 0.08);
      if (speaking) {
        grad.addColorStop(0, 'rgba(251, 113, 133, 0.4)');
        grad.addColorStop(0.55, 'rgba(244, 63, 94, 0.14)');
        grad.addColorStop(1, 'rgba(244, 63, 94, 0)');
      } else {
        grad.addColorStop(0, 'rgba(96, 165, 250, 0.32)');
        grad.addColorStop(0.55, 'rgba(59, 130, 246, 0.1)');
        grad.addColorStop(1, 'rgba(59, 130, 246, 0)');
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, glow + refW * 0.08, 0, Math.PI * 2);
      ctx.fill();

      // Soft disc behind the HTML avatar.
      ctx.beginPath();
      ctx.arc(cx, cy, avatarR + 1.5 + speakPulseRef.current * 1.4, 0, Math.PI * 2);
      ctx.fillStyle = speaking ? 'rgba(76, 5, 25, 0.95)' : 'rgba(23, 37, 84, 0.94)';
      ctx.fill();

      // Outer wave — listening / mic (blue), grows inward.
      drawGradientWave(ctx, {
        cx,
        cy,
        baseR: listenR,
        bands: listenSmooth,
        amp: listenAmp,
        outward: false,
        innerColor: 'rgba(59, 130, 246, 0.5)',
        tipColor: 'rgba(147, 197, 253, 0.28)',
        strokeRgb: '147, 197, 253',
        lineW,
      });

      // Inner wave — speaking / TTS (red), grows outward.
      drawGradientWave(ctx, {
        cx,
        cy,
        baseR: speakR,
        bands: speakSmooth,
        amp: speakAmp,
        outward: true,
        innerColor: speaking ? 'rgba(251, 113, 133, 0.28)' : 'rgba(244, 63, 94, 0.16)',
        tipColor: speaking ? 'rgba(254, 205, 211, 0.35)' : 'rgba(251, 113, 133, 0.28)',
        strokeRgb: speaking ? '254, 226, 226' : '251, 113, 133',
        lineW,
      });

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getLevels, phase, size, drawerW, side]);

  const label = phase === 'speaking'
    ? 'Live voice speaking'
    : phase === 'thinking'
      ? 'Live voice — agent working'
      : phase === 'listening'
        ? 'Live voice listening'
        : phase === 'idle'
          ? 'Live voice idle'
          : `Live voice ${phase || 'active'}`;

  const hasAvatar = typeof avatarUrl === 'string' && avatarUrl.startsWith('data:image/');
  const refW = side ? drawerW : size;
  const speakRCss = refW * (side ? SPEAK_D_OF_DRAWER : 0.30) * 0.5;
  const avatarPx = Math.max(28, Math.min(speakRCss * 0.85, speakRCss - 2) * 2);
  const avatarFont = Math.max(11, Math.round(avatarPx * 0.32));

  return (
    <div
      ref={wrapRef}
      className={
        side
          ? 'relative flex w-full max-w-full items-center justify-center overflow-x-hidden'
          : 'relative flex items-center justify-center'
      }
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
    >
      <div
        className="relative mx-auto shrink-0"
        style={{ width: size, height: size, maxWidth: '100%' }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={{ width: size, height: size }}
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 overflow-hidden rounded-full border border-rose-400/40 bg-rose-950 shadow-sm"
          style={{
            width: avatarPx,
            height: avatarPx,
            transform: 'translate(-50%, -50%)',
          }}
          aria-hidden="true"
        >
          {hasAvatar ? (
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" draggable={false} />
          ) : (
            <span
              className="flex h-full w-full items-center justify-center font-semibold tracking-wide text-rose-100/90"
              style={{ fontSize: avatarFont }}
            >
              K
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
