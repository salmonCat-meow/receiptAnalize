/* 인증된 사용자의 영수증 지출과 상품을 생성하고 조회합니다. */
"use strict";

const {
  createApiError,
  getAuthenticatedUser,
  handleApiError,
  sendJson,
  supabaseRequest
} = require("../lib/supabase.js");
const CATEGORIES = new Set(["식비", "교통비", "생활용품비", "문화·여가", "의료비", "쇼핑", "주거·통신", "기타"]);

/* 사용자 ID와 테이블 소유권을 확인한 뒤 목록 조회 또는 저장을 수행합니다. */
module.exports = async function handler(request, response) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (request.method === "GET") return await listExpenses(request, response, auth);
    if (request.method === "POST") return await createExpense(request, response, auth);
    response.setHeader("Allow", "GET, POST");
    return sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "GET 또는 POST 요청만 사용할 수 있습니다." } });
  } catch (error) {
    return handleApiError(response, error);
  }
};

/* 로그인 사용자의 지출과 연결된 상품을 월/카테고리/검색 조건으로 조회합니다. */
async function listExpenses(request, response, auth) {
  const params = new URLSearchParams({
    select: "*,expense_items(*)",
    user_id: `eq.${auth.user.id}`,
    order: "purchased_at.desc"
  });
  const month = request.query?.month || "";
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    throw createApiError(400, "INVALID_MONTH", "월은 YYYY-MM 형식이어야 합니다.");
  }
  if (month) {
    const start = `${month}-01T00:00:00.000Z`;
    const [year, monthNumber] = month.split("-").map(Number);
    const nextMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString();
    params.set("and", `(purchased_at.gte.${start},purchased_at.lt.${nextMonth})`);
  }
  const result = await supabaseRequest(auth, `expenses?${params.toString()}`);
  let expenses = Array.isArray(result.payload) ? result.payload : [];
  const category = typeof request.query?.category === "string" ? request.query.category : "";
  if (category && CATEGORIES.has(category)) {
    expenses = expenses.filter((expense) =>
      expense.overall_category === category ||
      (expense.expense_items || []).some((item) => item.category === category)
    );
  }
  const search = typeof request.query?.q === "string" ? request.query.q.trim().slice(0, 100).toLocaleLowerCase("ko-KR") : "";
  if (search) {
    expenses = expenses.filter((expense) =>
      [expense.store_name, expense.payment_method, ...(expense.expense_items || []).map((item) => item.name)]
        .some((value) => typeof value === "string" && value.toLocaleLowerCase("ko-KR").includes(search))
    );
  }
  return sendJson(response, 200, { expenses });
}

/* 요청 데이터를 검증하고 지출/상품을 저장하며 상품 저장 실패는 지출 행을 보상 삭제합니다. */
async function createExpense(request, response, auth) {
  const input = request.body;
  const validation = validateExpense(input);
  if (validation) throw createApiError(400, "INVALID_EXPENSE", validation);

  const expenseBody = {
    user_id: auth.user.id,
    store_name: input.storeName.trim(),
    purchased_at: new Date(input.purchasedAt).toISOString(),
    payment_method: input.paymentMethod.trim(),
    overall_category: input.overallCategory,
    total_amount: input.totalAmount,
    receipt_image_url: input.receiptImageUrl || null
  };
  const inserted = await supabaseRequest(auth, "expenses", {
    method: "POST",
    headers: { "Prefer": "return=representation" },
    body: expenseBody
  });
  const expense = Array.isArray(inserted.payload) ? inserted.payload[0] : null;
  if (!expense || typeof expense.id !== "string") {
    throw createApiError(502, "EXPENSE_INSERT_FAILED", "지출 정보를 저장했지만 생성된 지출 ID를 확인하지 못했습니다.");
  }

  const itemRows = input.items.map((item) => ({
    expense_id: expense.id,
    name: item.name.trim(),
    quantity: item.quantity,
    unit_price: item.unitPrice,
    total_price: item.totalPrice,
    category: item.category,
    needs_review: item.needsReview
  }));
  try {
    const itemsResult = await supabaseRequest(auth, "expense_items", {
      method: "POST",
      headers: { "Prefer": "return=representation" },
      body: itemRows
    });
    const items = Array.isArray(itemsResult.payload) ? itemsResult.payload : [];
    if (items.length !== itemRows.length) {
      throw createApiError(502, "ITEM_INSERT_INCOMPLETE", "구매 상품이 모두 저장되지 않았습니다.");
    }
    return sendJson(response, 201, { expense, items });
  } catch (error) {
    try {
      await supabaseRequest(auth, `expenses?id=eq.${encodeURIComponent(expense.id)}&user_id=eq.${encodeURIComponent(auth.user.id)}`, {
        method: "DELETE"
      });
    } catch {
      throw createApiError(502, "PARTIAL_SAVE_CLEANUP_FAILED", "상품 저장에 실패했고 지출 정리도 완료하지 못했습니다. 관리자 확인이 필요합니다.");
    }
    throw error;
  }
}

/* 저장 요청의 영수증, 분류, 항목 값을 기존 테이블 제약에 맞게 검증합니다. */
function validateExpense(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "지출 데이터가 필요합니다.";
  if (typeof input.storeName !== "string" || !input.storeName.trim() || input.storeName.length > 160) return "상호명을 확인해 주세요.";
  if (typeof input.purchasedAt !== "string" || !Number.isFinite(Date.parse(input.purchasedAt))) return "결제 일시를 확인해 주세요.";
  if (typeof input.paymentMethod !== "string" || !input.paymentMethod.trim() || input.paymentMethod.length > 80) return "결제 수단을 확인해 주세요.";
  if (!CATEGORIES.has(input.overallCategory)) return "대표 카테고리를 확인해 주세요.";
  if (!Number.isSafeInteger(input.totalAmount) || input.totalAmount < 0) return "총 결제금액은 0 이상의 정수여야 합니다.";
  if (input.receiptImageUrl !== null && input.receiptImageUrl !== undefined && typeof input.receiptImageUrl !== "string") return "영수증 이미지 주소 형식이 올바르지 않습니다.";
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) return "상품은 1개 이상 100개 이하여야 합니다.";
  for (const item of input.items) {
    if (!item || typeof item.name !== "string" || !item.name.trim() || item.name.length > 160) return "상품명을 확인해 주세요.";
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) return "상품 수량은 1 이상의 정수여야 합니다.";
    if (!Number.isSafeInteger(item.unitPrice) || item.unitPrice < 0) return "상품 단가는 0 이상의 정수여야 합니다.";
    if (!Number.isSafeInteger(item.totalPrice) || item.totalPrice < 0) return "상품 금액은 0 이상의 정수여야 합니다.";
    if (!CATEGORIES.has(item.category)) return "상품 카테고리를 확인해 주세요.";
    if (typeof item.needsReview !== "boolean") return "상품 검토 상태 형식이 올바르지 않습니다.";
  }
  return null;
}
