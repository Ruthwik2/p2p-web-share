/** @type {import('tailwindcss').Config} */

// Design system: "transmission / instrument".
// A deep-slate control surface where state is communicated through color.
// Teal = a live, connected signal. Amber = data in motion. Coral = a fault.
// Violet marks the encrypted path. Everything else stays quiet so the
// signature transmission line is the one thing that moves.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0E141B',
        surface: '#161E27',
        'surface-2': '#1E2832',
        line: '#2A3744',
        ink: '#E8EEF2',
        muted: '#8A9BA8',
        signal: '#5EE6C4', // connected / live / verified
        transfer: '#F2B544', // in motion
        alert: '#FF6B6B', // fault / disconnect
        encrypted: '#8B7CF6', // zero-knowledge path
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        eyebrow: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.18em' }],
      },
      keyframes: {
        'pulse-node': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.55', transform: 'scale(0.82)' },
        },
        'flow-dash': {
          to: { strokeDashoffset: '-24' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        scan: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'pulse-node': 'pulse-node 1.6s ease-in-out infinite',
        'flow-dash': 'flow-dash 0.8s linear infinite',
        'fade-up': 'fade-up 0.4s ease-out both',
        'toast-in': 'toast-in 0.25s ease-out both',
        scan: 'scan 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
