/**
 * Tailwind configuration used only to compile `css/tailwind.css`.
 *
 * This file exists because the Play CDN was replaced by a compiled stylesheet:
 * the CDN prints a production warning and compiles the CSS in the browser on
 * every load. The app itself stays static — `css/tailwind.css` is generated
 * once (`npm run css`) and shipped in the build.
 *
 * Keep `content` pointing at every file that contains class names.
 */
module.exports = {
  content: ['./index.html', './js/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'rgb(var(--brand-50) / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          200: 'rgb(var(--brand-200) / <alpha-value>)',
          300: 'rgb(var(--brand-300) / <alpha-value>)',
          400: 'rgb(var(--brand-400) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          800: 'rgb(var(--brand-800) / <alpha-value>)',
          900: 'rgb(var(--brand-900) / <alpha-value>)',
          950: 'rgb(var(--brand-950) / <alpha-value>)',
        },
      },
    },
  },
};
