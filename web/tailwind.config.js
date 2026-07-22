/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx}"],
  corePlugins: {
    preflight: false, // avoid fighting Ant Design reset
  },
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Sora"', "Outfit", "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      colors: {
        surface: {
          DEFAULT: "#eef3f9",
          raised: "#ffffff",
          soft: "#f7fafc",
          muted: "#e8eef6",
        },
        ink: {
          DEFAULT: "#0f172a",
          soft: "#1e293b",
          muted: "#475569",
          faint: "#64748b",
        },
        line: {
          DEFAULT: "#d7e0ec",
          strong: "#b8c5d6",
        },
        accent: {
          DEFAULT: "#0f766e",
          bright: "#0d9488",
          soft: "#ccfbf1",
          glow: "#5eead4",
        },
      },
      boxShadow: {
        panel: "0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px rgba(15, 23, 42, 0.06)",
        float: "0 12px 40px rgba(15, 118, 110, 0.12), 0 4px 12px rgba(15, 23, 42, 0.06)",
      },
    },
  },
  plugins: [],
};
