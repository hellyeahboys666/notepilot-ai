/** @type {import('tailwindcss').Config} */

// Theme colours and fonts are CSS variables set per theme in src/sidepanel/index.css
// (`:root` is Classic; `:root[data-theme="…"]` overrides it). Colours are stored as
// RGB triplets so opacity modifiers such as `bg-ink-50/70` keep working.
const scale = (name, steps) =>
  Object.fromEntries(steps.map((step) => [step, `rgb(var(--np-${name}-${step}) / <alpha-value>)`]));

module.exports = {
  content: ['./sidepanel.html', './src/sidepanel/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--np-font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif)'],
        serif: ['var(--np-font-serif, Charter, "Iowan Old Style", Georgia, Cambria, serif)'],
      },
      colors: {
        white: 'rgb(var(--np-white) / <alpha-value>)',
        ink: scale('ink', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        accent: scale('accent', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
      },
      fontSize: { '2xs': ['10.5px', '14px'] },
    },
  },
  plugins: [],
};
