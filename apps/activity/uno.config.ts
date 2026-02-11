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
    }),
  ],
  theme: {
    colors: {
      bg: {
        primary: '#0a0e14',
        secondary: '#111827',
        hover: '#151d2b',
      },
      accent: {
        'gold': '#c8aa6e',
        'gold-dim': '#7c6a3e',
        'red': '#e84057',
        'red-dim': '#8b2636',
        'blue': '#0ac8b9',
        'slate': '#334155',
      },
      text: {
        primary: '#ffffff',
        secondary: '#a0aec0',
        muted: '#4a5568',
      },
      border: {
        subtle: 'rgba(255, 255, 255, 0.1)',
      },
    },
  },
  shortcuts: {
    'text-heading': 'font-bold uppercase tracking-wider',
  },
  preflights: [
    {
      getCSS: () => {
        return minify`
          body {
            font-family: 'Inter Variable', sans-serif;
            background: #0a0e14;
            color: #ffffff;
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
          ::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
          ::-webkit-scrollbar-thumb:hover { background: #475569; }

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

          @keyframes civup-slot-breathe {
            0%, 100% { box-shadow: inset 4px 0 14px var(--slot-glow), inset -4px 0 14px var(--slot-glow); }
            50% { box-shadow: inset 2px 0 6px var(--slot-glow-dim), inset -2px 0 6px var(--slot-glow-dim); }
          }
          .anim-slot-breathe { animation: civup-slot-breathe 2s ease-in-out infinite; }
          .slot-accent-gold { --slot-glow: rgba(200, 170, 110, 0.4); --slot-glow-dim: rgba(200, 170, 110, 0.15); }
          .slot-accent-red  { --slot-glow: rgba(232, 64, 87, 0.4);  --slot-glow-dim: rgba(232, 64, 87, 0.15); }

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
        `
      },
    },
  ],
})
