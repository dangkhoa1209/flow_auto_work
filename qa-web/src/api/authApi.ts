import { request } from "./http";

export type AuthTokensResponse = {
  user: { gitlabUsername?: string; username?: string };
  memberships?: Array<{
    projectId: string;
    project?: { id: string; displayName?: string; gitlabPath?: string };
  }>;
  activeProjectId?: string | null;
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  accessExpiresAt?: number;
};

/** Same Flow auth endpoints as coding web (`web/src/api/authApi.ts`). */
export const authApi = {
  login(username: string, password: string) {
    return request<AuthTokensResponse>({
      url: "/api/auth/login",
      method: "POST",
      data: { username, password },
    });
  },

  register(opts: {
    username: string;
    password: string;
    displayName?: string;
  }) {
    return request<AuthTokensResponse>({
      url: "/api/auth/register",
      method: "POST",
      data: opts,
    });
  },

  refresh(refreshToken: string) {
    return request<AuthTokensResponse>({
      url: "/api/auth/refresh",
      method: "POST",
      data: { refreshToken },
    });
  },

  logout(refreshToken: string) {
    return request<{ ok?: boolean }>({
      url: "/api/auth/logout",
      method: "POST",
      data: { refreshToken },
    });
  },
};
