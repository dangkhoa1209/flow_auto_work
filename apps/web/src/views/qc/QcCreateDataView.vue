<script setup lang="ts">
/**
 * QC Create Data — catalog of scenarios that play through the real HR UI
 * (extension Record/Playback). Chat stays separate; this tab is the run surface.
 */
const scenarios = [
  {
    id: "annual-leave-approved",
    title: "Annual leave — approved",
    summary:
      "Create N approved annual-leave requests via UI validate, rules, and approval steps.",
    status: "Coming soon",
  },
  {
    id: "staff-probation",
    title: "Staff — probation setup",
    summary:
      "Create staff with contract and probation preconditions needed by leave and attendance scenarios.",
    status: "Coming soon",
  },
] as const;
</script>

<template>
  <div class="faw-qc-create-data h-full min-h-0 flex flex-col overflow-hidden">
    <div class="faw-console-head shrink-0">
      <div class="faw-console-head__title min-w-0">
        <h2>Create Data</h2>
        <div class="faw-console-head__win">
          Scenario catalog — runs through the HR UI (extension playback), not direct DB inserts
        </div>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
      <p class="text-[13px] text-[var(--app-muted)] m-0 max-w-2xl leading-relaxed">
        Pick a scenario, set parameters, then play on a logged-in HR tab via the QC
        extension so validation, business rules, and approval steps stay intact.
      </p>

      <div
        v-for="s in scenarios"
        :key="s.id"
        class="flex items-start gap-3 px-3 py-3 rounded border border-[var(--app-border)] bg-[var(--app-panel,transparent)]"
      >
        <div class="flex-1 min-w-0">
          <div class="font-medium text-[13px] text-ink">{{ s.title }}</div>
          <div class="text-[12px] text-[var(--app-muted)] mt-1 leading-snug">
            {{ s.summary }}
          </div>
        </div>
        <span
          class="shrink-0 text-[11px] font-medium text-ink-faint px-2 py-0.5 rounded border border-[var(--app-border)]"
        >
          {{ s.status }}
        </span>
      </div>

      <p class="text-[12px] text-ink-faint m-0 pt-2">
        Record reusable flows in the extension Side Panel first; this catalog will
        wire parameters and Run once playback is stable.
      </p>
    </div>
  </div>
</template>
