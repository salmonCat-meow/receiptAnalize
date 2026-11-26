/* 브라우저에서 인증을 시작할 때 필요한 공개 Supabase 설정만 전달합니다. */
"use strict";

const { getSupabaseConfig, handleApiError, sendJson } = require("../lib/supabase.js");

/* 실제 비밀 키는 반환하지 않고 publishable 설정의 준비 상태만 제공합니다. */
module.exports = function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "GET 요청만 사용할 수 있습니다." } });
  }
  try {
    const config = getSupabaseConfig();
    return sendJson(response, 200, {
      configured: true,
      supabaseUrl: config.url,
      publishableKey: config.publishableKey
    });
  } catch (error) {
    return handleApiError(response, error);
  }
};
