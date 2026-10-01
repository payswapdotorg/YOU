export interface YouClientOptions { apiKey?: string; baseUrl?: string }
export class YouClient {
  constructor(public readonly options: YouClientOptions = {}) {}
  async request(path: string, init?: RequestInit) {
    const base = this.options.baseUrl ?? "";
    return fetch(base + path, {
      ...init,
      headers: { "content-type": "application/json", ...(this.options.apiKey ? {"authorization": "Bearer "+this.options.apiKey} : {}), ...(init?.headers ?? {}) }
    });
  }
}
