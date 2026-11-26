/* Supabase REST API 설정, 인증 사용자 확인, 요청 및 오류 변환을 공통 처리합니다. */
"use strict";

/* 서버 환경 변수에 설정된 Supabase 연결 정보를 반환합니다. */
function getSupabaseConfig() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
  if (!url || !publishableKey) {
    throw createApiError(503, "SUPABASE_NOT_CONFIGURED", "Supabase 환경 변수가 설정되지 않았습니다.");
  }
  return { url, publishableKey };
}

/* API 응답의 bearer token으로 현재 인증된 사용자를 확인합니다. */
async function getAuthenticatedUser(request) {
  const { url, publishableKey } = getSupabaseConfig();
  const authorization = request.headers.authorization || "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    throw createApiError(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  }

  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      "apikey": publishableKey,
      "Authorization": `Bearer ${tokenMatch[1]}`
    }
  });
  if (!response.ok) {
    throw createApiError(401, "AUTH_INVALID", "로그인 정보가 만료되었거나 올바르지 않습니다.");
  }
  const user = await response.json();
  if (!user || typeof user.id !== "string") {
    throw createApiError(401, "AUTH_INVALID", "인증 사용자 정보를 확인할 수 없습니다.");
  }
  return { user, accessToken: tokenMatch[1], config: { url, publishableKey } };
}

/* 현재 사용자 JWT와 publishable 키로 Supabase REST 요청을 실행합니다. */
async function supabaseRequest(auth, path, options = {}) {
  const headers = {
    "apikey": auth.config.publishableKey,
    "Authorization": `Bearer ${auth.accessToken}`,
    "Accept": "application/json",
    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {})
  };
  const response = await fetch(`${auth.config.url}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const responseText = await response.text();
  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw createApiError(502, "SUPABASE_INVALID_RESPONSE", "Supabase 응답 형식을 확인할 수 없습니다.");
    }
  }
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? payload.message : "Supabase 요청에 실패했습니다.";
    const code = typeof payload?.code === "string" ? payload.code : "SUPABASE_REQUEST_FAILED";
    throw createApiError(response.status >= 400 && response.status < 500 ? response.status : 502, code, message);
  }
  return { payload, headers: response.headers };
}

/* 성공/실패 응답을 일관된 JSON 형식으로 반환합니다. */
function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

/* API 예외를 적절한 HTTP 상태와 계약된 오류 응답으로 변환합니다. */
function handleApiError(response, error) {
  const status = Number.isInteger(error.status) ? error.status : 502;
  const code = error.code || "INTERNAL_ERROR";
  const message = error.message || "요청을 처리하지 못했습니다.";
  if (status >= 500) console.error("가계부 API 오류:", code);
  return sendJson(response, status, { error: { code, message } });
}

/* HTTP 상태와 오류 코드를 갖춘 API 예외를 생성합니다. */
function createApiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = {
  createApiError,
  getAuthenticatedUser,
  getSupabaseConfig,
  handleApiError,
  sendJson,
  supabaseRequest
};
