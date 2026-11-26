/* 로그인한 사용자의 월별 예산을 조회하거나 저장합니다. */
"use strict";

const { createApiError, getAuthenticatedUser, handleApiError, sendJson, supabaseRequest } = require("../lib/supabase.js");

/* 월과 사용자 ID로 예산을 제한해 조회하거나 기존 행을 갱신합니다. */
module.exports = async function handler(request, response) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (request.method === "GET") return await getBudget(request, response, auth);
    if (request.method === "PUT") return await putBudget(request, response, auth);
    response.setHeader("Allow", "GET, PUT");
    return sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "GET 또는 PUT 요청만 사용할 수 있습니다." } });
  } catch (error) {
    return handleApiError(response, error);
  }
};

/* 월별 예산을 확인하고 중복 데이터가 있으면 명시적 오류를 반환합니다. */
async function findBudgets(auth, month) {
  const query = new URLSearchParams({
    select: "*",
    user_id: `eq.${auth.user.id}`,
    year_month: `eq.${month}`,
    limit: "2"
  });
  const result = await supabaseRequest(auth, `budgets?${query.toString()}`);
  const budgets = Array.isArray(result.payload) ? result.payload : [];
  if (budgets.length > 1) {
    throw createApiError(409, "DUPLICATE_BUDGET", "같은 월의 예산 데이터가 중복되어 있습니다. 데이터베이스의 중복 행을 정리해 주세요.");
  }
  return budgets[0] || null;
}

/* 예산 월을 검증하고 사용자 소유의 예산만 조회합니다. */
async function getBudget(request, response, auth) {
  const month = request.query?.month;
  if (!isValidMonth(month)) throw createApiError(400, "INVALID_MONTH", "월은 YYYY-MM 형식이어야 합니다.");
  const budget = await findBudgets(auth, month);
  return sendJson(response, 200, { budget });
}

/* 한 달 예산 행을 조회 후 갱신 또는 삽입하고 생성 결과를 반환합니다. */
async function putBudget(request, response, auth) {
  const input = request.body;
  if (!input || !isValidMonth(input.yearMonth) ||
    !Number.isSafeInteger(input.monthlyBudget) || input.monthlyBudget <= 0) {
    throw createApiError(400, "INVALID_BUDGET", "월은 YYYY-MM, 예산은 1 이상의 정수여야 합니다.");
  }
  const existing = await findBudgets(auth, input.yearMonth);
  if (existing) {
    const query = new URLSearchParams({ id: `eq.${existing.id}`, user_id: `eq.${auth.user.id}` });
    const updated = await supabaseRequest(auth, `budgets?${query.toString()}`, {
      method: "PATCH",
      headers: { "Prefer": "return=representation" },
      body: { monthly_budget: input.monthlyBudget }
    });
    const budget = Array.isArray(updated.payload) ? updated.payload[0] : null;
    if (!budget) throw createApiError(502, "BUDGET_UPDATE_FAILED", "예산 수정 결과를 확인하지 못했습니다.");
    return sendJson(response, 200, { budget });
  }

  const inserted = await supabaseRequest(auth, "budgets", {
    method: "POST",
    headers: { "Prefer": "return=representation" },
    body: {
      user_id: auth.user.id,
      year_month: input.yearMonth,
      monthly_budget: input.monthlyBudget
    }
  });
  const budget = Array.isArray(inserted.payload) ? inserted.payload[0] : null;
  if (!budget) throw createApiError(502, "BUDGET_INSERT_FAILED", "새 예산을 저장하지 못했습니다.");
  return sendJson(response, 201, { budget });
}

/* 월 값이 실제로 존재하는 YYYY-MM 범위인지 검사합니다. */
function isValidMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  return true;
}
