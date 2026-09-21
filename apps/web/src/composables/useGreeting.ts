import { computed } from "vue";
import { useSessionStore } from "@/stores/session";

/** Time-of-day greeting + display name + today’s date label (en-US). */
export function useGreeting(fallbackName = "there") {
  const session = useSessionStore();

  const greeting = computed(() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  });

  const displayName = computed(() => {
    const me = session.me;
    const name =
      me?.displayName?.trim() ||
      me?.gitlabUsername?.trim() ||
      session.session.username?.trim();
    return name || fallbackName;
  });

  const todayLabel = computed(() =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    }).format(new Date()),
  );

  return { greeting, displayName, todayLabel };
}
