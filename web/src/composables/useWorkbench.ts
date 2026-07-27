import { computed, h, nextTick, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { api } from "@/api/client";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useWorkStore, isAdhocJob, type TaskDetail } from "@/stores/work";
import { statusLabel } from "@/utils/status";

export type MobilePane = "tasks" | "detail" | "chat";
export type MidTab = "detail" | "diff";

export function useWorkbench() {
  const router = useRouter();
  const session = useSessionStore();
  const settings = useSettingsStore();
  const work = useWorkStore();
  const {
    tasks,
    jobs,
    selectedTaskIid,
    selectedJobId,
    currentJob,
    taskDetail,
    chat,
    progressLines,
    progressLive,
    loading,
    jobLoading,
    labels,
    agentTyping,
  } = storeToRefs(work);

  const midTab = ref<MidTab>("detail");
  const selectedIids = ref<number[]>([]);
  const chatInput = ref("");
  const busy = ref(false);
  const stopBusy = ref(false);
  const notesSaving = ref(false);
  const notesDraft = ref("");
  const requireDocsFirst = ref(false);
  const milestoneFilter = ref<string>("all");
  const openIidDraft = ref("");
  const mobilePane = ref<MobilePane>("tasks");
  const standardsOpen = ref(false);
  const approveDocsBusy = ref(false);
  const mergeBusy = ref(false);
  const handoffBusy = ref(false);
  const syncBaseBusy = ref(false);
  const syncBaseOpen = ref(false);
  const syncBaseChoice = ref<string>("");
  const syncBaseBranches = ref<string[]>([]);
  const syncBaseBranchesLoading = ref(false);

  const adhocOpen = ref(false);
  const adhocTitle = ref("");
  const adhocMessage = ref("");
  const adhocBusy = ref(false);

  const issueCreateOpen = ref(false);
  const issueCreateBusy = ref(false);
  const issueTitle = ref("");
  const issueDescription = ref("");
  const issueLabels = ref<string[]>([]);

  const jobStatusBusy = ref<string | null>(null);

  const relatedPreviewOpen = ref(false);
  const relatedPreviewLoading = ref(false);
  const relatedPreview = ref<TaskDetail | null>(null);
  const relatedPreviewError = ref<string | null>(null);
  const relatedPreviewFallback = ref<{
    iid: number;
    title?: string;
    url?: string;
  } | null>(null);

  const isCurrentAdhoc = computed(() => isAdhocJob(currentJob.value));

  const milestones = computed(() => {
    const set = new Set<string>();
    for (const t of tasks.value) {
      const title = t.milestone?.title?.trim();
      if (title) set.add(title);
    }
    return ["all", ...Array.from(set).sort(), "__none__"];
  });

  const filteredTasks = computed(() => {
    return tasks.value.filter((t) => {
      if (milestoneFilter.value === "all") return true;
      if (milestoneFilter.value === "__none__") return !t.milestone?.title;
      return t.milestone?.title === milestoneFilter.value;
    });
  });

  const sortedJobs = computed(() => {
    return [...jobs.value].sort((a, b) => {
      const ub = Date.parse(b.updatedAt || "") || 0;
      const ua = Date.parse(a.updatedAt || "") || 0;
      if (ub !== ua) return ub - ua;
      const cb = Date.parse(b.createdAt || "") || 0;
      const ca = Date.parse(a.createdAt || "") || 0;
      if (cb !== ca) return cb - ca;
      return (b.issue?.issueIid || 0) - (a.issue?.issueIid || 0);
    });
  });

  const humanComments = computed(() =>
    (taskDetail.value?.notes || []).filter((n) => !n.system && n.body?.trim()),
  );

  const relatedIssues = computed(() => taskDetail.value?.related || []);

  const contextQuality = computed(
    () => currentJob.value?.contextQuality || null,
  );

  const contextIsBad = computed(() => contextQuality.value?.level === "bad");

  const detailTitle = computed(
    () => taskDetail.value?.title || currentJob.value?.issue?.title || "",
  );

  const detailMeta = computed(() => {
    const d = taskDetail.value;
    if (!d) return "";
    const assignees =
      (d.assignees || []).map((a) => `@${a.username}`).join(", ") || "—";
    const parts = [d.state || "—", `assignee ${assignees}`];
    if (d.taskCompletion) {
      parts.push(
        `checklist ${d.taskCompletion.completedCount}/${d.taskCompletion.count}`,
      );
    }
    if (d.milestone?.title) parts.push(`milestone ${d.milestone.title}`);
    return parts.join(" · ");
  });

  const agentJobBusy = computed(() => {
    const st = currentJob.value?.status;
    return st === "queued" || st === "running";
  });

  /** Send / Ask locked while agent is thinking or job is queued/running */
  const chatLocked = computed(
    () => busy.value || agentTyping.value || agentJobBusy.value,
  );

  const canForceStop = computed(() => {
    if (!currentJob.value) return false;
    if (progressLive.value) return true;
    return [
      "queued",
      "running",
      "awaiting_clarification",
      "awaiting_docs_approval",
      "awaiting_diff_approval",
    ].includes(currentJob.value.status);
  });

  const agentWindowShort = computed(() => {
    const id = currentJob.value?.agentId?.trim();
    if (!id) return null;
    return id.length > 18 ? `${id.slice(0, 16)}…` : id;
  });

  const canResetWindow = computed(() => Boolean(currentJob.value));

  const awaitingDocsApproval = computed(
    () => currentJob.value?.status === "awaiting_docs_approval",
  );

  const canQuickMerge = computed(() => {
    const st = currentJob.value?.status;
    return Boolean(
      selectedJobId.value && (st === "awaiting_handoff" || st === "succeeded"),
    );
  });

  const canQuickHandoff = computed(() => {
    const st = currentJob.value?.status;
    return Boolean(
      selectedJobId.value && (st === "awaiting_handoff" || st === "succeeded"),
    );
  });

  /** Pull base → work branch: any job with a branch that is not busy in queue */
  const canSyncBase = computed(() => {
    const j = currentJob.value;
    if (!selectedJobId.value || !j) return false;
    if (!jobBranch(j)) return false;
    return j.status !== "running" && j.status !== "queued";
  });

  const runBlockedReason = computed(() => {
    if (contextIsBad.value) return "Add Dev Notes (Bad Context)";
    return null;
  });

  watch(
    currentJob,
    (j) => {
      notesDraft.value = (j?.devNotes || "").trim();
      requireDocsFirst.value = Boolean(j?.requireDocsFirst);
    },
    { immediate: true },
  );

  watch(selectedJobId, () => {
    midTab.value = "detail";
  });

  let notesDebounce: ReturnType<typeof setTimeout> | null = null;
  function scheduleNotesAutosave() {
    if (notesDebounce) clearTimeout(notesDebounce);
    notesDebounce = setTimeout(() => {
      void saveNotes({ silent: true });
    }, 900);
  }

  async function openTaskByIid() {
    const raw = openIidDraft.value.trim().replace(/^#/, "");
    const iid = Number(raw);
    if (!Number.isFinite(iid) || iid <= 0) {
      message.warning("Enter a valid #iid");
      return;
    }
    openIidDraft.value = "";
    await onSelectTask(iid);
  }

  async function openRelatedPreview(opts: {
    iid: number;
    title?: string;
    url?: string;
  }) {
    relatedPreviewFallback.value = opts;
    relatedPreviewOpen.value = true;
    relatedPreviewLoading.value = true;
    relatedPreviewError.value = null;
    relatedPreview.value = null;
    try {
      relatedPreview.value = await work.fetchTaskDetail(opts.iid);
    } catch (e) {
      relatedPreviewError.value = e instanceof Error ? e.message : String(e);
    } finally {
      relatedPreviewLoading.value = false;
    }
  }

  function backToMobileList() {
    mobilePane.value = "tasks";
  }

  async function onSelectTask(iid: number) {
    midTab.value = "detail";
    mobilePane.value = "detail";
    try {
      await work.selectTask(iid);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSelectJob(id: string) {
    if (jobLoading.value && selectedJobId.value === id) return;
    try {
      await work.selectJob(id);
      midTab.value = "detail";
      // Mobile: open job detail; jump to Console when agent is active
      mobilePane.value =
        ["running", "queued", "awaiting_clarification"].includes(
          currentJob.value?.status || "",
        )
          ? "chat"
          : "detail";
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onJobStatusChange(jobId: string, status: string) {
    if (!status) return;
    jobStatusBusy.value = jobId;
    try {
      const job = jobs.value.find((j) => j.id === jobId);
      const isBusy = ["queued", "running"].includes(
        job?.status || "",
      );
      await work.setJobStatus(jobId, status, { force: isBusy });
      message.success(`Status changed → ${statusLabel(status)}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      await work.loadJobs();
    } finally {
      jobStatusBusy.value = null;
    }
  }

  async function onDeleteJob(jobId: string) {
    jobStatusBusy.value = jobId;
    try {
      const job = jobs.value.find((j) => j.id === jobId);
      const isBusy = ["queued", "running"].includes(
        job?.status || "",
      );
      await work.deleteJob(jobId, { force: isBusy });
      message.success("Job deleted");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      jobStatusBusy.value = null;
    }
  }

  async function saveNotes(opts?: { silent?: boolean }) {
    if (!selectedJobId.value && !selectedTaskIid.value) return;
    const nextNotes = notesDraft.value;
    const prevJob = currentJob.value;
    const prevNotes = prevJob?.devNotes ?? "";

    // Optimistic: reflect notes on the open job immediately
    if (currentJob.value) {
      currentJob.value = {
        ...currentJob.value,
        devNotes: nextNotes,
      };
    }
    notesSaving.value = true;
    try {
      await work.saveDevNotes({
        devNotes: nextNotes,
        requireDocsFirst: requireDocsFirst.value,
      });
      if (!opts?.silent) message.success("Dev Notes saved");
    } catch (e) {
      if (currentJob.value && prevJob?.id === currentJob.value.id) {
        currentJob.value = {
          ...currentJob.value,
          devNotes: prevNotes,
        };
      }
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      notesSaving.value = false;
    }
  }

  async function ensureCursorKey() {
    if (session.me?.hasCursorApiKey) return true;
    message.warning("Cursor API key required — open Settings → Cursor");
    router.push({ name: "settings-cursor" });
    return false;
  }

  /** IIDs not in Open (assigned-to-you) list — confirm before Run only. */
  function confirmRunIfNotAssigned(iids: number[]): Promise<boolean> {
    const openSet = new Set(tasks.value.map((t) => t.issueIid));
    const foreign = iids.filter((id) => id > 0 && !openSet.has(id));
    if (!foreign.length) return Promise.resolve(true);

    const list = foreign.map((id) => `#${id}`).join(", ");
    const plural = foreign.length > 1;
    return new Promise((resolve) => {
      Modal.confirm({
        title: plural
          ? "These issues are not on your plate"
          : "This issue is not on your plate",
        content: plural
          ? `${list} are not in your assigned open issues (another assignee, closed, or opened via Related). Run the agent anyway?`
          : `${list} is not in your assigned open issues (another assignee, closed, or opened via Related). Run the agent anyway?`,
        okText: "Run anyway",
        cancelText: "Cancel",
        centered: true,
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  /** Issue panel Run — always the current job (issue or Hotfix). */
  async function runCurrentJob() {
    if (runBlockedReason.value && contextIsBad.value) {
      message.warning(runBlockedReason.value);
      return;
    }
    if (!(await ensureCursorKey())) return;
    if (!selectedJobId.value) {
      message.warning("Select a job first");
      return;
    }

    const iid = currentJob.value?.issue?.issueIid;
    if (iid && iid > 0 && !(await confirmRunIfNotAssigned([iid]))) return;

    busy.value = true;
    try {
      const res = await work.startJobs({
        mode: "selected",
        jobIds: [selectedJobId.value],
        devNotes: notesDraft.value.trim() || undefined,
        requireDocsFirst: requireDocsFirst.value,
      });
      mobilePane.value = "chat";
      const n = res.enqueued ?? 0;
      if (n > 0) message.success("Job queued for agent run");
      else {
        const why = res.skipReasons?.[0]?.reason
          ? ` (${res.skipReasons[0].reason})`
          : "";
        message.warning(`Nothing queued${why}`);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy.value = false;
    }
  }

  /** Tasks column Run — checked Open tasks only (no job / Hotfix). */
  async function runCheckedTasks() {
    if (runBlockedReason.value && contextIsBad.value) {
      message.warning(runBlockedReason.value);
      return;
    }
    if (!(await ensureCursorKey())) return;
    const iids = selectedIids.value.filter((id) => id > 0);
    if (!iids.length) {
      message.warning("Select a task");
      return;
    }
    if (!(await confirmRunIfNotAssigned(iids))) return;

    busy.value = true;
    try {
      const res = await work.startJobs({
        mode: "selected",
        issueIids: iids,
        devNotes: notesDraft.value.trim() || undefined,
        requireDocsFirst: requireDocsFirst.value,
      });
      mobilePane.value = "chat";
      const n = res.enqueued ?? 0;
      if (n > 0) {
        message.success(
          n === 1
            ? "Task queued for agent run"
            : `${n} tasks queued for agent run`,
        );
      } else {
        const miss = res.missing?.length
          ? ` (#${res.missing.join(", #")} not found)`
          : "";
        const why = res.skipReasons?.[0]?.reason
          ? ` (${res.skipReasons[0].reason})`
          : "";
        message.warning(`Nothing queued${miss || why}`);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy.value = false;
    }
  }

  /** Confirm Run all — list every assigned open task. */
  function confirmRunAllTasks(): Promise<boolean> {
    const list = tasks.value;
    if (!list.length) {
      message.warning("No open tasks");
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      Modal.confirm({
        title: `Run all open tasks (${list.length})?`,
        width: 520,
        centered: true,
        okText: `Run all (${list.length})`,
        cancelText: "Cancel",
        content: h("div", { class: "faw-run-all-confirm" }, [
          h(
            "p",
            { class: "faw-run-all-confirm__hint" },
            "These assigned open tasks will be queued for the agent:",
          ),
          h(
            "ul",
            { class: "faw-run-all-confirm__list" },
            list.map((t) =>
              h("li", { key: t.issueIid }, [
                h(
                  "code",
                  { class: "faw-run-all-confirm__iid" },
                  `#${t.issueIid}`,
                ),
                h(
                  "span",
                  { class: "faw-run-all-confirm__title", title: t.title },
                  t.title,
                ),
              ]),
            ),
          ),
        ]),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  /** Tasks column Run all — assigned open tasks only. */
  async function runAll() {
    if (!(await ensureCursorKey())) return;
    if (!(await confirmRunAllTasks())) return;
    busy.value = true;
    try {
      const res = await work.startJobs({ mode: "all" });
      const n = res.enqueued ?? 0;
      if (n > 0) message.success(`${n} task(s) queued`);
      else message.warning("Nothing queued — all skipped or already busy");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy.value = false;
    }
  }

  async function sendChat(mode: "continue" | "ask") {
    const msg = chatInput.value.trim();
    if (!msg) return;
    if (!selectedJobId.value) {
      message.warning("Select a job first");
      return;
    }
    if (chatLocked.value) {
      message.warning("Agent đang bận — đợi xong hoặc Force Stop rồi gửi lại");
      return;
    }
    if (!(await ensureCursorKey())) return;
    chatInput.value = "";
    busy.value = true;
    work.watchProgress();
    await nextTick();
    try {
      // Clarification replies always go through continue (same chat)
      const useContinue =
        mode === "continue" ||
        currentJob.value?.status === "awaiting_clarification";
      if (useContinue) {
        const res = await work.sendContinue(msg);
        if (res?.kind === "bad_context") {
          message.warning("Bad Context — bổ sung Dev Notes / chat rồi Send lại");
        }
        // queued → agentTyping + SSE; no blocking wait
      } else {
        await work.sendAsk(msg);
      }
    } catch (e) {
      const msgText = e instanceof Error ? e.message : String(e);
      if (/Force-stopped/i.test(msgText)) {
        message.info("Chat stopped");
      } else {
        message.error(msgText);
      }
    } finally {
      busy.value = false;
      await work.loadJobs().catch(() => undefined);
    }
  }

  async function forceStop() {
    if (!selectedJobId.value) return;
    stopBusy.value = true;
    try {
      await work.killJob(selectedJobId.value);
      message.success("Force Stop sent");
      await work.refreshJobChat(selectedJobId.value);
      await work.loadJobs();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      stopBusy.value = false;
    }
  }

  async function killAllJobs() {
    try {
      const res = await work.killAllJobs();
      message.success(
        res.killed > 0
          ? `Stopped ${res.killed} job${res.killed === 1 ? "" : "s"}`
          : "No active jobs to stop",
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function resetAgentWindow() {
    if (!selectedJobId.value) return;
    busy.value = true;
    try {
      const res = await work.resetAgentWindow(selectedJobId.value);
      message.success(
        res.killed
          ? "Stopped + window reset"
          : "Window reset — ready for a new window",
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy.value = false;
    }
  }

  async function approveDocs() {
    if (!selectedJobId.value) return;
    approveDocsBusy.value = true;
    try {
      await work.approveDocs(selectedJobId.value);
      message.success("Docs approved — code phase enqueued");
      mobilePane.value = "chat";
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      approveDocsBusy.value = false;
    }
  }

  /** Quick merge work→base (same as Handoff page). */
  async function quickMerge() {
    if (!selectedJobId.value || !canQuickMerge.value) return;
    mergeBusy.value = true;
    try {
      await api(`/api/jobs/${selectedJobId.value}/merge`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      message.success("Merge OK");
      await work.loadJobs();
      if (selectedJobId.value) await work.selectJob(selectedJobId.value);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      mergeBusy.value = false;
    }
  }

  /** Base branch configured in Settings → Project (no guessing). */
  const configuredBaseBranch = computed(() => {
    const m = session.currentMembership;
    return (m?.baseBranch || m?.project?.mainBranch || "").trim();
  });

  /** No Settings base branch → user must pick one explicitly. */
  async function openSyncBasePicker() {
    syncBaseChoice.value = "";
    syncBaseOpen.value = true;
    const m = session.currentMembership;
    if (!m?.project?.gitlabPath) return;
    syncBaseBranchesLoading.value = true;
    try {
      const params = new URLSearchParams({
        gitlabPath: m.project.gitlabPath,
        repoPath: m.project.repoPath || m.project.localPath || "",
      });
      const res = await api<{
        remote?: Array<{ name: string }>;
        local?: string[];
      }>(`/api/gitlab/branches?${params.toString()}`);
      const names = new Set<string>([
        ...(res.remote || []).map((b) => b.name),
        ...(res.local || []),
      ]);
      syncBaseBranches.value = [...names].filter(Boolean).sort();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      syncBaseBranchesLoading.value = false;
    }
  }

  async function confirmSyncBase() {
    const branch = syncBaseChoice.value.trim();
    if (!branch) {
      message.warning("Chọn nhánh nguồn trước đã");
      return;
    }
    syncBaseOpen.value = false;
    await syncBase(branch);
  }

  /** Pull latest base into the job work branch (stash → merge → AI fix → unstash). */
  async function syncBase(targetBranch?: string) {
    if (!selectedJobId.value || !canSyncBase.value) return;
    // Never pull from a guessed default — no Settings base = user picks
    if (!targetBranch && !configuredBaseBranch.value) {
      await openSyncBasePicker();
      return;
    }
    syncBaseBusy.value = true;
    try {
      const res = await api<{
        sync?: {
          target?: string;
          aiResolved?: boolean;
          alreadyUpToDate?: boolean;
          wipWarning?: string;
        };
      }>(`/api/jobs/${selectedJobId.value}/sync-base`, {
        method: "POST",
        body: JSON.stringify(targetBranch ? { targetBranch } : {}),
      });
      const s = res?.sync;
      if (s?.alreadyUpToDate) {
        message.info(`Đã mới nhất so với ${s?.target || "base"} — không có gì để pull`);
      } else if (s?.aiResolved) {
        message.success(`Đã pull ${s?.target || "base"} — AI đã tự resolve conflict`);
      } else {
        message.success(`Đã pull ${s?.target || "base"} vào nhánh job`);
      }
      if (s?.wipWarning) message.warning(s.wipWarning, 8);
      await work.loadJobs();
      if (selectedJobId.value) await work.selectJob(selectedJobId.value);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("BASE_BRANCH_NOT_SET")) {
        await openSyncBasePicker();
      } else {
        message.error(msg);
      }
    } finally {
      syncBaseBusy.value = false;
    }
  }

  /** Quick handoff with Settings prefs (assignee / labels / comment). */
  async function quickHandoff() {
    if (!selectedJobId.value || !canQuickHandoff.value) return;
    const loc = settings.local;
    const hasPrefs = Boolean(
      loc.assignee ||
        (loc.addLabels && loc.addLabels.length) ||
        (loc.removeLabels && loc.removeLabels.length) ||
        (loc.comment && loc.comment.trim()),
    );
    if (!hasPrefs) {
      message.warning(
        "Chưa cấu hình Labels & handoff — vào Settings → Labels để set assignee/labels, rồi Save",
      );
      router.push({ name: "settings-labels" });
      return;
    }
    handoffBusy.value = true;
    try {
      await api(`/api/jobs/${selectedJobId.value}/completion-actions`, {
        method: "POST",
        body: JSON.stringify({
          assignees: loc.assignee ? [loc.assignee] : [],
          labels: loc.addLabels || [],
          removeLabels: loc.removeLabels || [],
          comment: loc.comment || undefined,
          labelMode: "add",
        }),
      });
      message.success("Handoff OK");
      await work.loadJobs();
      if (selectedJobId.value) {
        try {
          await work.selectJob(selectedJobId.value);
        } catch {
          selectedJobId.value = null;
        }
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      handoffBusy.value = false;
    }
  }

  async function refreshTasks() {
    busy.value = true;
    try {
      await Promise.all([work.loadTasks(), work.loadJobs()]);
      message.success("Tasks refreshed");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy.value = false;
    }
  }

  function jobDisplayIid(j: { issue?: { issueIid?: number }; kind?: string }) {
    const iid = j.issue?.issueIid;
    if (!iid || iid <= 0 || j.kind === "adhoc") return "Hotfix";
    return `#${iid}`;
  }

  function jobBranch(j: { branch?: string; workBranch?: string }): string {
    return (j.branch || j.workBranch || "").trim();
  }

  async function copyJobBranch(branch: string) {
    const t = branch.trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      message.success("Branch copied");
    } catch {
      message.error("Could not copy");
    }
  }

  function openAdhocModal() {
    adhocTitle.value = "";
    adhocMessage.value = "";
    adhocOpen.value = true;
  }

  async function startAdhoc() {
    const title = adhocTitle.value.trim();
    if (!title) {
      message.warning("Enter a session title");
      return;
    }
    if (!(await ensureCursorKey())) return;
    adhocBusy.value = true;
    try {
      const res = await work.createAdhocSession({
        title,
        message: adhocMessage.value.trim() || undefined,
      });
      adhocOpen.value = false;
      mobilePane.value = res.started ? "chat" : "detail";
      if (res.started) work.watchProgress();
      message.success(
        res.started ? "Hotfix opened + agent started" : "Hotfix session created",
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      adhocBusy.value = false;
    }
  }

  async function openCreateIssueModal() {
    if (!selectedJobId.value || !isCurrentAdhoc.value) return;
    issueCreateBusy.value = true;
    issueCreateOpen.value = true;
    try {
      const draft = await work.fetchIssueDraft(selectedJobId.value);
      issueTitle.value = draft.title;
      issueDescription.value = draft.description;
      issueLabels.value = [...(draft.labels || [])];
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      issueCreateOpen.value = false;
    } finally {
      issueCreateBusy.value = false;
    }
  }

  async function submitCreateIssue() {
    if (!selectedJobId.value) return;
    const title = issueTitle.value.trim();
    if (!title) {
      message.warning("Enter issue title");
      return;
    }
    issueCreateBusy.value = true;
    try {
      const res = await work.createGitlabIssue(selectedJobId.value, {
        title,
        description: issueDescription.value,
        labels: issueLabels.value,
      });
      issueCreateOpen.value = false;
      message.success(
        res.issueUrl
          ? `Issue created — ${res.issueUrl}`
          : "GitLab issue created",
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      issueCreateBusy.value = false;
    }
  }

  function toggleTaskIid(iid: number, checked: boolean) {
    if (checked) {
      if (!selectedIids.value.includes(iid)) {
        selectedIids.value = [...selectedIids.value, iid];
      }
    } else {
      selectedIids.value = selectedIids.value.filter((i) => i !== iid);
    }
  }

  return {
    work,
    tasks,
    jobs,
    selectedTaskIid,
    selectedJobId,
    currentJob,
    taskDetail,
    chat,
    progressLines,
    progressLive,
    loading,
    jobLoading,
    labels,
    agentTyping,
    chatLocked,
    midTab,
    selectedIids,
    chatInput,
    busy,
    stopBusy,
    notesSaving,
    notesDraft,
    requireDocsFirst,
    milestoneFilter,
    openIidDraft,
    mobilePane,
    backToMobileList,
    standardsOpen,
    approveDocsBusy,
    mergeBusy,
    handoffBusy,
    adhocOpen,
    adhocTitle,
    adhocMessage,
    adhocBusy,
    issueCreateOpen,
    issueCreateBusy,
    issueTitle,
    issueDescription,
    issueLabels,
    jobStatusBusy,
    relatedPreviewOpen,
    relatedPreviewLoading,
    relatedPreview,
    relatedPreviewError,
    relatedPreviewFallback,
    isCurrentAdhoc,
    milestones,
    filteredTasks,
    sortedJobs,
    humanComments,
    relatedIssues,
    contextQuality,
    contextIsBad,
    detailTitle,
    detailMeta,
    canForceStop,
    canKillAll: computed(() => work.canKillAll),
    killAllBusy: computed(() => work.killAllBusy),
    agentWindowShort,
    canResetWindow,
    awaitingDocsApproval,
    canQuickMerge,
    canQuickHandoff,
    canSyncBase,
    syncBaseBusy,
    runBlockedReason,
    openTaskByIid,
    openRelatedPreview,
    onSelectTask,
    onSelectJob,
    onJobStatusChange,
    onDeleteJob,
    saveNotes,
    scheduleNotesAutosave,
    runSelected: runCheckedTasks,
    runCheckedTasks,
    runCurrentJob,
    runAll,
    sendChat,
    forceStop,
    killAllJobs,
    resetAgentWindow,
    approveDocs,
    quickMerge,
    quickHandoff,
    syncBase,
    syncBaseOpen,
    syncBaseChoice,
    syncBaseBranches,
    syncBaseBranchesLoading,
    confirmSyncBase,
    refreshTasks,
    jobDisplayIid,
    jobBranch,
    copyJobBranch,
    openAdhocModal,
    startAdhoc,
    openCreateIssueModal,
    submitCreateIssue,
    toggleTaskIid,
  };
}
