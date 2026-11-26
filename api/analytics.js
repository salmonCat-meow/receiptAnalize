/* 로그인 사용자의 월별 지출을 조회해 중복 없는 카테고리/일자 집계를 계산합니다. */
"use strict";

const { createApiError, getAuthenticatedUser, handleApiError, sendJson, supabaseRequest } = require("../lib/supabase.js");

/* 선택 월 지출과 상품 행을 읽고 분석 차트가 사용할 집계를 반환합니다. */
module.exports = async function handler(request, response) {
  try {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "GET 요청만 사용할 수 있습니다." } });
    }
    const auth = await getAuthenticatedUser(request);
    const month = request.query?.month;
    if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw createApiError(400, "INVALID_MONTH", "월은 YYYY-MM 형식이어야 합니다.");
    }
    const [year, monthNumber] = month.split("-").map(Number);
    const start = `${month}-01T00:00:00.000Z`;
    const end = new Date(Date.UTC(year, monthNumber, 1)).toISOString();
    const query = new URLSearchParams({
      select: "id,user_id,purchased_at,total_amount,overall_category,store_name,expense_items(*)",
      user_id: `eq.${auth.user.id}`,
      and: `(purchased_at.gte.${start},purchased_at.lt.${end})`,
      order: "purchased_at.asc"
    });
    const result = await supabaseRequest(auth, `expenses?${query.toString()}`);
    const expenses = Array.isArray(result.payload) ? result.payload : [];
    return sendJson(response, 200, { analytics: aggregateExpenses(expenses, year, monthNumber) });
  } catch (error) {
    return handleApiError(response, error);
  }
};

/* 영수증 총액을 카테고리에 한 번만 배분하고 상품 표는 검토/과다 목록에 사용합니다. */
function aggregateExpenses(expenses, year, monthNumber) {
  const categoryTotals = new Map();
  const dailyTotals = new Map();
  const overspendingItems = [];
  let totalAmount = 0;
  let needsReviewCount = 0;
  for (const expense of expenses) {
    const amount = safeAmount(expense.total_amount);
    totalAmount += amount;
    const category = typeof expense.overall_category === "string" && expense.overall_category
      ? expense.overall_category
      : "기타";
    categoryTotals.set(category, (categoryTotals.get(category) || 0) + amount);
    const day = new Date(expense.purchased_at).getUTCDate();
    dailyTotals.set(day, (dailyTotals.get(day) || 0) + amount);

    for (const item of Array.isArray(expense.expense_items) ? expense.expense_items : []) {
      if (item.needs_review) needsReviewCount += 1;
      if (item.needs_review || safeAmount(item.total_price) > 50000) {
        overspendingItems.push({
          expenseId: expense.id,
          storeName: expense.store_name,
          name: item.name,
          category: item.category || "기타",
          amount: safeAmount(item.total_price),
          needsReview: Boolean(item.needs_review)
        });
      }
    }
  }
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const today = new Date();
  const elapsedDays = today.getUTCFullYear() === year && today.getUTCMonth() + 1 === monthNumber
    ? today.getUTCDate()
    : daysInMonth;
  const categories = [...categoryTotals.entries()]
    .map(([category, amount]) => ({
      category,
      amount,
      share: totalAmount > 0 ? amount / totalAmount : 0
    }))
    .sort((first, second) => second.amount - first.amount);
  return {
    month: `${year}-${String(monthNumber).padStart(2, "0")}`,
    totalAmount,
    receiptCount: expenses.length,
    dailyAverage: elapsedDays > 0 ? Math.round(totalAmount / elapsedDays) : 0,
    elapsedDays,
    daysInMonth,
    needsReviewCount,
    categories,
    daily: [...dailyTotals.entries()]
      .sort((first, second) => first[0] - second[0])
      .map(([day, amount]) => ({ day, amount })),
    overspendingItems: overspendingItems.sort((first, second) => second.amount - first.amount)
  };
}

/* 잘못된 금액이 집계에 영향을 주지 않도록 안전한 정수만 사용합니다. */
function safeAmount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
