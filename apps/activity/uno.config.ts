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

          body {
            font-family: 'Inter Variable', sans-serif;
            background: var(--bg);
            color: var(--fg);
            user-select: none;
            -webkit-user-select: none;
          }

          img {
            -webkit-user-drag: none;
            user-drag: none;
            user-select: none;
            -webkit-user-select: none;
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
