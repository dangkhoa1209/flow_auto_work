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
      colors: {
        surface: {
          DEFAULT: "#0D0F14",
          raised: "#12151C",
          soft: "#171B24",
          muted: "#1A1F2A",
        },
        ink: {
          DEFAULT: "#E7E9EE",
          soft: "#E7E9EE",
          muted: "#9AA2B1",
          faint: "#5E6576",
        },
        line: {
          DEFAULT: "#232833",
          strong: "#2E3544",
        },
        accent: {
          DEFAULT: "#5B8DEF",
          bright: "#7AA2F7",
          soft: "rgba(91, 141, 239, 0.14)",
          glow: "#5B8DEF",
        },
        status: {
          done: "#34D399",
          wip: "#F0B429",
          bug: "#F0576B",
          good: "#34D399",
        },
      },
      boxShadow: {
        panel: "0 1px 0 rgba(255,255,255,0.03), 0 8px 24px rgba(0,0,0,0.28)",
        float: "0 12px 32px rgba(0,0,0,0.4)",
      },
    },
  },
  plugins: [],
};
