import { computed, nextTick, ref, watch } from "vue";
import { message } from "ant-design-vue";
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
  const clarifyInput = ref("");
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

  const pendingClarify = computed(() => {
    const j = currentJob.value;
    if (j?.status === "awaiting_clarification" && j.lastQuestion) {
      return j.lastQuestion;
    }
    return null;
  });

  const awaitingDocsApproval = computed(
    () => currentJob.value?.status === "awaiting_docs_approval",
  );

  const canQuickMerge = computed(() => {
    const st = currentJob.value?.status;
    return Boolean(selectedJobId.value && st === "awaiting_handoff");
  });

  const canQuickHandoff = computed(() => {
    const st = currentJob.value?.status;
    return Boolean(selectedJobId.value && st === "awaiting_handoff");
  });

  const runBlockedReason = computed(() => {
    if (contextIsBad.value) return "Cần bổ sung Dev Notes (Bad Context)";
    return null;
  });

  watch(
    currentJob,
    (j) => {
      notesDraft.value = (j?.devNotes || j?.techLeadNotes || "").trim();
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
      message.warning("Nhập #iid hợp lệ");
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
      const isBusy = ["queued", "running", "awaiting_clarification"].includes(
        job?.status || "",
      );
      await work.setJobStatus(jobId, status, { force: isBusy });
      message.success(`Đã đổi status → ${statusLabel(status)}`);
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
      const isBusy = ["queued", "running", "awaiting_clarification"].includes(
        job?.status || "",
      );
      await work.deleteJob(jobId, { force: isBusy });
      message.success("Đã xóa job");
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
    const prevNotes = prevJob?.devNotes ?? prevJob?.techLeadNotes ?? "";

    // Optimistic: reflect notes on the open job immediately
    if (currentJob.value) {
      currentJob.value = {
        ...currentJob.value,
        devNotes: nextNotes,
        techLeadNotes: nextNotes,
      };
    }
    notesSaving.value = true;
    try {
      await work.saveDevNotes({
        devNotes: nextNotes,
        requireDocsFirst: requireDocsFirst.value,
      });
      if (!opts?.silent) message.success("Đã lưu Dev Notes");
    } catch (e) {
      if (currentJob.value && prevJob?.id === currentJob.value.id) {
        currentJob.value = {
          ...currentJob.value,
          devNotes: prevNotes,
          techLeadNotes: prevNotes,
        };
      }
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      notesSaving.value = false;
    }
  }

  async function ensureCursorKey() {
    if (session.me?.hasCursorApiKey) return true;
    message.warning("Cần Cursor API key — mở Settings → Cursor");
    router.push({ name: "settings-cursor" });
    return false;
  }

  async function runSelected() {
    if (runBlockedReason.value && contextIsBad.value) {
      message.warning(runBlockedReason.value);
      return;
    }
    if (!(await ensureCursorKey())) return;
    const iids =
      selectedIids.value.length > 0
        ? selectedIids.value
        : selectedTaskIid.value
          ? [selectedTaskIid.value]
          : [];
    if (!iids.length) {
      message.warning("Chọn task");
      return;
    }
    busy.value = true;
    try {
      await work.startJobs({
        mode: "selected",
        issueIids: iids,
        devNotes: notesDraft.value.trim() || undefined,
        requireDocsFirst: requireDocsFirst.value,
      });
      mobilePane.value = "chat";
      message.success("Đã đưa task vào hàng chờ chạy agent");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy.value = false;
    }
  }

  async function runAll() {
    if (!(await ensureCursorKey())) return;
    busy.value = true;
    try {
      await work.startJobs({ mode: "all" });
      message.success("Đã đưa tất cả task vào hàng chờ");
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
      message.warning("Chọn job trước");
      return;
    }
    if (!(await ensureCursorKey())) return;
    chatInput.value = "";
    busy.value = true;
    work.watchProgress();
    await nextTick();
    try {
      if (mode === "continue") await work.sendContinue(msg);
      else await work.sendAsk(msg);
    } catch (e) {
      const msgText = e instanceof Error ? e.message : String(e);
      if (/Force-stopped/i.test(msgText)) {
        message.info("Đã dừng chat");
      } else {
        message.error(msgText);
      }
    } finally {
      busy.value = false;
      await work.loadJobs().catch(() => undefined);
    }
  }

  async function sendClarify() {
    const a = clarifyInput.value.trim();
    if (!a || !selectedJobId.value) return;
    busy.value = true;
    try {
      await work.sendClarify(a);
      clarifyInput.value = "";
      message.success("Đã gửi clarify");
      await work.refreshJobChat(selectedJobId.value);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy.value = false;
    }
  }

  async function forceStop() {
    if (!selectedJobId.value) return;
    stopBusy.value = true;
    try {
      await work.killJob(selectedJobId.value);
      message.success("Đã Force Stop");
      await work.refreshJobChat(selectedJobId.value);
      await work.loadJobs();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      stopBusy.value = false;
    }
  }

  async function resetAgentWindow() {
    if (!selectedJobId.value) return;
    busy.value = true;
    try {
      const res = await work.resetAgentWindow(selectedJobId.value);
      message.success(
        res.killed
          ? "Đã dừng + reset window"
          : "Đã reset window — sẵn sàng cửa sổ mới",
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
      message.success("Đã duyệt docs — enqueue code phase");
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

  /** Quick handoff with Settings prefs (assignee / labels / comment). */
  async function quickHandoff() {
    if (!selectedJobId.value || !canQuickHandoff.value) return;
    handoffBusy.value = true;
    try {
      const loc = settings.local;
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
      message.success("Đã refresh tasks");
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
      message.success("Đã copy branch");
    } catch {
      message.error("Không copy được");
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
      message.warning("Nhập tiêu đề session");
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
        res.started ? "Đã mở Hotfix + gửi agent" : "Đã tạo session Hotfix",
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
      message.warning("Nhập title issue");
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
          ? `Đã tạo issue — ${res.issueUrl}`
          : "Đã tạo GitLab issue",
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
    midTab,
    selectedIids,
    chatInput,
    clarifyInput,
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
    agentWindowShort,
    canResetWindow,
    pendingClarify,
    awaitingDocsApproval,
    canQuickMerge,
    canQuickHandoff,
    runBlockedReason,
    openTaskByIid,
    openRelatedPreview,
    onSelectTask,
    onSelectJob,
    onJobStatusChange,
    onDeleteJob,
    saveNotes,
    scheduleNotesAutosave,
    runSelected,
    runAll,
    sendChat,
    sendClarify,
    forceStop,
    resetAgentWindow,
    approveDocs,
    quickMerge,
    quickHandoff,
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
