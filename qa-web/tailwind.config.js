/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,js,ts}"],
  theme: {
    extend: {
      colors: {
        ink: "#E7E9EE",
        muted: "#9AA2B1",
        panel: "#12151C",
        border: "#232833",
        accent: "#5B8DEF",
      },
    },
  },
  plugins: [],
};
