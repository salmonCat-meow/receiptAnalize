/* 인증 사용자 소유 지출의 상품 카테고리와 금액을 갱신합니다. */
"use strict";

const { createApiError, getAuthenticatedUser, handleApiError, sendJson, supabaseRequest } = require("../../../../lib/supabase.js");
const CATEGORIES = new Set(["식비", "교통비", "생활용품비", "문화·여가", "의료비", "쇼핑", "주거·통신", "기타"]);

/* 부모 지출 소유권과 상품 연결을 확인한 뒤 변경 필드만 업데이트합니다. */
module.exports = async function handler(request, response) {
  try {
    if (request.method !== "PATCH") {
      response.setHeader("Allow", "PATCH");
      return sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "PATCH 요청만 사용할 수 있습니다." } });
    }
    const auth = await getAuthenticatedUser(request);
    const expenseId = request.query?.id;
    const itemId = request.query?.itemId;
    if (!isUuid(expenseId) || !isUuid(itemId)) {
      return sendJson(response, 400, { error: { code: "INVALID_ID", message: "지출 또는 상품 ID 형식이 올바르지 않습니다." } });
    }
    const input = request.body;
    const validation = validateItemUpdate(input);
    if (validation) throw createApiError(400, "INVALID_ITEM", validation);

    const expenseQuery = new URLSearchParams({
      select: "id",
      id: `eq.${expenseId}`,
      user_id: `eq.${auth.user.id}`,
      limit: "1"
    });
    const expenseResult = await supabaseRequest(auth, `expenses?${expenseQuery.toString()}`);
    if (!Array.isArray(expenseResult.payload) || !expenseResult.payload[0]) {
      return sendJson(response, 404, { error: { code: "EXPENSE_NOT_FOUND", message: "지출 내역을 찾을 수 없습니다." } });
    }

    const itemQuery = new URLSearchParams({
      id: `eq.${itemId}`,
      expense_id: `eq.${expenseId}`,
      select: "*"
    });
    const update = await supabaseRequest(auth, `expense_items?${itemQuery.toString()}`, {
      method: "PATCH",
      headers: { "Prefer": "return=representation" },
      body: {
        category: input.category,
        quantity: input.quantity,
        unit_price: input.unitPrice,
        total_price: input.totalPrice,
        needs_review: input.needsReview
      }
    });
    const item = Array.isArray(update.payload) ? update.payload[0] : null;
    if (!item) return sendJson(response, 404, { error: { code: "ITEM_NOT_FOUND", message: "구매 상품을 찾을 수 없습니다." } });
    return sendJson(response, 200, { item });
  } catch (error) {
    return handleApiError(response, error);
  }
};

/* 상품 업데이트 입력을 기존 expense_items 컬럼 타입으로 확인합니다. */
function validateItemUpdate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "상품 수정 데이터가 필요합니다.";
  if (!CATEGORIES.has(input.category)) return "상품 카테고리를 확인해 주세요.";
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) return "수량은 1 이상의 정수여야 합니다.";
  if (!Number.isSafeInteger(input.unitPrice) || input.unitPrice < 0) return "단가는 0 이상의 정수여야 합니다.";
  if (!Number.isSafeInteger(input.totalPrice) || input.totalPrice < 0) return "금액은 0 이상의 정수여야 합니다.";
  if (typeof input.needsReview !== "boolean") return "검토 상태가 올바르지 않습니다.";
  return null;
}

/* UUID 경로 변수가 올바른 형식인지 검증합니다. */
function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
