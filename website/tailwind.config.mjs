/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        midnight: '#0A0A0A',
        charcoal: '#1A1A1A',
        slate: '#2A2A2A',
        ash: '#3A3A3A',
        silver: '#8A8A8A',
        cloud: '#B8B4AC',
        cream: '#F5F0E8',
        ivory: '#FAF8F4',
        gold: '#C4A35A',
        'gold-light': '#D4B96A',
        'gold-dark': '#A48A3A',
        'gold-muted': '#8B7A4A',
      },
      fontFamily: {
        serif: ['Cormorant Garamond', 'Garamond', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      letterSpacing: {
        'widest-plus': '0.2em',
        'ultra': '0.35em',
      },
      fontSize: {
        'display': ['5rem', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        'display-sm': ['3.5rem', { lineHeight: '1.1', letterSpacing: '-0.01em' }],
        'heading': ['2.25rem', { lineHeight: '1.2' }],
        'subheading': ['1.5rem', { lineHeight: '1.4' }],
      },
      animation: {
        'fade-in': 'fadeIn 0.8s ease-out forwards',
        'fade-in-up': 'fadeInUp 0.8s ease-out forwards',
        'gold-line': 'goldLine 1.5s ease-out forwards',
        'subtle-pulse': 'subtlePulse 3s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        goldLine: {
          '0%': { width: '0%', opacity: '0' },
          '100%': { width: '100%', opacity: '1' },
        },
        subtlePulse: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.7' },
        },
      },
      backgroundImage: {
        'gold-gradient': 'linear-gradient(135deg, #C4A35A 0%, #D4B96A 50%, #A48A3A 100%)',
        'dark-gradient': 'linear-gradient(180deg, #0A0A0A 0%, #1A1A1A 100%)',
      },
    },
  },
  plugins: [],
};
