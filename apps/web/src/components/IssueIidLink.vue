<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useSessionStore } from "@/stores/session";
import { gitlabIssueUrl } from "@/utils/gitlabIssueUrl";

const props = withDefaults(
  defineProps<{
    iid?: number | null;
    url?: string | null;
    /** Extra classes on the link / span */
    linkClass?: string;
  }>(),
  {
    iid: null,
    url: null,
    linkClass: "",
  },
);

const session = useSessionStore();
const { memberships, projectId } = storeToRefs(session);

const href = computed(() => {
  const project = memberships.value.find(
    (m) => m.projectId === projectId.value,
  )?.project;
  return gitlabIssueUrl({
    url: props.url,
    iid: props.iid,
    gitlabHost: project?.gitlabHost,
    gitlabPath: project?.gitlabPath,
    gitProvider: project?.gitProvider,
  });
});

const label = computed(() => {
  const iid = props.iid;
  if (!iid || iid <= 0) return null;
  return `#${iid}`;
});

const forgeTitle = computed(() => {
  const project = memberships.value.find(
    (m) => m.projectId === projectId.value,
  )?.project;
  return project?.gitProvider === "github" ? "GitHub" : "GitLab";
});
</script>

<template>
  <a
    v-if="href && label"
    :href="href"
    target="_blank"
    rel="noopener noreferrer"
    class="issue-iid-link hover:underline"
    :class="linkClass"
    :title="`Open ${forgeTitle} ${label}`"
    @click.stop
  >
    {{ label }}
  </a>
  <span v-else-if="label" class="issue-iid-link" :class="linkClass">{{
    label
  }}</span>
</template>
