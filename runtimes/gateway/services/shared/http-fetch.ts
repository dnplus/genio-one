export type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
