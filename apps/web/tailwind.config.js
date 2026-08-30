/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx}"],
  corePlugins: {
    preflight: false, // avoid fighting Ant Design reset
  },
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"IBM Plex Sans"',
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      fontSize: {
        base: ["13px", { lineHeight: "1.45" }],
      },
      borderRadius: {
        DEFAULT: "6px",
        md: "6px",
        lg: "6px",
        xl: "8px",
        "2xl": "8px",
      },
      // Palette reads theme CSS variables (see src/style.css :root /
      // [data-theme="light"]) so light/dark switching retints utilities.
      colors: {
        surface: {
          DEFAULT: "rgb(var(--c-surface) / <alpha-value>)",
          raised: "rgb(var(--c-surface-raised) / <alpha-value>)",
          soft: "rgb(var(--c-surface-soft) / <alpha-value>)",
          muted: "rgb(var(--c-surface-muted) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--c-ink) / <alpha-value>)",
          soft: "rgb(var(--c-ink) / <alpha-value>)",
          muted: "rgb(var(--c-ink-muted) / <alpha-value>)",
          faint: "rgb(var(--c-ink-faint) / <alpha-value>)",
        },
        line: {
          DEFAULT: "rgb(var(--c-line) / <alpha-value>)",
          strong: "rgb(var(--c-line-strong) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--c-accent) / <alpha-value>)",
          bright: "rgb(var(--c-accent-bright) / <alpha-value>)",
          // Translucent by default (0.14); an explicit /NN modifier overrides.
          soft: ({ opacityValue }) => {
            const alpha = Number(opacityValue);
            return Number.isFinite(alpha)
              ? `rgb(var(--c-accent) / ${opacityValue})`
              : "rgb(var(--c-accent) / 0.14)";
          },
          glow: "rgb(var(--c-accent) / <alpha-value>)",
        },
        status: {
          done: "#34D399",
          wip: "#F0B429",
          bug: "#F0576B",
          good: "#34D399",
        },
      },
      boxShadow: {
        panel: "var(--shadow-panel)",
        float: "var(--shadow-float)",
      },
    },
  },
  plugins: [],
};
