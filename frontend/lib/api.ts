const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Every call goes through here so credentials handling, base URL and error
// shaping live in exactly one place. Components should never call fetch directly.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      // Sends the session cookie cross origin. Needs cors({ credentials: true })
      // on the backend to match; missing either half gives a silent 401.
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("Cannot reach the server. Is the backend running?", 0);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new ApiError(data?.error ?? response.statusText, response.status);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
};

export const authUrls = {
  googleLogin: `${BASE_URL}/api/auth/google`,
  slackConnect: `${BASE_URL}/api/slack/connect`,
  queueDashboard: `${BASE_URL}/admin/queues`,
};
