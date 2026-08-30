export type GitlabLabelColor = {
  name?: string;
  color?: string;
  textColor?: string;
  text_color?: string;
};

export function normalizeHex(raw?: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (!/^#[0-9a-f]{6}$/i.test(s)) return null;
  return s.toLowerCase();
}

function hexRgb(hex: string): { r: number; g: number; b: number } | null {
  const n = normalizeHex(hex);
  if (!n) return null;
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

/** GitLab YIQ contrast: light text on dark bg, dark text on light bg. */
export function gitlabTextOn(bg: string, explicit?: string | null): string {
  const given = normalizeHex(explicit);
  if (given) return given;
  const rgb = hexRgb(bg);
  if (!rgb) return "#ffffff";
  const yiq = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
  return yiq >= 128 ? "#333333" : "#ffffff";
}

export function gitlabLabelChipStyle(
  entry?: GitlabLabelColor | null,
): Record<string, string> | undefined {
  const bg = normalizeHex(entry?.color);
  if (!bg) return undefined;
  return {
    background: bg,
    color: gitlabTextOn(bg, entry?.textColor || entry?.text_color),
    borderColor: "transparent",
  };
}
