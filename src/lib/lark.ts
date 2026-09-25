import "server-only";
import type { LarkUser } from "@/lib/session";

type LarkResponse<T> = { code: number; msg?: string; data?: T };
const baseUrl = process.env.LARK_BASE_URL || "https://open.larksuite.com";

async function requestLark<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, cache: "no-store" });
  if (!response.ok) throw new Error(`Lark HTTP ${response.status}`);
  const result = (await response.json()) as LarkResponse<T> & T;
  if (result.code !== 0) throw new Error(`Lark API ${result.code}: ${result.msg || "unknown error"}`);
  // The tenant token endpoint returns its fields at the top level; authen endpoints use data.
  return (result.data ?? result) as T;
}

export async function getLarkUser(code: string): Promise<LarkUser> {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Lark credentials are not configured");

  const tenant = await requestLark<{ tenant_access_token: string }>(
    "/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  );
  if (!tenant.tenant_access_token) throw new Error("Lark tenant token is missing");

  const token = await requestLark<{
    access_token: string;
    open_id?: string;
    user_id?: string;
    name?: string;
  }>("/open-apis/authen/v1/oidc/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tenant.tenant_access_token}`,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  if (!token.access_token) throw new Error("Lark user token is missing");

  const profile = await requestLark<{
    open_id?: string;
    user_id?: string;
    name?: string;
    email?: string;
    enterprise_email?: string;
  }>("/open-apis/authen/v1/user_info", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const id = profile.open_id || token.open_id || profile.user_id || token.user_id;
  if (!id) throw new Error("Lark identity is missing");

  return {
    id,
    name: profile.name || token.name,
    email: profile.enterprise_email || profile.email,
  };
}
