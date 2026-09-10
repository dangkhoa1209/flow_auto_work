import { computed } from "vue";
import { useRoute } from "vue-router";

export type ProjectChatSuffix =
  | "chat"
  | "workflow"
  | "tasks"
  | "settings-gitlab"
  | "settings-google"
  | "settings-account";

/** BA (/ba) and QC (/qc) share the same Project chat UI; pick base from the URL. */
export function useProjectChatBase() {
  const route = useRoute();

  const basePath = computed(() =>
    route.path.startsWith("/qc") ? "/qc" : "/ba",
  );

  const routePrefix = computed(() =>
    basePath.value === "/qc" ? "qc" : "ba",
  );

  function routeName(suffix: ProjectChatSuffix): string {
    return `${routePrefix.value}-${suffix}`;
  }

  return { basePath, routePrefix, routeName };
}
