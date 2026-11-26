/* 로그인 사용자가 소유한 지출 한 건과 상품 상세를 조회합니다. */
"use strict";

const { getAuthenticatedUser, handleApiError, sendJson, supabaseRequest } = require("../../lib/supabase.js");

/* 지출 ID 경로를 확인하고 소유 사용자의 상세 행만 반환합니다. */
module.exports = async function handler(request, response) {
  try {
    if (request.method !== "GET" && request.method !== "PATCH") {
      response.setHeader("Allow", "GET, PATCH");
      return sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "GET 또는 PATCH 요청만 사용할 수 있습니다." } });
    }
    const auth = await getAuthenticatedUser(request);
    const id = request.query?.id;
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return sendJson(response, 400, { error: { code: "INVALID_EXPENSE_ID", message: "지출 ID 형식이 올바르지 않습니다." } });
    }
    if (request.method === "PATCH") return await updateExpense(request, response, auth, id);
    const query = new URLSearchParams({
      select: "*,expense_items(*)",
      id: `eq.${id}`,
      user_id: `eq.${auth.user.id}`,
      limit: "1"
    });
    const result = await supabaseRequest(auth, `expenses?${query.toString()}`);
    const expense = Array.isArray(result.payload) ? result.payload[0] : null;
    if (!expense) return sendJson(response, 404, { error: { code: "EXPENSE_NOT_FOUND", message: "지출 내역을 찾을 수 없습니다." } });
    return sendJson(response, 200, { expense, items: expense.expense_items || [] });
  } catch (error) {
    return handleApiError(response, error);
  }
};

/* 지출 합계와 대표 카테고리만 인증된 소유자가 수정하도록 허용합니다. */
async function updateExpense(request, response, auth, id) {
  const input = request.body;
  const categories = new Set(["식비", "교통비", "생활용품비", "문화·여가", "의료비", "쇼핑", "주거·통신", "기타"]);
  if (!input || !categories.has(input.overallCategory) ||
    !Number.isSafeInteger(input.totalAmount) || input.totalAmount < 0) {
    return sendJson(response, 400, { error: { code: "INVALID_EXPENSE", message: "대표 카테고리 또는 지출 합계를 확인해 주세요." } });
  }
  const query = new URLSearchParams({
    id: `eq.${id}`,
    user_id: `eq.${auth.user.id}`
  });
  const result = await supabaseRequest(auth, `expenses?${query.toString()}`, {
    method: "PATCH",
    headers: { "Prefer": "return=representation" },
    body: {
      overall_category: input.overallCategory,
      total_amount: input.totalAmount
    }
  });
  const expense = Array.isArray(result.payload) ? result.payload[0] : null;
  if (!expense) return sendJson(response, 404, { error: { code: "EXPENSE_NOT_FOUND", message: "지출 내역을 찾을 수 없습니다." } });
  return sendJson(response, 200, { expense });
}
