/** sessionStorage flag — show welcome strip once after Sign in / Register. */
export const POST_LOGIN_GREETING_KEY = "faw.postLoginGreeting";

export function markPostLoginGreeting() {
  try {
    sessionStorage.setItem(POST_LOGIN_GREETING_KEY, "1");
  } catch {
    /* private mode / quota */
  }
}

export function consumePostLoginGreeting(): boolean {
  try {
    if (sessionStorage.getItem(POST_LOGIN_GREETING_KEY) !== "1") return false;
    sessionStorage.removeItem(POST_LOGIN_GREETING_KEY);
    return true;
  } catch {
    return false;
  }
}
