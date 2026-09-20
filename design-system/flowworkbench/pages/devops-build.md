# DevOps Build Page Overrides

> **PROJECT:** FlowWorkbench  
> **Page:** DevOps Build (`DevopsView` / Build tab)  
> **Stack:** Vue 3 + Ant Design Vue + Tailwind + `--app-*` CSS tokens  
> **Style:** Developer Tool / IDE / CI console (dark). Keep blue accent + **run green**. Do **not** use purple `#6366F1`.

> Rules here override `design-system/flowworkbench/MASTER.md` for this screen only.

---

## Layout

- Shell: **Scripts sidebar** (left) + **queue strip** + **feed** (main). History / Config are separate tabs.
- Stdin **sticky** at bottom of main when the expanded card is the live running build.
- Log panes: scroll independently; **Jump to latest** when scrolled up during stream.
- Density: compact IDE (8pt). No marketing hero / stat strip clutter on the feed.

## Build UX

- Empty states: clickable CTA (Run first script / Open Config).
- Feed filters: All · Running · Failed; infinite scroll `lastId` page **40**.
- Cards: badge + `@triggeredBy` · relative start · duration; SSE soft flash on status change.
- Log tools: Errors only · Expand · Copy visible; Re-run on terminal jobs; Open in terminal (History drawer).
- Script rows: pin/favorite (local), queued/running pills, last ok/fail · relative time.
- Queue strip = **now** (FIFO + brief failed linger); topbar = worker IDLE/RUNNING.

## Keyboard / a11y

- `/` focus script search · `R` run focused/first script · `Esc` cancel running.
- Visible `:focus-visible` on Run, chips, card head, stdin, filters.
- `aria-busy` / `aria-live` on streaming log; respect `prefers-reduced-motion` for pulse/caret/flash/skeleton.

## Do not

- Purple AI gradients, neon glow stacks, badge clusters on the feed.
- Force auto-scroll while the user reads log history (Jump only).
- Replace Ant Design History table / Config forms; do not abandon `--app-*` / run-green.
- Diff two logs in-product unless explicitly requested later.

## Mobile (≤900)

- Scripts panel collapses by default; Show/Hide toggle; list ≤30vh when open.
- Hide script/card command lines; enlarge Run (≥40px) and feed filters (full-width).
- Queue chips: horizontal scroll; hide FIFO hint + keyboard shortcut strip.
- Log max-height ~42vh (expanded ~62vh); foot actions wrap; stdin sticky + 16px.
