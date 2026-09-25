import type { ThemeMode } from "@/stores/theme";

export const BRAND_LOGO = {
  dark: "/logo-dark.svg",
  light: "/logo-light.svg",
  mark: "/favicon.svg",
} as const;

export function brandLogoSrc(mode: ThemeMode): string {
  return mode === "light" ? BRAND_LOGO.light : BRAND_LOGO.dark;
}
