import { defineConfig, presetUno, presetWebFonts } from 'unocss'

export default defineConfig({
  presets: [
    presetUno(),
    presetWebFonts({
      fonts: {
        sans: 'Inter:400,500,600,700,800',
      },
    }),
  ],
  theme: {
    colors: {
      bg: {
        primary: '#0a0e14',
        secondary: '#111827',
        panel: 'rgba(255, 255, 255, 0.05)',
        hover: 'rgba(255, 255, 255, 0.08)',
      },
      accent: {
        'gold': '#c8aa6e',
        'gold-dim': '#7c6a3e',
        'red': '#e84057',
        'red-dim': '#8b2636',
        'blue': '#0ac8b9',
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
    'panel': 'bg-bg-panel border border-border-subtle rounded-lg backdrop-blur-sm',
    'panel-hover': 'panel hover:bg-bg-hover transition-colors',
    'text-heading': 'font-bold uppercase tracking-wider',
    'gold-glow': 'shadow-[0_0_12px_rgba(200,170,110,0.3)]',
    'red-glow': 'shadow-[0_0_12px_rgba(232,64,87,0.3)]',
  },
})
