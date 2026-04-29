import { Config, discoverDaemonPort } from "./config";

/**
 * Shared daemon API client.  Extracts the repeated fetch+auth+timeout
 * pattern so every feature doesn't re-implement it.
 */
export class DaemonClient {
  private _token?: string;

  constructor(
    private readonly config: Config,
    token?: string,
  ) {
    this._token = token;
  }

  setToken(token: string | undefined): void {
    this._token = token;
  }

  /** POST JSON to a daemon endpoint.  Returns null on any failure. */
  async post<T>(path: string, body?: Record<string, unknown>): Promise<T | null> {
    return this._fetch<T>(path, body);
  }

  /** GET a daemon endpoint.  Returns null on any failure. */
  async get<T>(path: string): Promise<T | null> {
    return this._fetch<T>(path);
  }

  /** PATCH a daemon endpoint.  Returns null on any failure. */
  async patch<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    return this._fetch<T>(path, body, "PATCH");
  }

  /** Build the base URL (re-discovers port each call if needed). */
  async baseUrl(): Promise<string> {
    const port = await discoverDaemonPort(this.config);
    return `http://${this.config.daemonHost}:${port}/v1`;
  }

  private async _fetch<T>(
    path: string,
    body?: Record<string, unknown>,
    method?: "POST" | "PATCH",
  ): Promise<T | null> {
    const base = await this.baseUrl();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this._token) headers["Authorization"] = `Bearer ${this._token}`;
    try {
      const resp = body
        ? await fetch(`${base}${path}`, {
            method: method ?? "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(3000),
          })
        : await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(3000) });
      if (!resp.ok) return null;
      return (await resp.json()) as T;
    } catch {
      return null;
    }
  }
}
