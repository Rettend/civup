import type { PresetWind4Theme } from 'unocss'
import fs from 'node:fs/promises'
import { defineConfig, presetIcons, presetWind4 } from 'unocss'
import { minify } from './src/client/lib/css'

export default defineConfig({
  presets: [
    presetWind4({
      preflights: {
        reset: true,
      },
    }),
    presetIcons({
      extraProperties: {
        'display': 'inline-block',
        'vertical-align': 'middle',
      },
      collections: {
        custom: {
          'number-ten-bold': () => fs.readFile('./src/assets/number-ten-bold.svg', 'utf-8'),
          'number-eleven-bold': () => fs.readFile('./src/assets/number-eleven-bold.svg', 'utf-8'),
          'number-twelve-bold': () => fs.readFile('./src/assets/number-twelve-bold.svg', 'utf-8'),
        },
      },
    }),
  ],
  theme: {
    font: {
      sans: '\'Inter Variable\', system-ui, -apple-system, sans-serif',
      mono: '\'JetBrains Mono\', \'Fira Code\', monospace',
    },
    colors: {
      // ── Background ───────────────────────────────────────
      bg: {
        DEFAULT: 'var(--bg)',
        subtle: 'var(--bg-subtle)',
        muted: 'var(--bg-muted)',
        elevated: 'var(--bg-elevated)',
      },
      // ── Foreground / Text ───────────────────────────────
      fg: {
        DEFAULT: 'var(--fg)',
        muted: 'var(--fg-muted)',
        subtle: 'var(--fg-subtle)',
      },
      // ── Border ────────────────────────────────────────────
      border: {
        DEFAULT: 'var(--border)',
        subtle: 'var(--border-subtle)',
        hover: 'var(--border-hover)',
      },
      // ── Accent: Gold ──────────────────────────────────────
      accent: {
        DEFAULT: 'var(--accent)',
        muted: 'var(--accent-muted)',
        subtle: 'var(--accent-subtle)',
      },
      // ── Danger / Ban ──────────────────────────────────────
      danger: {
        DEFAULT: 'var(--danger)',
        muted: 'var(--danger-muted)',
        subtle: 'var(--danger-subtle)',
      },
      // ── Info / Teal ───────────────────────────────────────
      info: {
        DEFAULT: 'var(--info)',
        muted: 'var(--info-muted)',
      },
      // ── Note / Sky ────────────────────────────────────────
      note: {
        DEFAULT: 'var(--note)',
        muted: 'var(--note-muted)',
      },
    },
    animation: {
      keyframes: {
        'fade-in': '{from { opacity: 0 } to { opacity: 1 }}',
        'slide-up': '{from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: translateY(0) }}',
        'slide-right': '{from { opacity: 0; transform: translateX(12px) } to { opacity: 1; transform: translateX(0) }}',
        'scale-in': '{from { opacity: 0; transform: scale(1.02) } to { opacity: 1; transform: scale(1) }}',
        'phase-flash': '{from { opacity: 0.35 } to { opacity: 0 }}',
        'glow-breathe': '{0%, 100% { opacity: 0.2 } 50% { opacity: 0.05 }}',
        'glow-fade-out': '{from { opacity: 0.2 } to { opacity: 0 }}',
      },
      durations: {
        'fade-in': '200ms',
        'slide-up': '250ms',
        'slide-right': '200ms',
        'scale-in': '300ms',
        'phase-flash': '200ms',
        'glow-breathe': '3s',
        'glow-fade-out': '400ms',
      },
      timingFns: {
        'fade-in': 'ease-out',
        'slide-up': 'ease-out',
        'slide-right': 'ease-out',
        'scale-in': 'ease-out',
        'phase-flash': 'ease-out',
        'glow-breathe': 'ease-in-out',
        'glow-fade-out': 'ease-out',
      },
      counts: {
        'glow-breathe': 'infinite',
      },
    },
  } satisfies PresetWind4Theme,
  shortcuts: {
    'text-heading': 'font-bold uppercase tracking-wider',
    'focus-ring': 'outline-none focus-visible:(ring-2 ring-accent/50 ring-offset-2 ring-offset-bg)',
    'panel-glow': 'shadow-[0_0_20px_var(--accent-subtle),0_0_40px_var(--accent-subtle),inset_0_1px_0_var(--accent-muted)]',
  },
  rules: [
    ['animate-fill-both', { 'animation-fill-mode': 'both' }],
    ['animate-fill-forwards', { 'animation-fill-mode': 'forwards' }],
  ],
  safelist: [
    'i-ph:number-one-bold',
    'i-ph:number-two-bold',
    'i-ph:number-three-bold',
    'i-ph:number-four-bold',
    'i-ph:number-five-bold',
    'i-ph:number-six-bold',
    'i-ph:number-seven-bold',
    'i-ph:number-eight-bold',
    'i-ph:number-nine-bold',
    'i-custom:number-ten-bold',
    'i-custom:number-eleven-bold',
    'i-custom:number-twelve-bold',
  ],
  preflights: [
    {
      getCSS: () => {
        return minify`
          :root {
            --bg:           #09090b;
            --bg-subtle:    #161619;
            --bg-muted:     #18181b;
            --bg-elevated:  #1e1e22;

            --fg:           #fafafa;
            --fg-muted:     #a1a1aa;
            --fg-subtle:    #71717a;

            --border:        rgba(255, 255, 255, 0.14);
            --border-subtle: rgba(255, 255, 255, 0.08);
            --border-hover:  rgba(255, 255, 255, 0.22);

            --accent:        #c8aa6e;
            --accent-muted:  rgba(200, 170, 110, 0.25);
            --accent-subtle: rgba(200, 170, 110, 0.08);

            --danger:        #e84057;
            --danger-muted:  rgba(232, 64, 87, 0.25);
            --danger-subtle: rgba(232, 64, 87, 0.08);

            --info:          #0ac8b9;
            --info-muted:    rgba(10, 200, 185, 0.25);

            --note:          #38bdf8;
            --note-muted:    rgba(56, 189, 248, 0.25);

            --phase-ban-bg:  #1a0a0e;
            --phase-pick-bg: var(--bg-subtle);

            --glow-gold:     rgba(200, 170, 110, 0.55);
            --glow-gold-dim: rgba(200, 170, 110, 0.14);
            --glow-red:      rgba(232, 64, 87, 0.30);
            --glow-red-dim:  rgba(232, 64, 87, 0.14);

            --badge-gold-border: rgba(244, 220, 168, 0.45);
            --badge-gold-text:   #17130d;

            --slot-glow: var(--accent);
          }

          html,
          body,
          #root {
            overflow-x: hidden;
          }

          body {
            font-family: 'Inter Variable', sans-serif;
            background: var(--bg);
            color: var(--fg);
            user-select: auto;
            -webkit-user-select: auto;
          }

          body.activity-surface {
            user-select: none;
            -webkit-user-select: none;
          }

          body.civup-ui-scaled {
            width: calc(100vw / var(--civup-ui-scale));
          }

          body.civup-ui-scaled .civup-ui-scale-panel {
            transform: scale(var(--civup-ui-scale-inverse));
            transform-origin: top right;
          }

          body.civup-ui-scaled .civup-ui-scale-panel.is-position-locked {
            transform-origin: top left;
          }

          body.civup-ui-scaled .h-screen {
            height: calc(100vh / var(--civup-ui-scale));
          }

          body.civup-ui-scaled .min-h-screen {
            min-height: calc(100vh / var(--civup-ui-scale));
          }

          body.civup-ui-scaled .h-dvh {
            height: calc(100dvh / var(--civup-ui-scale));
          }

          body.civup-ui-scaled .min-h-dvh {
            min-height: calc(100dvh / var(--civup-ui-scale));
          }

          @media (min-width: 64rem) {
            body.civup-ui-scaled .lg\:h-dvh {
              height: calc(100dvh / var(--civup-ui-scale));
            }
          }

          body.activity-surface img {
            -webkit-user-drag: none;
            user-drag: none;
            user-select: none;
            -webkit-user-select: none;
          }

          @media (prefers-reduced-motion: reduce) {
            body.public-surface *,
            body.public-surface *::before,
            body.public-surface *::after {
              scroll-behavior: auto !important;
              transition-duration: 0.01ms !important;
              animation-duration: 0.01ms !important;
              animation-iteration-count: 1 !important;
            }
          }

          button:disabled,
          input:disabled,
          select:disabled,
          textarea:disabled {
            cursor: default !important;
          }

          .civup-icon-summary {
            list-style: none;
          }

          .civup-icon-summary::-webkit-details-marker {
            display: none;
          }

          .civup-slider {
            -webkit-appearance: none;
            appearance: none;
            height: 6px;
            border-radius: 3px;
            background: linear-gradient(
              to right,
              var(--accent) 0%,
              var(--accent) var(--civup-slider-progress, 0%),
              var(--border-subtle) var(--civup-slider-progress, 0%),
              var(--border-subtle) 100%
            );
            outline: none;
            cursor: pointer;
            transition: background 80ms ease;
          }

          .civup-slider:hover {
            background: linear-gradient(
              to right,
              var(--accent) 0%,
              var(--accent) var(--civup-slider-progress, 0%),
              var(--border) var(--civup-slider-progress, 0%),
              var(--border) 100%
            );
          }

          .civup-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: var(--accent);
            border: 2px solid var(--bg-subtle);
            box-shadow: 0 0 6px var(--accent-muted), 0 1px 3px rgba(0, 0, 0, 0.4);
            cursor: pointer;
            transition: transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 150ms ease;
          }

          .civup-slider::-webkit-slider-thumb:hover {
            transform: scale(1.15);
            box-shadow: 0 0 10px var(--accent-muted), 0 0 20px var(--accent-subtle), 0 1px 4px rgba(0, 0, 0, 0.5);
          }

          .civup-slider:active::-webkit-slider-thumb {
            transform: scale(1.05);
            box-shadow: 0 0 12px var(--accent-muted), 0 0 24px var(--accent-subtle);
          }

          .civup-slider::-moz-range-thumb {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: var(--accent);
            border: 2px solid var(--bg-subtle);
            box-shadow: 0 0 6px var(--accent-muted), 0 1px 3px rgba(0, 0, 0, 0.4);
            cursor: pointer;
            transition: transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 150ms ease;
          }

          .civup-slider::-moz-range-thumb:hover {
            transform: scale(1.15);
            box-shadow: 0 0 10px var(--accent-muted), 0 0 20px var(--accent-subtle), 0 1px 4px rgba(0, 0, 0, 0.5);
          }

          .civup-slider::-moz-range-track {
            height: 6px;
            border-radius: 3px;
            background: transparent;
          }

          .civup-slider::-moz-range-progress {
            height: 6px;
            border-radius: 3px 0 0 3px;
            background: var(--accent);
          }

          ::-webkit-scrollbar { width: 4px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { background: var(--fg-subtle); border-radius: 2px; }
          ::-webkit-scrollbar-thumb:hover { background: var(--fg-muted); }

          /* TODO: remove these and use theme animations */
          @keyframes civup-fade-in {
            from { opacity: 0; }
            to { opacity: 1; }
          }

          @keyframes civup-slide-up-fade {
            from { opacity: 0; transform: translateY(12px); }
            to { opacity: 1; transform: translateY(0); }
          }

          @keyframes civup-slide-right-fade {
            from { opacity: 0; transform: translateX(12px); }
            to { opacity: 1; transform: translateX(0); }
          }

          @keyframes civup-slide-left-fade {
            from { opacity: 0; transform: translateX(-12px); }
            to { opacity: 1; transform: translateX(0); }
          }

          @keyframes civup-portrait-in {
            from { opacity: 0; transform: scale(1.02); }
            to { opacity: 1; transform: scale(1); }
          }

          @keyframes civup-phase-flash {
            from { opacity: 0.35; }
            to { opacity: 0; }
          }

          .anim-fade-in { animation: civup-fade-in 200ms ease-out both; }
          .anim-overlay-in { animation: civup-slide-up-fade 250ms ease-out both; }
          .anim-detail-in { animation: civup-slide-right-fade 200ms ease-out both; }
          .anim-detail-in-right { animation: civup-slide-left-fade 200ms ease-out both; }
          .anim-portrait-in { animation: civup-portrait-in 300ms ease-out both; }
          .anim-phase-flash { animation: civup-phase-flash 200ms ease-out both; }

          @keyframes civup-glow-breathe {
            0%, 100% { opacity: 0.2; }
            50% { opacity: 0.05; }
          }
          .anim-glow-breathe { animation: civup-glow-breathe 3s ease-in-out infinite; }
          @keyframes civup-glow-fade-out {
            from { opacity: 0.2; }
            to { opacity: 0; }
          }
          .anim-glow-fade-out { animation: civup-glow-fade-out 400ms ease-out forwards; }

          @keyframes civup-bar-breathe {
            0%, 100% { width: 30%; opacity: 0.9; }
            50% { width: 55%; opacity: 0.5; }
          }
          .anim-bar-breathe { animation: civup-bar-breathe 3s ease-in-out infinite; }

          @keyframes civup-bar-fade-out {
            from { width: 30%; opacity: 0.9; }
            to { width: 20%; opacity: 0; }
          }
          .anim-bar-fade-out { animation: civup-bar-fade-out 400ms ease-out forwards; }

          @keyframes civup-turn-flash {
            0% { opacity: 0.55; }
            100% { opacity: 0; }
          }
          .anim-turn-flash { animation: civup-turn-flash 550ms ease-out forwards; }

          .screen-glow-mask {
            -webkit-mask-image: linear-gradient(to bottom, transparent, black 15%, black 85%, transparent);
            mask-image: linear-gradient(to bottom, transparent, black 15%, black 85%, transparent);
          }

          .slot-accent-gold { --slot-glow: var(--accent); }
          .slot-accent-red  { --slot-glow: var(--danger); }

          .slot-cell {
            flex: 1 1 0;
            max-width: 400px;
            min-width: 0;
          }

          .slot-cell-ffa {
            flex: 1 1 0;
            max-width: 240px;
            min-width: 0;
          }

          .slot-strip-team {
            max-height: 100%;
          }

          .slot-strip-ffa {
            max-height: 100%;
          }

          @keyframes civup-swap-in {
            from {
              opacity: 0;
              transform: scale(0.94);
            }
            to {
              opacity: 1;
              transform: scale(1);
            }
          }
          .anim-swap-in { animation: civup-swap-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both; }

          @keyframes civup-swap-focus-flash {
            from { opacity: 1; }
            to { opacity: 0; }
          }
          .anim-swap-focus-flash { animation: civup-swap-focus-flash 420ms ease-out both; }

          .civup-h-scroll {
            -ms-overflow-style: none;
            scrollbar-width: none;
          }

          .civup-h-scroll::-webkit-scrollbar {
            display: none;
          }

          @media (hover: hover) and (pointer: fine) {
            .civup-h-scroll {
              cursor: grab;
            }

            .civup-h-scroll.is-dragging {
              cursor: grabbing;
              user-select: none;
            }
          }

          .grid-panel-glow {
            box-shadow:
              0 0 20px var(--accent-subtle),
              0 0 40px var(--accent-subtle),
              inset 0 1px 0 var(--accent-muted);
          }
        `
      },
    },
  ],
})
