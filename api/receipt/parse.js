/* 영수증 이미지 업로드를 검증하고 OpenRouter 비전 모델을 호출합니다. */
"use strict";

/* 서버가 허용할 영수증 이미지 형식과 크기 제한을 정의합니다. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFAULT_MODEL = "google/gemma-4-26b-a4b-it:free";

/* 서버리스 함수의 메서드, 요청 크기 및 이미지 입력을 확인합니다. */
module.exports = async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, errorPayload("METHOD_NOT_ALLOWED", "POST 요청만 사용할 수 있습니다.", "live"));
  }

  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return sendJson(response, 400, errorPayload("INVALID_IMAGE", "이미지 파일을 multipart/form-data로 전송해 주세요.", "live"));
  }
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return sendJson(response, 413, errorPayload("FILE_TOO_LARGE", "요청 크기가 허용 한도를 초과했습니다.", "live"));
  }

  let rawBody;
  try {
    rawBody = await readRequestBody(request, MAX_REQUEST_BYTES);
  } catch (error) {
    const status = error.code === "FILE_TOO_LARGE" ? 413 : 400;
    const code = error.code === "FILE_TOO_LARGE" ? "FILE_TOO_LARGE" : "INVALID_IMAGE";
    return sendJson(response, status, errorPayload(code, error.message, "live"));
  }

  let image;
  try {
    image = extractImage(rawBody, contentType);
  } catch (error) {
    const status = error.code === "FILE_TOO_LARGE" ? 413 : 400;
    return sendJson(response, status, errorPayload(error.code || "INVALID_IMAGE", error.message, "live"));
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return sendJson(response, 200, demoPayload(
      "OpenRouter API 키가 서버에 설정되지 않았습니다. Vercel 프로젝트의 Environment Variables에 OPENROUTER_API_KEY를 추가하고 다시 배포해 주세요."
    ));
  }

  try {
    const receipt = await requestOpenRouter(image, apiKey);
    if (!receipt || receipt.readable === false) {
      return sendJson(response, 422, errorPayload("RECEIPT_UNREADABLE", "영수증을 읽지 못했습니다. 이미지가 선명하고 전체가 보이는지 확인해 주세요.", "live"));
    }
    return sendJson(response, 200, createSuccessPayload(receipt, "live"));
  } catch (error) {
    console.error("영수증 분석 API 요청 실패:", error.code || "OPENROUTER_REQUEST_FAILED", error.status || "");
    return sendJson(response, 200, demoPayload(describeOpenRouterFailure(error)));
  }
};

/* 서버 요청 본문을 제한 크기까지만 읽고 초과 전송은 중단합니다. */
function readRequestBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received > limit) {
        settled = true;
        reject(createError("FILE_TOO_LARGE", "요청 크기가 허용 한도를 초과했습니다."));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/* multipart 본문에서 image 필드를 찾아 MIME 유형과 파일 크기를 검증합니다. */
function extractImage(body, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch && (boundaryMatch[1] || boundaryMatch[2]).trim();
  if (!boundary || boundary.length > 200) {
    throw createError("INVALID_IMAGE", "이미지 업로드 형식이 올바르지 않습니다.");
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  let cursor = 0;

  while (cursor < body.length) {
    const boundaryStart = body.indexOf(delimiter, cursor);
    if (boundaryStart === -1) break;
    let partStart = boundaryStart + delimiter.length;
    if (body.subarray(partStart, partStart + 2).toString() === "--") break;
    if (body.subarray(partStart, partStart + 2).toString() === "\r\n") partStart += 2;

    const headerEnd = body.indexOf(headerSeparator, partStart);
    if (headerEnd === -1) break;
    const headerText = body.subarray(partStart, headerEnd).toString("utf8");
    const contentStart = headerEnd + headerSeparator.length;
    let nextBoundary = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), contentStart);
    if (nextBoundary === -1) nextBoundary = body.length;
    const partData = body.subarray(contentStart, nextBoundary);
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i);
    const nameMatch = disposition && disposition[1].match(/(?:^|;)\s*name="([^"]*)"/i);
    const mimeMatch = headerText.match(/content-type:\s*([^\r\n;]+)/i);

    if (nameMatch && nameMatch[1] === "image") {
      const mimeType = mimeMatch ? mimeMatch[1].trim().toLowerCase() : "";
      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        throw createError("INVALID_IMAGE", "JPG, PNG 또는 WEBP 이미지 파일만 업로드할 수 있습니다.");
      }
      if (partData.length === 0) {
        throw createError("INVALID_IMAGE", "업로드된 이미지 파일이 비어 있습니다.");
      }
      if (partData.length > MAX_FILE_BYTES) {
        throw createError("FILE_TOO_LARGE", "이미지 파일은 4MB 이하여야 합니다.");
      }
      validateImageSignature(partData, mimeType);
      return { buffer: partData, mimeType };
    }
    cursor = nextBoundary + 2;
  }

  throw createError("INVALID_IMAGE", "요청에서 영수증 이미지(image)를 찾을 수 없습니다.");
}

/* 파일 내용의 시그니처가 선언한 이미지 MIME 유형과 맞는지 확인합니다. */
function validateImageSignature(buffer, mimeType) {
  const isJpeg = mimeType === "image/jpeg" && buffer.length >= 3 &&
    buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = mimeType === "image/png" && buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = mimeType === "image/webp" && buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  if (!isJpeg && !isPng && !isWebp) {
    throw createError("INVALID_IMAGE", "파일 내용과 이미지 형식이 일치하지 않습니다.");
  }
}

/* 서버에서만 환경 변수와 이미지 데이터를 사용해 OpenRouter 비전 요청을 보냅니다. */
async function requestOpenRouter(image, apiKey) {
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const base64Image = image.buffer.toString("base64");
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 45000);

  try {
    const result = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: abortController.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://smart-household-accounting.vercel.app",
        "X-Title": "Smart Household Ledger"
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 1800,
        messages: [
          {
            role: "system",
            content: "당신은 영수증 OCR 도우미입니다. 이미지에 보이는 정보만 추출하고 추측하거나 값을 만들어내지 마세요. 반드시 JSON 객체 하나만 출력하세요. 읽을 수 없는 영수증이면 readable=false를 반환하세요."
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "이 영수증에서 상호명, 결제 일시, 결제 수단, 총 결제금액, 구매 상품을 추출하세요. 상품은 상품명, 수량, 단가, 금액을 포함하세요. 날짜는 ISO 8601 문자열로, 금액은 정수 원 단위로 적으세요. 알 수 없는 값은 null로 두고 상품을 읽을 수 없으면 빈 배열로 둡니다. 아래 형식의 JSON만 반환하세요: {\"readable\":true,\"storeName\":\"문자열 또는 null\",\"purchasedAt\":\"ISO 문자열 또는 null\",\"paymentMethod\":\"문자열 또는 null\",\"totalAmount\":정수 또는 null,\"items\":[{\"name\":\"문자열 또는 null\",\"quantity\":정수 또는 null,\"unitPrice\":정수 또는 null,\"totalPrice\":정수 또는 null}]}"
              },
              {
                type: "image_url",
                image_url: { url: `data:${image.mimeType};base64,${base64Image}` }
              }
            ]
          }
        ]
      })
    });

    if (!result.ok) {
      const error = createError("OPENROUTER_HTTP_ERROR", `OpenRouter returned HTTP ${result.status}`);
      error.status = result.status;
      throw error;
    }
    const responseBody = await result.json();
    const content = responseBody.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      : content;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("OpenRouter response did not contain text");
    }
    const parsed = parseModelJson(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OpenRouter response was not a JSON object");
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

/* 모델이 JSON 앞뒤로 덧붙인 코드 펜스를 제거하고 객체를 읽습니다. */
function parseModelJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("OpenRouter response did not contain JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* 모델 추출값을 화면 계약에 맞추고 필수 정보와 합계를 검증합니다. */
function createSuccessPayload(rawReceipt, mode) {
  const receipt = {
    storeName: nonEmptyString(rawReceipt.storeName),
    purchasedAt: validDateString(rawReceipt.purchasedAt),
    paymentMethod: nonEmptyString(rawReceipt.paymentMethod),
    totalAmount: nonNegativeInteger(rawReceipt.totalAmount),
    items: Array.isArray(rawReceipt.items) ? rawReceipt.items.slice(0, 100).map((item) => ({
      name: nonEmptyString(item?.name),
      quantity: positiveInteger(item?.quantity),
      unitPrice: nonNegativeInteger(item?.unitPrice),
      totalPrice: nonNegativeInteger(item?.totalPrice)
    })) : []
  };

  const missingFields = [];
  if (!receipt.storeName) missingFields.push("상호명");
  if (!receipt.purchasedAt) missingFields.push("결제 일시");
  if (!receipt.paymentMethod) missingFields.push("결제 수단");
  if (receipt.totalAmount === null) missingFields.push("총 결제금액");
  if (receipt.items.length === 0) missingFields.push("구매 항목");
  receipt.items.forEach((item, index) => {
    if (!item.name) missingFields.push(`상품 ${index + 1} 상품명`);
    if (item.quantity === null) missingFields.push(`상품 ${index + 1} 수량`);
    if (item.unitPrice === null) missingFields.push(`상품 ${index + 1} 단가`);
    if (item.totalPrice === null) missingFields.push(`상품 ${index + 1} 금액`);
  });

  const allItemAmountsAvailable = receipt.items.every((item) => item.totalPrice !== null);
  const itemsTotal = allItemAmountsAvailable
    ? receipt.items.reduce((sum, item) => sum + item.totalPrice, 0)
    : null;
  return {
    ok: true,
    mode,
    receipt,
    validation: {
      missingFields,
      itemsTotal,
      amountMismatch: receipt.totalAmount !== null && itemsTotal !== null && receipt.totalAmount !== itemsTotal
    }
  };
}

/* 서버가 제공하는 데모 영수증을 실제 분석 결과와 구분해 반환합니다. */
function demoPayload(reason) {
  return {
    ...createSuccessPayload({
    storeName: "데모 마트",
    purchasedAt: "2026-11-26T10:30:00+09:00",
    paymentMethod: "카드",
    totalAmount: 12500,
    items: [
      { name: "우유", quantity: 1, unitPrice: 2500, totalPrice: 2500 },
      { name: "식빵", quantity: 1, unitPrice: 3000, totalPrice: 3000 },
      { name: "생수 2L", quantity: 2, unitPrice: 1500, totalPrice: 3000 }
    ]
    }, "demo"),
    demoReason: reason
  };
}

/* OpenRouter 연결 실패 원인에 맞는 안전한 점검 안내를 제공합니다. */
function describeOpenRouterFailure(error) {
  if (error.name === "AbortError") {
    return "OpenRouter 응답 시간이 초과되어 샘플 결과를 표시합니다. 잠시 후 다시 시도해 주세요.";
  }
  if (Number.isInteger(error.status)) {
    const messages = {
      400: "OpenRouter가 요청을 거부했습니다. Vercel의 OPENROUTER_MODEL 값과 선택한 모델의 이미지 입력 지원 여부를 확인해 주세요.",
      401: "OpenRouter 인증에 실패했습니다. Vercel의 OPENROUTER_API_KEY가 올바른지 확인해 주세요.",
      402: "OpenRouter 크레딧 또는 사용 한도가 부족합니다. OpenRouter 계정의 잔액과 한도를 확인해 주세요.",
      403: "OpenRouter가 요청을 허용하지 않았습니다. API 키 권한과 모델 접근 권한을 확인해 주세요.",
      404: "OpenRouter에서 모델을 찾지 못했습니다. OPENROUTER_MODEL의 모델 ID를 확인해 주세요.",
      429: "OpenRouter 요청 한도에 도달했습니다. 잠시 기다린 뒤 다시 시도해 주세요."
    };
    return messages[error.status] ||
      `OpenRouter가 HTTP ${error.status} 오류를 반환했습니다. Vercel 함수 로그에서 요청 상태를 확인해 주세요.`;
  }
  if (error instanceof TypeError) {
    return "서버에서 OpenRouter에 연결하지 못했습니다. Vercel 함수 로그와 네트워크 상태를 확인해 주세요.";
  }
  return "OpenRouter 응답을 처리하지 못했습니다. Vercel 함수 로그에서 모델 응답 형식을 확인해 주세요.";
}

/* 표시 문자열과 숫자 응답값을 엄격하게 정리합니다. */
function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : null;
}

/* 날짜를 유효한 ISO 날짜로 제한하고 알 수 없는 값은 누락 처리합니다. */
function validDateString(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/* 금액 및 수량은 안전한 범위의 정수만 허용합니다. */
function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/* 상품 수량은 1 이상의 정수만 허용합니다. */
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/* 정해진 JSON 응답을 상태 코드와 함께 전송합니다. */
function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

/* 예외 상태를 응답 코드와 사용자 메시지를 가진 오류로 만듭니다. */
function errorPayload(code, message, mode) {
  return { ok: false, mode, error: { code, message } };
}

/* 요청 처리 중 분류할 수 있는 오류 코드를 예외에 기록합니다. */
function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
