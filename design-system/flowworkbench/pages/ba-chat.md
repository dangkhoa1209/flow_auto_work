# BA Chat Page Overrides

> **PROJECT:** FlowWorkbench  
> **Page:** BA Chat (`BaChatView`)  
> **Stack:** Vue 3 + Ant Design Vue + Tailwind + `--app-*` CSS tokens  
> **Style:** AI-Native / Developer Tool IDE (dark). Keep blue accent — do **not** use purple `#6366F1`.

> Rules here override `design-system/flowworkbench/MASTER.md` for this screen only.

---

## Layout

- Shell: **sidebar threads** (left) + **conversation** (main). Not a marketing landing.
- Composer **sticky** at bottom; message list scrolls; **Jump to latest** when scrolled up.
- Context strip under header: project · GitLab path · BA mode · drafting.
- Density: compact IDE (8pt spacing). No card stacks in the hero/message area.

## Conversation UX

- Empty state: short title + description + **clickable** prompt tips → fill composer.
  - Tip cards: English category title + domain prompt (Vietnamese product questions).
  - Domains: annual leave / leave config · attendance import Loại & Lý do · staff column update (blank cells).
- User messages right-aligned / accent soft; assistant full-width with left border.
- One typing indicator; streaming caret; `aria-busy` / `aria-live` while streaming.
- Hover: Copy MD / Copy text; last assistant: **Regenerate**; stream/send error: **Retry**.
- Failed Send (HTTP): show draft bubble + Retry (do not lose the typed text).
- Thread list: relative time, snippet on active, filter ≥8 chats, **rename** (dbl-click / edit), **pin**.

## Keyboard / a11y

- Enter / ⌘↵ (Ctrl+Enter) send · Shift+Enter newline · Esc stop.
- Visible `:focus-visible` on threads, tips, composer, actions.
- Respect `prefers-reduced-motion` for typing / caret / skeleton.

## Do not

- Purple AI gradients, neon glitch overlays, emoji-as-icons.
- Duplicate typing bubbles; blank screen on thread switch (use skeleton).
- Replace Ant Design forms/modals; do not abandon `--app-*` tokens.

## Mobile (≤1023)

- Thread list = drawer (hamburger + backdrop + close); rows ≥48px tap.
- Keep **BA mode** switch; short hint only (`Enter send · Esc stop`).
- Context: hide GitLab path; Create Issue uses short **Issue** label.
- Empty tips full-width, ≥52px; composer input 16px; Jump ≥36px.
- Main already clears bottom nav — do not double `safe-area` on composer.
