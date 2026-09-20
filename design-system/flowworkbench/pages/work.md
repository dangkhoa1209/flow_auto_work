# Work (/work) Page Overrides

> **PROJECT:** FlowWorkbench  
> **Page:** Work — TaskList · JobContext · AgentConsole  
> **Stack:** Vue 3 + Ant Design Vue + Tailwind + `--app-*` CSS tokens  
> **Style:** Developer Tool / IDE + AI agent console (dark). Keep blue accent + **run green**. Do **not** use purple `#6366F1`.

> Rules here override `design-system/flowworkbench/MASTER.md` for this screen only.

---

## Layout

- Shell: **3 columns** — Tasks/Jobs (left) · Issue context (mid) · Agent console (right). Mobile: list ↔ Issue | Console.
- Composer **sticky** at bottom of console; Process/Terminal collapsible below chat.
- Chat + Process: scroll independently; **Jump to latest** when scrolled up during stream/typing.
- Density: compact IDE (8pt). No marketing cards in columns.

## Console UX

- Context strip under head: `#iid · branch · status · context quality`.
- Message hierarchy: You right / accent soft; agent full-width left border; streaming caret on typing.
- `aria-busy` / `aria-live` while typing or Process live; respect `prefers-reduced-motion`.
- Composer elevation on focus; hint Enter / ⌘·Ctrl+Enter · Shift+Enter · Esc stop.
- Failed Send → draft bubble + **Retry** (before server accepted).
- Process tools: Errors only · Copy visible · Jump to latest.
- Empty console stays plain (no clickable tips unless product asks later).

## Tasks / Jobs

- Jobs empty: **Start from chat** / **Run selected** CTAs.
- Job rows: relative time · duration · awaiting pill · pin (localStorage) · `N+` when `jobsHasMore`.
- Task search debounce ~180ms; `/` focuses search.
- Focus-visible on task/job rows; SSE soft flash on job status + mid-column status change.
- Do **not** add All/Running/Failed jobs filter unless requested.

## Mid column

- Sticky bottom bar: **primary** Run (+ Approve Plan) vs quieter secondary (Sync / MR / Merge / Testcase / Handoff).
- Run tooltip explains thin context / blocked reason when relevant.

## Keyboard / a11y

- `/` task search · ⌘/Ctrl+Enter Run (outside inputs) · ⌘/Ctrl+S notes · Esc close modal else Force Stop.
- Visible `:focus-visible` on Run, rows, composer, Process tools.
- English chrome (alerts, empty, tips).

## Do not

- Purple AI gradients, neon glow on Run, badge clusters on mid column.
- Clickable empty-console tips or Jobs All/Running/Failed filter unless explicitly requested.
- Replace Ant Design tabs / Splitpanes; do not abandon `--app-*` / run-green.
- Double typing bubbles (chat + Process both “thinking”).
