/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Tokens live in src/index.css as CSS custom properties, per
      // docs/UI_DESIGN.md. Tailwind reads them so utilities and raw CSS
      // can never disagree about a colour.
      colors: {
        paper: "var(--paper)",
        strip: "var(--strip)",
        board: "var(--board)",
        ink: "var(--ink)",
        "ink-2": "var(--ink-2)",
        rule: "var(--rule)",
        legal: "var(--legal)",
        breach: "var(--breach)",
        caution: "var(--caution)",
      },
      fontFamily: {
        sans: ["IBM Plex Sans", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
      fontSize: {
        13: ["13px", "1.45"],
        14: ["14px", "1.5"],
        16: ["16px", "1.5"],
        20: ["20px", "1.35"],
        28: ["28px", "1.2"],
      },
    },
  },
  plugins: [],
};
