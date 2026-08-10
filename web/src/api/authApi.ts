import { API } from "./endpoints";
import { request } from "./http";

export type AuthTokensResponse = {
  user: {
    gitlabUsername?: string;
    username?: string;
    roles?: string[];
  };
  memberships?: Array<{
    projectId: string;
    project?: { id: string; gitlabPath?: string };
  }>;
  activeProjectId?: string | null;
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  accessExpiresAt?: number;
};

export const authApi = {
  login(username: string, password: string) {
    return request<AuthTokensResponse>({
      url: API.auth.login,
      method: "POST",
      data: { username, password },
      skipAuth: true,
      skipRefresh: true,
    });
  },

  register(opts: {
    username: string;
    password: string;
    displayName?: string;
    role?: string;
  }) {
    return request<AuthTokensResponse>({
      url: API.auth.register,
      method: "POST",
      data: opts,
      skipAuth: true,
      skipRefresh: true,
    });
  },

  refresh(refreshToken: string) {
    return request<AuthTokensResponse>({
      url: API.auth.refresh,
      method: "POST",
      data: { refreshToken },
      skipAuth: true,
      skipRefresh: true,
    });
  },

  logout(refreshToken: string) {
    return request<{ ok?: boolean }>({
      url: API.auth.logout,
      method: "POST",
      data: { refreshToken },
      skipAuth: true,
      skipRefresh: true,
    });
  },
};
