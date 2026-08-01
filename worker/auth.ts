import type { Env } from "./types";

const COOKIE_NAME = "activity_session";
const DETAILS_COOKIE_NAME = "activity_details_session";
const SESSION_HEADER = "x-activity-session";
const DETAILS_SESSION_HEADER = "x-activity-details-session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

export async function secretEquals(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(signature));
}

function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator === -1) continue;
    result.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  return result;
}

export function dashboardAuthEnabled(env: Env): boolean {
  return Boolean(env.DASHBOARD_PASSWORD);
}

export function detailsAuthEnabled(env: Env): boolean {
  return Boolean(env.DETAILS_PASSWORD);
}

export function authConfigured(env: Env): boolean {
  return (!dashboardAuthEnabled(env) && !detailsAuthEnabled(env)) || Boolean(env.SESSION_SECRET);
}

async function hasSession(
  request: Request,
  env: Env,
  cookieName: string,
  headerName: string,
  signatureScope: string,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return true;
  if (!env.SESSION_SECRET) return false;
  const candidates = [cookies(request).get(cookieName), request.headers.get(headerName)]
    .filter((value): value is string => Boolean(value));
  for (const value of candidates) {
    const separator = value.indexOf(".");
    if (separator === -1) continue;
    const expires = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    if (!/^\d+$/.test(expires) || Number(expires) <= Math.floor(Date.now() / 1000)) continue;
    if (await secretEquals(signature, await sign(`${signatureScope}${expires}`, env.SESSION_SECRET))) return true;
  }
  return false;
}

export function hasDashboardSession(request: Request, env: Env): Promise<boolean> {
  return hasSession(request, env, COOKIE_NAME, SESSION_HEADER, "", dashboardAuthEnabled(env));
}

export function hasDetailsSession(request: Request, env: Env): Promise<boolean> {
  return hasSession(request, env, DETAILS_COOKIE_NAME, DETAILS_SESSION_HEADER, "details:", detailsAuthEnabled(env));
}

async function createSession(cookieName: string, signatureScope: string, secret: string) {
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const signature = await sign(`${signatureScope}${expires}`, secret);
  const value = `${expires}.${signature}`;
  const expiresAt = new Date(Number(expires) * 1000).toUTCString();
  return {
    value,
    cookie: `${cookieName}=${value}; Max-Age=${SESSION_SECONDS}; Expires=${expiresAt}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  };
}

export function createDashboardSession(secret: string) {
  return createSession(COOKIE_NAME, "", secret);
}

export function createDetailsSession(secret: string) {
  return createSession(DETAILS_COOKIE_NAME, "details:", secret);
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearDetailsSessionCookie(): string {
  return `${DETAILS_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function hasIngestAccess(request: Request, env: Env): Promise<boolean> {
  if (!env.INGEST_TOKEN) return false;
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  return secretEquals(authorization.slice(7), env.INGEST_TOKEN);
}
