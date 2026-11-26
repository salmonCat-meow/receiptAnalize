/* 영수증 파일 업로드, 서버 분석, 결과 수정 흐름을 관리합니다. */
(() => {
  "use strict";

  /* 업로드 제한과 결과 검토에 필요한 상태를 보관합니다. */
  const MAX_FILES = 5;
  const MAX_BYTES = 4 * 1024 * 1024;
  const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const CATEGORIES = ["식비", "교통비", "생활용품비", "문화·여가", "의료비", "쇼핑", "주거·통신", "기타"];
  const state = {
    files: [],
    results: [],
    nextId: 1,
    busy: false,
    toastTimer: null,
    session: null,
    supabase: null,
    authMode: "login",
    dataMode: "demo",
    expenses: [],
    budget: null,
    currentExpense: null,
    currentView: "upload",
    categoryReviewComplete: false,
    searchQuery: "",
    demoExpenses: createDemoExpenses()
  };

  /* 화면에서 반복해서 사용하는 DOM 요소를 가져옵니다. */
  const elements = {
    input: document.querySelector("#receipt-input"),
    dropzone: document.querySelector("#dropzone"),
    previewList: document.querySelector("#preview-list"),
    emptyPreview: document.querySelector("#empty-preview"),
    fileCount: document.querySelector("#file-count"),
    analyzeButton: document.querySelector("#analyze-button"),
    uploadError: document.querySelector("#upload-error"),
    progressPanel: document.querySelector("#progress-panel"),
    progressTitle: document.querySelector("#progress-title"),
    progressDescription: document.querySelector("#progress-description"),
    progressSteps: [...document.querySelectorAll(".progress-step")],
    progressBar: document.querySelector("#progress-bar"),
    resultsSection: document.querySelector("#results-section"),
    resultsList: document.querySelector("#results-list"),
    categorizeButton: document.querySelector("#categorize-button"),
    reviewButton: document.querySelector("#review-button"),
    saveExpensesButton: document.querySelector("#save-expenses-button"),
    reviewMessage: document.querySelector("#review-message"),
    toast: document.querySelector("#toast"),
    menuButton: document.querySelector("#menu-button"),
    sidebar: document.querySelector("#sidebar"),
    sidebarBackdrop: document.querySelector("#sidebar-backdrop"),
    connectionStatus: document.querySelector("#connection-status"),
    profileButton: document.querySelector("#profile-button"),
    authForm: document.querySelector("#auth-form"),
    authError: document.querySelector("#auth-error"),
    authTitle: document.querySelector("#auth-title"),
    authSubmit: document.querySelector("#auth-submit"),
    authModeToggle: document.querySelector("#auth-mode-toggle"),
    authSwitchText: document.querySelector("#auth-switch-text"),
    globalSearch: document.querySelector("#global-search")
  };

  /* 입력 파일의 종류와 크기를 검사하고 선택 목록에 추가합니다. */
  function addFiles(fileList) {
    const incoming = [...fileList];
    const errors = [];
    for (const file of incoming) {
      if (!ALLOWED_TYPES.has(file.type)) {
        errors.push(`${file.name}: JPG, PNG 또는 WEBP 파일만 사용할 수 있어요.`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        errors.push(`${file.name}: 파일 크기는 4MB 이하여야 해요.`);
        continue;
      }
      if (state.files.length >= MAX_FILES) {
        errors.push(`영수증은 최대 ${MAX_FILES}장까지 추가할 수 있어요.`);
        break;
      }
      state.files.push({ id: state.nextId++, file, previewUrl: URL.createObjectURL(file) });
    }
    showUploadError(errors.join(" "));
    renderPreviews();
  }

  /* 업로드 상태와 접근성 정보를 화면에 갱신합니다. */
  function renderPreviews() {
    elements.previewList.querySelectorAll(".preview-card").forEach((card) => card.remove());
    elements.emptyPreview.hidden = state.files.length > 0;
    elements.fileCount.textContent = String(state.files.length);
    elements.analyzeButton.disabled = state.files.length === 0 || state.busy;

    for (const entry of state.files) {
      const card = document.createElement("figure");
      card.className = "preview-card";
      const image = document.createElement("img");
      image.src = entry.previewUrl;
      image.alt = `${entry.file.name} 미리보기`;
      const caption = document.createElement("figcaption");
      caption.textContent = entry.file.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-file";
      remove.setAttribute("aria-label", `${entry.file.name} 삭제`);
      remove.textContent = "×";
      remove.addEventListener("click", () => removeFile(entry.id));
      card.append(image, caption, remove);
      elements.previewList.append(card);
    }
  }

  /* 파일을 목록에서 제거하고 브라우저 임시 미리보기 주소를 정리합니다. */
  function removeFile(id) {
    const entry = state.files.find((item) => item.id === id);
    if (entry) URL.revokeObjectURL(entry.previewUrl);
    state.files = state.files.filter((item) => item.id !== id);
    showUploadError("");
    renderPreviews();
  }

  /* 업로드 오류를 화면과 보조기술에 전달합니다. */
  function showUploadError(message) {
    elements.uploadError.textContent = message;
    elements.uploadError.hidden = !message;
  }

  /* 현재 분석 진행 단계를 시각적으로 표시합니다. */
  function setProgress(stepIndex, title, description) {
    elements.progressTitle.textContent = title;
    elements.progressDescription.textContent = description;
    elements.progressSteps.forEach((step, index) => {
      step.classList.toggle("active", index === stepIndex);
      step.classList.toggle("done", index < stepIndex);
    });
    elements.progressBar.style.width = `${Math.max(8, ((stepIndex + 1) / elements.progressSteps.length) * 100)}%`;
  }

  /* 각 이미지 파일을 서버리스 인식 API에 보내 결과 또는 오류를 받습니다. */
  async function parseReceipt(entry) {
    const body = new FormData();
    body.append("image", entry.file, entry.file.name);
    const response = await fetch("/api/receipt/parse", { method: "POST", body });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(
        `영수증 분석 API가 JSON이 아닌 응답을 보냈어요 (HTTP ${response.status}). ` +
        "정적 서버 대신 node .\\dev-server.js로 실행했는지 확인해 주세요."
      );
    }
    if (!response.ok || !payload || payload.ok !== true) {
      const message = payload?.error?.message || "영수증 분석에 실패했어요. 다시 시도해 주세요.";
      const error = new Error(message);
      error.code = payload?.error?.code || "MODEL_ERROR";
      throw error;
    }
    return payload;
  }

  /* 확정 전 영수증 메타데이터와 상품 목록을 서버 분류 API에 보냅니다. */
  async function categorizeReceipt(result) {
    const response = await fetch("/api/receipt/categorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        receipt: {
          ...result.payload.receipt,
          items: result.payload.receipt.items.map(({ name, quantity, unitPrice, totalPrice }) => ({
            name, quantity, unitPrice, totalPrice
          }))
        }
      })
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("카테고리 분류 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
    if (!response.ok || !payload || payload.ok !== true) {
      throw new Error(payload?.error?.message || "카테고리 분류에 실패했어요. 다시 시도해 주세요.");
    }
    if (!CATEGORIES.includes(payload.overallCategory) || !Array.isArray(payload.items) ||
      payload.items.length !== result.payload.receipt.items.length ||
      payload.items.some((item) => !CATEGORIES.includes(item.category))) {
      throw new Error("분류 결과 형식이 올바르지 않아요. 다시 분류해 주세요.");
    }
    return payload;
  }

  /* 인식 결과를 분류하고 사용자 편집 상태를 보존해 카테고리를 병합합니다. */
  async function categorizeReceipts() {
    if (state.busy || state.results.length === 0) return;
    const candidates = state.results.filter((result) => result.payload);
    if (candidates.length === 0) {
      showToast("먼저 영수증 인식을 완료해 주세요.");
      return;
    }
    state.busy = true;
    state.categoryReviewComplete = false;
    elements.saveExpensesButton.hidden = true;
    elements.categorizeButton.disabled = true;
    elements.reviewButton.disabled = true;
    elements.progressPanel.hidden = false;
    setNavigationStep("categorize");
    elements.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });

    for (let index = 0; index < candidates.length; index += 1) {
      const result = candidates[index];
      setProgress(0, `영수증 ${index + 1}/${candidates.length} 분류 중`, "대표 카테고리와 상품별 지출 항목을 제안하고 있어요.");
      try {
        setProgress(1, "상품명과 영수증 정보를 바탕으로 분류 중", result.payload.receipt.storeName || result.entry.file.name);
        const payload = await categorizeReceipt(result);
        const previousClassification = result.classification;
        result.classification = {
          mode: payload.mode === "demo" ? "demo" : "live",
          overallCategory: previousClassification?.overallCategoryReviewed
            ? previousClassification.overallCategory
            : payload.overallCategory,
          overallConfidence: payload.overallConfidence,
          overallNeedsReview: previousClassification?.overallCategoryReviewed
            ? false
            : payload.overallNeedsReview === true,
          overallCategoryReviewed: previousClassification?.overallCategoryReviewed === true,
          overallEditing: false
        };
        result.classificationError = null;
        result.payload.receipt.items = result.payload.receipt.items.map((item, itemIndex) => {
          const suggestion = payload.items[itemIndex];
          return {
            ...item,
            category: item.categoryReviewed ? item.category : suggestion.category,
            confidence: suggestion.confidence,
            classificationNeedsReview: item.categoryReviewed
              ? item.classificationNeedsReview
              : suggestion.confidence === null || suggestion.confidence < 0.65,
            categoryReviewed: item.categoryReviewed === true,
            categoryEditing: false,
            categoryDraft: null
          };
        });
        result.classification.validation = payload.validation;
        updateCategoryReviewFlags(result);
        state.categoryReviewComplete = false;
        elements.saveExpensesButton.hidden = true;
        setProgress(3, "상품별 검토 상태를 확인했어요", "분류 제안을 검토하고 필요하면 수정해 주세요.");
      } catch (error) {
        result.classificationError = error.message;
      }
      renderResults();
    }

    state.busy = false;
    elements.progressPanel.hidden = true;
    elements.categorizeButton.disabled = false;
    elements.reviewButton.disabled = false;
    elements.categorizeButton.innerHTML = "카테고리 다시 분류 <span aria-hidden=\"true\">↻</span>";
    setNavigationStep("categorize");
    updateReviewStatus();
  }

  /* 선택된 영수증을 한 장씩 분석해 개별 성공과 실패를 기록합니다. */
  async function analyzeReceipts() {
    if (state.busy || state.files.length === 0) return;
    state.busy = true;
    state.results = [];
    elements.resultsList.replaceChildren();
    elements.resultsSection.hidden = true;
    elements.progressPanel.hidden = false;
    elements.analyzeButton.disabled = true;
    elements.reviewButton.disabled = true;
    showUploadError("");
    setNavigationStep("analyze");

    const entries = [...state.files];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      setProgress(0, `영수증 ${index + 1}/${entries.length} 이미지 확인 중`, entry.file.name);
      await delay(350);
      try {
        setProgress(1, "영수증의 정보를 읽고 있어요", "상호명과 결제 정보를 확인하고 있어요.");
        await delay(300);
        setProgress(2, "구매 항목을 정리하고 있어요", "상품별 수량과 금액을 확인하고 있어요.");
        const result = await parseReceipt(entry);
        setProgress(3, "금액과 필수 정보를 확인하고 있어요", "분석 결과를 검토할 수 있도록 정리하고 있어요.");
        state.results.push({ id: entry.id, entry, payload: normalizePayload(result), error: null });
      } catch (error) {
        state.results.push({ id: entry.id, entry, payload: null, error: error.message });
      }
      renderResults();
    }

    state.busy = false;
    elements.analyzeButton.disabled = state.files.length === 0;
    elements.progressPanel.hidden = true;
    elements.resultsSection.hidden = false;
    elements.reviewButton.disabled = false;
    setNavigationStep("review");
    elements.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
    updateReviewStatus();
  }

  /* API 응답의 필수 형태를 확인하고 화면 편집용 데이터로 정리합니다. */
  function normalizePayload(payload) {
    const receipt = payload.receipt || {};
    const items = Array.isArray(receipt.items) ? receipt.items.map((item) => ({
      name: item.name ?? "",
      quantity: finiteNumber(item.quantity),
      unitPrice: finiteNumber(item.unitPrice),
    totalPrice: finiteNumber(item.totalPrice),
    category: null,
    confidence: null,
    classificationNeedsReview: false,
    categoryReviewed: false
    })) : [];
    return {
      mode: payload.mode === "demo" ? "demo" : "live",
      receipt: {
        storeName: receipt.storeName ?? "",
        purchasedAt: receipt.purchasedAt ?? "",
        paymentMethod: receipt.paymentMethod ?? "",
        totalAmount: finiteNumber(receipt.totalAmount),
        items
      },
      validation: {
        missingFields: Array.isArray(payload.validation?.missingFields) ? payload.validation.missingFields : [],
        itemsTotal: finiteNumber(payload.validation?.itemsTotal),
        amountMismatch: payload.validation?.amountMismatch === true
      }
    };
  }

  /* API에서 받은 수치 값을 안전한 정수 또는 빈 값으로 변환합니다. */
  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }

  /* 입력 필드와 상품 편집표를 포함한 분석 결과 카드를 생성합니다. */
  function renderResults() {
    elements.resultsList.replaceChildren();
    for (const result of state.results) {
      const card = document.createElement("article");
      card.className = "result-card";
      card.dataset.resultId = String(result.id);
      const header = document.createElement("div");
      header.className = "result-card-header";
      const title = document.createElement("strong");
      title.textContent = result.entry.file.name;
      header.append(title);
      if (result.error) {
        const badge = document.createElement("span");
        badge.className = "error-badge";
        badge.textContent = "인식 실패";
        header.append(badge);
        const body = document.createElement("div");
        body.className = "result-body";
        const image = createResultImage(result.entry);
        const content = document.createElement("div");
        content.className = "result-content";
        const alert = document.createElement("div");
        alert.className = "alert-box";
        alert.textContent = `${result.error} 이미지가 잘리거나 흐린지 확인한 뒤 다시 분석해 주세요.`;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "button button-outline";
        retry.textContent = "다시 시도";
        retry.addEventListener("click", () => retryResult(result.id));
        content.append(alert, retry);
        body.append(image, content);
        card.append(header, body);
        elements.resultsList.append(card);
        continue;
      }

      const badge = document.createElement("span");
      badge.className = `mode-badge${result.payload.mode === "demo" ? " demo" : ""}`;
      badge.textContent = result.payload.mode === "demo" ? "데모 분석 결과" : "AI 인식 완료";
      header.append(badge);
      const body = document.createElement("div");
      body.className = "result-body";
      const image = createResultImage(result.entry);
      const content = document.createElement("div");
      content.className = "result-content";
      if (result.classificationError) {
        const categoryError = document.createElement("div");
        categoryError.className = "alert-box";
        categoryError.textContent = `카테고리 분류에 실패했어요: ${result.classificationError}`;
        content.append(categoryError);
      }
      if (result.payload.mode === "demo") {
        const notice = document.createElement("div");
        notice.className = "demo-notice";
        notice.textContent = `데모 모드: 샘플 분석 결과입니다. 실제 영수증에서 추출한 값이 아닙니다. ${
          result.payload.demoReason || "저장 전 내용을 직접 확인해 주세요."
        }`;
        content.append(notice);
      }
      const validation = getValidation(result.payload);
      if (validation.missing.length > 0) {
        const alert = document.createElement("div");
        alert.className = "alert-box";
        alert.textContent = `필수 정보가 누락되었어요: ${validation.missing.join(", ")}. 영수증을 확인해 직접 입력해 주세요.`;
        content.append(alert);
      }
      const fields = document.createElement("div");
      fields.className = "receipt-fields";
      const fieldDefinitions = [
        ["storeName", "상호명", "text", "예: 동네 마트"],
        ["purchasedAt", "결제 일시", "datetime-local", ""],
        ["paymentMethod", "결제 수단", "text", "예: 카드"],
        ["totalAmount", "총 결제금액 (원)", "number", "0"]
      ];
      for (const [key, label, type, placeholder] of fieldDefinitions) {
        fields.append(createField(result.id, key, label, type, placeholder, result.payload.receipt[key], isReceiptFieldMissing(result.payload.receipt, key)));
      }
      content.append(fields);
      if (result.classification) content.append(createCategorySection(result));
      content.append(createItemsSection(result));
      if (validation.mismatch) {
        const warning = document.createElement("div");
        warning.className = "warning-box";
        warning.textContent = `⚠️ 확인 필요 — 상품 금액 합계 ${formatWon(validation.itemsTotal)}원과 총 결제금액이 일치하지 않아요.`;
        content.append(warning);
      }
      body.append(image, content);
      card.append(header, body);
      elements.resultsList.append(card);
    }
  }

  /* 검토용 이미지 미리보기 또는 읽기 실패 대체 UI를 만듭니다. */
  function createResultImage(entry) {
    const wrap = document.createElement("div");
    wrap.className = "result-image-wrap";
    const image = document.createElement("img");
    image.src = entry.previewUrl;
    image.alt = `${entry.file.name} 영수증 미리보기`;
    wrap.append(image);
    return wrap;
  }

  /* 날짜 및 금액 필드 하나를 라벨과 함께 생성합니다. */
  function createField(resultId, key, labelText, type, placeholder, value, invalid) {
    const wrapper = document.createElement("div");
    wrapper.className = "field";
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = type;
    input.dataset.resultId = String(resultId);
    input.dataset.field = key;
    input.placeholder = placeholder;
    if (invalid) input.setAttribute("aria-invalid", "true");
    if (type === "number") {
      input.min = "0";
      input.step = "1";
      input.inputMode = "numeric";
    }
    const displayValue = key === "purchasedAt" ? toLocalDateTime(value) : value ?? "";
    input.value = String(displayValue);
    label.textContent = labelText;
    label.htmlFor = `field-${resultId}-${key}`;
    input.id = label.htmlFor;
    input.addEventListener("input", () => updateReceiptField(resultId, key, input.value));
    wrapper.append(label, input);
    return wrapper;
  }

  /* 대표 카테고리 제안과 신뢰도 및 검토/수정 동작을 표시합니다. */
  function createCategorySection(result) {
    const classification = result.classification;
    const section = document.createElement("section");
    section.className = "category-summary";
    const title = document.createElement("div");
    title.className = "category-summary-title";
    title.textContent = "대표 카테고리";
    const controls = document.createElement("div");
    controls.className = "category-summary-controls";

    if (classification.overallEditing) {
      const select = createCategorySelect(classification.overallDraft || classification.overallCategory, "대표 카테고리 선택");
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "button button-outline category-action";
      apply.textContent = "적용";
      apply.addEventListener("click", () => applyOverallCategory(result.id, select.value));
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "text-button small";
      cancel.textContent = "취소";
      cancel.addEventListener("click", () => {
        classification.overallEditing = false;
        classification.overallDraft = null;
        renderResults();
      });
      controls.append(select, apply, cancel);
    } else {
      const badge = document.createElement("span");
      badge.className = "category-chip";
      badge.textContent = classification.overallCategory;
      controls.append(badge);
      const confidence = document.createElement("span");
      confidence.className = "confidence-label";
      confidence.textContent = classification.overallCategoryReviewed
        ? "사용자 확정"
        : classification.overallConfidence === null
          ? "신뢰도 확인 필요"
          : `AI 제안 · ${Math.round(classification.overallConfidence * 100)}%`;
      controls.append(confidence);
      if (isOverallCategoryNeedsReview(classification)) {
        const review = document.createElement("span");
        review.className = "warning-badge";
        review.textContent = "분류 확인 필요";
        controls.append(review);
      }
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "text-button small";
      edit.textContent = "카테고리 수정";
      edit.addEventListener("click", () => {
        classification.overallEditing = true;
        classification.overallDraft = classification.overallCategory;
        renderResults();
      });
      controls.append(edit);
    }

    section.append(title, controls);
    return section;
  }

  /* 상품 행과 수정/삭제/추가 기능 및 합계 요약을 만듭니다. */
  function createItemsSection(result) {
    const section = document.createElement("section");
    const heading = document.createElement("div");
    heading.className = "items-heading";
    const title = document.createElement("h3");
    title.textContent = `인식된 구매 항목 (${result.payload.receipt.items.length})`;
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "text-button small";
    addButton.textContent = "＋ 항목 추가";
    addButton.addEventListener("click", () => addItem(result.id));
    heading.append(title, addButton);

    const tableWrap = document.createElement("div");
    tableWrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "items-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const headers = ["상품명", "수량", "단가", "금액"];
    if (result.classification) headers.push("카테고리");
    headers.push("삭제");
    for (const label of headers) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = document.createElement("tbody");
    result.payload.receipt.items.forEach((item, index) => tbody.append(createItemRow(result, item, index)));
    table.append(thead, tbody);
    tableWrap.append(table);

    const totals = document.createElement("div");
    const validation = getValidation(result.payload);
    totals.className = `totals-row${validation.mismatch ? " mismatch" : ""}`;
    const itemTotal = document.createElement("span");
    itemTotal.textContent = `상품 합계 ${formatWon(validation.itemsTotal)}원`;
    const receiptTotal = document.createElement("strong");
    receiptTotal.textContent = `총 결제금액 ${formatWon(result.payload.receipt.totalAmount)}원`;
    totals.append(itemTotal, receiptTotal);
    section.append(heading, tableWrap, totals);
    return section;
  }

  /* 상품의 입력 필드와 삭제 버튼을 한 행으로 구성합니다. */
  function createItemRow(result, item, index) {
    const resultId = result.id;
    const row = document.createElement("tr");
    const definitions = [
      ["name", "text", item.name, "상품명"],
      ["quantity", "number", item.quantity, "0"],
      ["unitPrice", "number", item.unitPrice, "0"],
      ["totalPrice", "number", item.totalPrice, "0"]
    ];
    for (const [key, type, value, placeholder] of definitions) {
      const cell = document.createElement("td");
      const input = document.createElement("input");
      input.className = `item-input${type === "number" ? " numeric" : ""}`;
      input.type = type;
      input.value = value ?? "";
      input.placeholder = placeholder;
      input.dataset.resultId = String(resultId);
      input.dataset.itemIndex = String(index);
      input.dataset.itemField = key;
      input.setAttribute("aria-label", `상품 ${index + 1} ${placeholder}`);
      const invalid = key === "name" ? !String(value ?? "").trim()
        : key === "quantity" ? value === null || value <= 0
          : value === null || value < 0;
      if (invalid) input.setAttribute("aria-invalid", "true");
      if (type === "number") {
        input.min = "0";
        input.step = "1";
        input.inputMode = "numeric";
      }
      input.addEventListener("input", () => updateItemField(resultId, index, key, input.value));
      cell.append(input);
      row.append(cell);
    }
    if (result.classification) {
      const categoryCell = document.createElement("td");
      categoryCell.className = "category-cell";
      if (item.categoryEditing) {
        const editor = document.createElement("div");
        editor.className = "item-category-editor";
        const select = createCategorySelect(item.categoryDraft || item.category, `상품 ${index + 1} 카테고리 선택`);
        const apply = document.createElement("button");
        apply.type = "button";
        apply.className = "category-apply";
        apply.textContent = "적용";
        apply.addEventListener("click", () => applyItemCategory(resultId, index, select.value));
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "category-cancel";
        cancel.textContent = "취소";
        cancel.addEventListener("click", () => {
          item.categoryEditing = false;
          item.categoryDraft = null;
          renderResults();
        });
        editor.append(select, apply, cancel);
        categoryCell.append(editor);
      } else {
        const chip = document.createElement("span");
        chip.className = "category-chip";
        chip.textContent = item.category || "기타";
        categoryCell.append(chip);
        const confidence = document.createElement("span");
        confidence.className = "confidence-label";
        confidence.textContent = item.categoryReviewed
          ? "사용자 확정"
          : item.confidence === null
            ? "신뢰도 확인 필요"
            : `AI 제안 · ${Math.round(item.confidence * 100)}%`;
        categoryCell.append(confidence);
        if (isItemNeedsReview(result, item)) {
          const warning = document.createElement("span");
          warning.className = "warning-badge item-warning";
          warning.textContent = "검토 필요";
          categoryCell.append(warning);
        }
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "text-button small item-category-edit";
        edit.textContent = "수정";
        edit.addEventListener("click", () => {
          item.categoryEditing = true;
          item.categoryDraft = item.category || "기타";
          renderResults();
        });
        categoryCell.append(edit);
      }
      row.append(categoryCell);
    }
    const action = document.createElement("td");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-item";
    remove.setAttribute("aria-label", `상품 ${index + 1} 삭제`);
    remove.textContent = "×";
    remove.addEventListener("click", () => deleteItem(resultId, index));
    action.append(remove);
    row.append(action);
    return row;
  }

  /* 허용 카테고리만 선택할 수 있는 공통 선택 컨트롤을 만듭니다. */
  function createCategorySelect(selected, label) {
    const select = document.createElement("select");
    select.className = "category-select";
    select.setAttribute("aria-label", label);
    for (const category of CATEGORIES) {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      option.selected = category === selected;
      select.append(option);
    }
    return select;
  }

  /* 상품 카테고리 선택을 적용하고 검토 상태를 다시 계산합니다. */
  function applyItemCategory(resultId, index, category) {
    const result = findResult(resultId);
    const item = result?.payload?.receipt.items[index];
    if (!result?.classification || !item || !CATEGORIES.includes(category)) return;
    item.category = category;
    item.categoryReviewed = true;
    item.classificationNeedsReview = false;
    item.categoryEditing = false;
    item.categoryDraft = null;
    updateCategoryReviewFlags(result);
    renderResults();
    updateReviewStatus();
  }

  /* 대표 카테고리를 적용하고 사용자가 검토한 상태로 표시합니다. */
  function applyOverallCategory(resultId, category) {
    const result = findResult(resultId);
    if (!result?.classification || !CATEGORIES.includes(category)) return;
    result.classification.overallCategory = category;
    result.classification.overallCategoryReviewed = true;
    result.classification.overallNeedsReview = false;
    result.classification.overallEditing = false;
    result.classification.overallDraft = null;
    state.categoryReviewComplete = false;
    elements.saveExpensesButton.hidden = true;
    renderResults();
    updateReviewStatus();
  }

  /* 지출 필드 또는 총액 불일치가 남아 있으면 상품 검토 상태를 유지합니다. */
  function updateCategoryReviewFlags(result) {
    const validation = getValidation(result.payload);
    result.payload.receipt.items.forEach((item) => {
      item.needsReview = isItemNeedsReview(result, item, validation);
    });
  }

  /* 상품 정보 누락, 낮은 분류 신뢰도, 금액 불일치를 검토 필요로 표시합니다. */
  function isItemNeedsReview(result, item, validation = getValidation(result.payload)) {
    const missingItemData = !item.name.trim() || item.quantity === null || item.quantity <= 0 ||
      item.unitPrice === null || item.totalPrice === null;
    const categoryUnreviewed = item.classificationNeedsReview && !item.categoryReviewed;
    return missingItemData || validation.mismatch || categoryUnreviewed;
  }

  /* 대표 카테고리의 신뢰도 또는 필수 정보 상태를 확인합니다. */
  function isOverallCategoryNeedsReview(classification) {
    return classification.overallNeedsReview && !classification.overallCategoryReviewed;
  }

  /* API 검증 정보와 현재 편집값을 바탕으로 누락/불일치를 계산합니다. */
  function getValidation(payload) {
    const receipt = payload.receipt;
    const missing = new Set();
    if (!receipt.storeName.trim()) missing.add("상호명");
    if (!receipt.purchasedAt) missing.add("결제 일시");
    if (!receipt.paymentMethod.trim()) missing.add("결제 수단");
    if (receipt.totalAmount === null || receipt.totalAmount < 0) missing.add("총 결제금액");
    if (receipt.items.length === 0) missing.add("구매 항목");
    receipt.items.forEach((item, index) => {
      if (!item.name.trim()) missing.add(`상품 ${index + 1} 상품명`);
      if (item.quantity === null || item.quantity <= 0) missing.add(`상품 ${index + 1} 수량`);
      if (item.unitPrice === null || item.unitPrice < 0) missing.add(`상품 ${index + 1} 단가`);
      if (item.totalPrice === null || item.totalPrice < 0) missing.add(`상품 ${index + 1} 금액`);
    });
    const allItemAmountsAvailable = receipt.items.every((item) => item.totalPrice !== null);
    const itemsTotal = allItemAmountsAvailable
      ? receipt.items.reduce((sum, item) => sum + item.totalPrice, 0)
      : null;
    return {
      missing: [...missing],
      itemsTotal,
      mismatch: receipt.totalAmount !== null && itemsTotal !== null && receipt.totalAmount !== itemsTotal
    };
  }

  /* 입력 필드별 필수값 검토 상태를 계산합니다. */
  function isReceiptFieldMissing(receipt, key) {
    if (key === "storeName") return !receipt.storeName.trim();
    if (key === "purchasedAt") return !receipt.purchasedAt;
    if (key === "paymentMethod") return !receipt.paymentMethod.trim();
    return receipt.totalAmount === null || receipt.totalAmount < 0;
  }

  /* 상호명 등 사용자가 입력한 값을 현재 결과에 즉시 반영합니다. */
  function updateReceiptField(resultId, key, value) {
    const result = findResult(resultId);
    if (!result || !result.payload) return;
    const field = elements.resultsList.querySelector(`[data-result-id="${resultId}"][data-field="${key}"]`);
    const selectionStart = field?.selectionStart;
    const selectionEnd = field?.selectionEnd;
    result.payload.receipt[key] = key === "totalAmount" ? parseInputNumber(value) : value;
    state.categoryReviewComplete = false;
    elements.saveExpensesButton.hidden = true;
    if (result.classification) updateCategoryReviewFlags(result);
    renderResults();
    restoreFocus(`[data-result-id="${resultId}"][data-field="${key}"]`, selectionStart, selectionEnd);
    updateReviewStatus();
  }

  /* 상품의 수량이나 금액 변경을 결과 상태에 반영합니다. */
  function updateItemField(resultId, index, key, value) {
    const result = findResult(resultId);
    if (!result || !result.payload?.receipt.items[index]) return;
    const field = elements.resultsList.querySelector(`[data-result-id="${resultId}"][data-item-index="${index}"][data-item-field="${key}"]`);
    const selectionStart = field?.selectionStart;
    const selectionEnd = field?.selectionEnd;
    result.payload.receipt.items[index][key] = key === "name" ? value : parseInputNumber(value);
    state.categoryReviewComplete = false;
    elements.saveExpensesButton.hidden = true;
    if (result.classification) updateCategoryReviewFlags(result);
    renderResults();
    restoreFocus(`[data-result-id="${resultId}"][data-item-index="${index}"][data-item-field="${key}"]`, selectionStart, selectionEnd);
    updateReviewStatus();
  }

  /* 수정 입력 중 포커스를 유지하도록 다시 그려진 필드를 찾습니다. */
  function restoreFocus(selector, selectionStart, selectionEnd) {
    const field = elements.resultsList.querySelector(selector);
    if (!field) return;
    field.focus({ preventScroll: true });
    if (typeof field.setSelectionRange === "function" && field.type === "text") {
      const start = Number.isInteger(selectionStart) ? selectionStart : field.value.length;
      const end = Number.isInteger(selectionEnd) ? selectionEnd : start;
      field.setSelectionRange(start, end);
    }
  }

  /* 숫자 입력을 검증해 비어 있거나 잘못된 값은 null로 표시합니다. */
  function parseInputNumber(value) {
    if (value.trim() === "") return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  /* 새 상품 행을 검토 목록에 추가합니다. */
  function addItem(resultId) {
    const result = findResult(resultId);
    if (!result?.payload) return;
    result.payload.receipt.items.push({
      name: "", quantity: 1, unitPrice: null, totalPrice: null,
      category: result.classification ? "기타" : null,
      confidence: null,
      classificationNeedsReview: Boolean(result.classification),
      categoryReviewed: false
    });
    renderResults();
    const inputs = elements.resultsList.querySelectorAll(`[data-result-id="${resultId}"][data-item-index]`);
    const newName = [...inputs].find((input) => input.dataset.itemIndex === String(result.payload.receipt.items.length - 1) && input.dataset.itemField === "name");
    newName?.focus();
    updateReviewStatus();
  }

  /* 선택한 상품을 삭제하고 나머지 행 번호를 다시 정리합니다. */
  function deleteItem(resultId, itemIndex) {
    const result = findResult(resultId);
    if (!result?.payload) return;
    result.payload.receipt.items.splice(itemIndex, 1);
    if (result.classification) updateCategoryReviewFlags(result);
    renderResults();
    updateReviewStatus();
  }

  /* 분석에 실패한 영수증 한 장만 다시 요청합니다. */
  async function retryResult(resultId) {
    const result = findResult(resultId);
    if (!result || state.busy) return;
    state.busy = true;
    renderResults();
    try {
      const payload = await parseReceipt(result.entry);
      result.payload = normalizePayload(payload);
      result.error = null;
      result.classification = null;
      result.classificationError = null;
    } catch (error) {
      result.error = error.message;
    } finally {
      state.busy = false;
      renderResults();
      updateReviewStatus();
    }
  }

  /* ID로 결과를 찾아 편집 이벤트가 올바른 영수증에 적용되게 합니다. */
  function findResult(id) {
    return state.results.find((result) => result.id === Number(id));
  }

  /* 모든 결과의 누락 및 금액 불일치 여부를 검토 안내에 표시합니다. */
  function updateReviewStatus() {
    const failed = state.results.filter((result) => result.error).length;
    const needsReceiptReview = state.results.filter((result) => {
      if (!result.payload) return false;
      const validation = getValidation(result.payload);
      return validation.missing.length > 0 || validation.mismatch;
    }).length;
    const unclassified = state.results.filter((result) => result.payload && !result.classification).length;
    const categoryReview = state.results.filter((result) => {
      if (result.classificationError) return true;
      if (!result.classification) return false;
      return isOverallCategoryNeedsReview(result.classification) ||
        result.payload.receipt.items.some((item) => isItemNeedsReview(result, item));
    }).length;
    const allClassified = state.results.length > 0 && unclassified === 0;
    elements.reviewButton.disabled = state.busy || !allClassified;
    elements.categorizeButton.disabled = state.busy || state.results.every((result) => !result.payload);
    if (failed > 0 || needsReceiptReview > 0 || unclassified > 0 || categoryReview > 0) {
      elements.reviewMessage.textContent = `${failed ? `인식 실패 ${failed}건, ` : ""}${unclassified ? `분류가 필요한 영수증 ${unclassified}건, ` : ""}${needsReceiptReview ? `금액·필수 정보 확인 ${needsReceiptReview}건, ` : ""}${categoryReview ? `카테고리 확인 ${categoryReview}건이 남아 있어요.` : "확인이 필요한 항목을 검토해 주세요."}`;
    } else {
      elements.reviewMessage.textContent = "대표 카테고리와 상품별 분류가 확인됐어요. 완료를 누르면 다음 단계에서 저장할 수 있어요.";
    }
  }

  /* 분류 상태와 영수증 정보를 모두 확인했는지 검사하고 검토를 완료합니다. */
  function finishCategoryReview() {
    const unresolved = state.results.filter((result) => {
      if (result.error || result.classificationError || !result.payload || !result.classification) return true;
      const validation = getValidation(result.payload);
      return validation.missing.length > 0 || validation.mismatch ||
        isOverallCategoryNeedsReview(result.classification) ||
        result.payload.receipt.items.some((item) => isItemNeedsReview(result, item, validation));
    });
    if (unresolved.length > 0) {
      showToast("분류 미완료, 필수 정보 누락, 금액 불일치 또는 검토 필요 항목을 먼저 확인해 주세요.");
      return;
    }
    state.categoryReviewComplete = true;
    elements.saveExpensesButton.hidden = false;
    elements.saveExpensesButton.textContent = state.session ? "지출 내역 저장" : "로그인 후 지출 저장";
    showToast("2단계 카테고리 검토가 완료됐어요. 확정 내용은 아직 저장되지 않았습니다.");
    setNavigationStep("categorize");
  }

  /* 화면의 단계 표시를 업로드/분석/검토 상태에 맞게 바꿉니다. */
  function setNavigationStep(current) {
    document.querySelectorAll(".step-item").forEach((item) => {
      const order = { upload: 0, analyze: 1, review: 2, categorize: 3 };
      const currentIndex = order[current];
      const itemIndex = order[item.dataset.step];
      item.classList.toggle("current", itemIndex === currentIndex);
      item.classList.toggle("done", itemIndex < currentIndex);
    });
  }

  /* 모바일 메뉴를 열거나 닫고 접근성 속성을 동기화합니다. */
  function toggleMenu(forceOpen) {
    const open = typeof forceOpen === "boolean" ? forceOpen : !elements.sidebar.classList.contains("open");
    elements.sidebar.classList.toggle("open", open);
    elements.sidebarBackdrop.classList.toggle("visible", open);
    elements.menuButton.setAttribute("aria-expanded", String(open));
    elements.menuButton.setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기");
  }

  /* 날짜 문자열을 브라우저의 날짜 입력 형식으로 바꿉니다. */
  function toLocalDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 16);
  }

  /* 원화 금액을 천 단위 구분 기호로 표시합니다. */
  function formatWon(value) {
    return value === null ? "—" : new Intl.NumberFormat("ko-KR").format(value);
  }

  /* 안내 토스트를 잠시 표시한 뒤 자동으로 숨깁니다. */
  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3600);
  }

  /* 분석 단계 전환에서 짧은 안내 간격을 둡니다. */
  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  /* 실제 DB와 분리된 로그인 전 데모 지출을 만들어 화면 조회에 사용합니다. */
  function createDemoExpenses() {
    const now = new Date();
    const make = (offset, day, store, category, amount, payment, items) => {
      const date = new Date(now.getFullYear(), now.getMonth() - offset, day, 12, 0, 0);
      return {
        id: `demo-${offset}-${day}-${store.replace(/\s/g, "")}`,
        user_id: null,
        store_name: store,
        purchased_at: date.toISOString(),
        payment_method: payment,
        overall_category: category,
        total_amount: amount,
        receipt_image_url: null,
        created_at: date.toISOString(),
        expense_items: items.map((item, index) => ({
          id: `demo-item-${offset}-${day}-${index}`,
          expense_id: `demo-${offset}-${day}-${store.replace(/\s/g, "")}`,
          name: item[0],
          quantity: item[1],
          unit_price: item[2],
          total_price: item[3],
          category: item[4] || category,
          needs_review: false
        }))
      };
    };
    return [
      make(0, Math.min(now.getDate(), 24), "동네 마트", "식비", 12500, "카드", [["우유", 1, 2500, 2500], ["식빵", 1, 3000, 3000], ["생수 2L", 2, 1500, 3000]]),
      make(0, Math.max(1, now.getDate() - 2), "버스 교통카드", "교통비", 1450, "교통카드", [["버스 요금", 1, 1450, 1450]]),
      make(0, Math.max(1, now.getDate() - 5), "생활용품점", "생활용품비", 18900, "체크카드", [["세탁 세제", 1, 8900, 8900], ["휴지", 1, 10000, 10000]]),
      make(0, Math.max(1, now.getDate() - 8), "동네 식당", "식비", 16000, "카드", [["점심 식사", 1, 16000, 16000]]),
      make(0, Math.max(1, now.getDate() - 11), "약국", "의료비", 7200, "체크카드", [["상비약", 1, 7200, 7200]]),
      make(1, 9, "동네 마트", "식비", 32000, "카드", [["식재료", 1, 22000, 22000], ["간식", 1, 10000, 10000]]),
      make(1, 18, "영화관", "문화·여가", 15000, "카드", [["영화 관람", 1, 15000, 15000]]),
      make(1, 21, "생활용품점", "생활용품비", 12500, "체크카드", [["세제", 1, 12500, 12500]]),
      make(2, 7, "동네 마트", "식비", 27500, "카드", [["식재료", 1, 17500, 17500], ["간식", 1, 10000, 10000]]),
      make(2, 15, "지하철", "교통비", 6400, "교통카드", [["지하철 요금", 1, 6400, 6400]]),
      make(2, 23, "온라인 서점", "문화·여가", 18000, "카드", [["책", 1, 18000, 18000]])
    ];
  }

  /* 환경 설정 API에서 Supabase 공개 URL/키를 읽고 인증 세션을 복원합니다. */
  async function initializeSupabase() {
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.configured !== true ||
        typeof payload.supabaseUrl !== "string" || typeof payload.publishableKey !== "string") {
        throw new Error(payload?.error?.message || "Supabase 환경 변수가 설정되지 않았습니다.");
      }
      state.supabase = { url: payload.supabaseUrl.replace(/\/+$/, ""), publishableKey: payload.publishableKey };
      state.session = restoreSession();
      await consumeAuthCallback();
      await ensureFreshSession();
      updateAuthChrome();
    } catch (error) {
      state.supabase = null;
      state.session = null;
      state.dataMode = "demo";
      elements.connectionStatus.textContent = "데모 모드";
      elements.connectionStatus.title = error.message;
      updateAuthChrome();
    }
    await renderCurrentView();
  }

  /* 브라우저 저장소에서 만료 시각을 계산한 인증 세션을 복원합니다. */
  function restoreSession() {
    try {
      const saved = JSON.parse(localStorage.getItem("smart-accounting-session") || "null");
      if (!saved || typeof saved.access_token !== "string" || typeof saved.refresh_token !== "string") return null;
      return saved;
    } catch {
      localStorage.removeItem("smart-accounting-session");
      return null;
    }
  }

  /* Supabase OAuth의 URL fragment에서 토큰을 읽고 주소창에서 제거합니다. */
  async function consumeAuthCallback() {
    if (!location.hash.includes("access_token=")) return;
    const tokenParams = new URLSearchParams(location.hash.slice(location.hash.indexOf("#") + 1));
    const accessToken = tokenParams.get("access_token");
    const refreshToken = tokenParams.get("refresh_token");
    if (!accessToken || !refreshToken) {
      navigate("login");
      throw new Error(tokenParams.get("error_description") || "소셜 로그인 응답을 확인하지 못했습니다.");
    }
    state.session = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + Number(tokenParams.get("expires_in") || 3600),
      user: tokenParams.get("user") ? JSON.parse(tokenParams.get("user")) : null
    };
    state.session.user = await getSupabaseUser(accessToken);
    persistSession();
    history.replaceState(null, "", `${location.pathname}${location.search}#dashboard`);
  }

  /* 새 토큰을 저장해 API 호출에 쓸 수 있도록 만료 시각을 갱신합니다. */
  function persistSession() {
    if (!state.session) {
      localStorage.removeItem("smart-accounting-session");
      return;
    }
    localStorage.setItem("smart-accounting-session", JSON.stringify(state.session));
  }

  /* access token 만료가 가까우면 refresh token으로 세션을 갱신합니다. */
  async function ensureFreshSession() {
    if (!state.session || !state.supabase) return false;
    const expiresAt = Number(state.session.expires_at || 0);
    if (expiresAt > Math.floor(Date.now() / 1000) + 60) return true;
    const response = await fetch(`${state.supabase.url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "apikey": state.supabase.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: state.session.refresh_token })
    });
    const payload = await response.json();
    if (!response.ok || !payload.access_token || !payload.refresh_token) {
      state.session = null;
      persistSession();
      updateAuthChrome();
      return false;
    }
    state.session = {
      ...payload,
      expires_at: Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600)
    };
    state.session.user = payload.user || await getSupabaseUser(payload.access_token);
    persistSession();
    return true;
  }

  /* 저장된 access token의 사용자 프로필을 Supabase Auth에서 확인합니다. */
  async function getSupabaseUser(accessToken) {
    const response = await fetch(`${state.supabase.url}/auth/v1/user`, {
      headers: {
        "apikey": state.supabase.publishableKey,
        "Authorization": `Bearer ${accessToken}`
      },
      cache: "no-store"
    });
    if (!response.ok) throw new Error("로그인 사용자 정보를 불러오지 못했습니다.");
    return response.json();
  }

  /* 로그인 token을 API에 전달하고 오류 응답을 사용자 메시지로 변환합니다. */
  async function apiRequest(path, options = {}, retried = false) {
    if (!state.session) throw new Error("로그인이 필요합니다.");
    const active = await ensureFreshSession();
    if (!active || !state.session) throw new Error("로그인 세션이 만료되었습니다. 다시 로그인해 주세요.");
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        "Authorization": `Bearer ${state.session.access_token}`,
        ...(options.headers || {})
      },
      cache: "no-store"
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("서버 응답을 읽지 못했습니다.");
    }
    if (response.status === 401 && !retried && state.session) {
      state.session.expires_at = 0;
      await ensureFreshSession();
      if (state.session) return apiRequest(path, options, true);
    }
    if (!response.ok) throw new Error(payload?.error?.message || "요청을 완료하지 못했습니다.");
    return payload;
  }

  /* API가 사용할 안전한 월 문자열을 현지 시간 기준으로 만듭니다. */
  function currentMonth(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  /* 세션 상태에 따라 샘플 또는 인증된 DB 데이터를 화면 상태에 반영합니다. */
  async function loadExpenses(month = "") {
    if (!state.session) {
      state.dataMode = "demo";
      state.expenses = [...state.demoExpenses];
      state.budget = null;
      elements.connectionStatus.textContent = "데모 데이터";
      return;
    }
    state.dataMode = "supabase";
    const query = new URLSearchParams();
    if (month) query.set("month", month);
    const queryString = query.toString();
    const [expensesResult, budgetResult] = await Promise.all([
      apiRequest(`/api/expenses${queryString ? `?${queryString}` : ""}`),
      month ? apiRequest(`/api/budgets?month=${encodeURIComponent(month)}`) : Promise.resolve({ budget: null })
    ]);
    state.expenses = Array.isArray(expensesResult.expenses) ? expensesResult.expenses : [];
    state.budget = budgetResult.budget || null;
    elements.connectionStatus.textContent = "Supabase 연결";
  }

  /* 서버 지출 스키마를 화면에서 쓰는 일관된 형태로 변환합니다. */
  function normalizeExpense(expense) {
    return {
      ...expense,
      items: expense.expense_items || expense.items || [],
      storeName: expense.store_name || expense.storeName || "",
      purchasedAt: expense.purchased_at || expense.purchasedAt || "",
      paymentMethod: expense.payment_method || expense.paymentMethod || "",
      overallCategory: expense.overall_category || expense.overallCategory || "기타",
      totalAmount: expense.total_amount ?? expense.totalAmount ?? 0,
      receiptImageUrl: expense.receipt_image_url || expense.receiptImageUrl || null
    };
  }

  /* 포맷터를 이용해 화면에 표시할 원화 값을 생성합니다. */
  function currency(value) {
    const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
    return `${new Intl.NumberFormat("ko-KR").format(amount)}원`;
  }

  /* 날짜를 한국어 짧은 날짜로 표시하고 잘못된 값은 안내 문자열로 처리합니다. */
  function formatDate(value, options = {}) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "날짜 정보 없음";
    return new Intl.DateTimeFormat("ko-KR", options).format(date);
  }

  /* 페이지 이동과 개별 지출 상세 경로를 주소 hash에 반영합니다. */
  function navigate(view, value = "") {
    const target = view === "expense-detail" ? `#expense/${encodeURIComponent(value)}` : `#${view}`;
    if (location.hash === target) renderCurrentView();
    else location.hash = target;
    toggleMenu(false);
  }

  /* 현재 URL에서 앱 화면 및 지출 상세 식별자를 추출합니다. */
  function resolveRoute() {
    const value = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (value.startsWith("expense/")) return { view: "expense-detail", id: value.slice("expense/".length) };
    const allowed = new Set(["dashboard", "upload", "expenses", "analytics", "tips", "settings", "login"]);
    return { view: allowed.has(value) ? value : "dashboard", id: "" };
  }

  /* 공통 내비게이션과 로그인 상태, 현재 활성 메뉴를 화면에 반영합니다. */
  function updateAuthChrome() {
    const user = state.session?.user;
    const signedIn = Boolean(state.session);
    elements.profileButton.textContent = signedIn
      ? String(user?.email || "내 계정").slice(0, 1).toLocaleUpperCase("ko-KR")
      : "게";
    elements.profileButton.setAttribute("aria-label", signedIn ? "로그아웃" : "로그인");
    document.querySelectorAll(".nav-link[data-route]").forEach((link) => {
      const active = link.dataset.route === state.currentView;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    const accountDescription = document.querySelector("#account-description");
    const settingsButton = document.querySelector("#settings-auth-button");
    if (accountDescription) {
      accountDescription.textContent = signedIn
        ? `${user?.email || "로그인 사용자"} 계정으로 Supabase와 동기화 중입니다.`
        : "로그인하지 않은 데모 상태입니다. 샘플 데이터는 데이터베이스에 저장되지 않습니다.";
    }
    if (settingsButton) settingsButton.textContent = signedIn ? "로그아웃" : "로그인";
  }

  /* 로그인/가입 폼의 제목과 버튼 문구를 현재 모드에 맞춥니다. */
  function setAuthMode(mode) {
    state.authMode = mode;
    const signup = mode === "signup";
    elements.authTitle.textContent = signup ? "스마트 가계부 회원가입" : "스마트 가계부 로그인";
    elements.authSubmit.textContent = signup ? "회원가입" : "로그인";
    elements.authSwitchText.textContent = signup ? "이미 계정이 있으신가요?" : "처음이신가요?";
    elements.authModeToggle.textContent = signup ? "로그인" : "회원가입";
    document.querySelector("#auth-password").autocomplete = signup ? "new-password" : "current-password";
    elements.authError.textContent = "";
  }

  /* 이메일 인증 성공을 저장하고 사용자 데이터 대시보드로 이동합니다. */
  async function submitAuth(event) {
    event.preventDefault();
    if (!state.supabase) {
      elements.authError.textContent = "Supabase 환경 변수가 설정되어 있지 않습니다. .env.local 설정을 확인해 주세요.";
      return;
    }
    const email = document.querySelector("#auth-email").value.trim();
    const password = document.querySelector("#auth-password").value;
    const endpoint = state.authMode === "signup" ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password";
    elements.authSubmit.disabled = true;
    elements.authError.textContent = "";
    try {
      const response = await fetch(`${state.supabase.url}${endpoint}`, {
        method: "POST",
        headers: { "apikey": state.supabase.publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.msg || payload.message || payload.error_description || "인증에 실패했습니다.");
      if (!payload.access_token || !payload.refresh_token) {
        showToast("가입 요청을 보냈어요. 이메일 인증을 마친 뒤 로그인해 주세요.");
        setAuthMode("login");
        return;
      }
      state.session = {
        ...payload,
        expires_at: Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600)
      };
      persistSession();
      updateAuthChrome();
      navigate("dashboard");
      showToast("로그인되었습니다.");
    } catch (error) {
      elements.authError.textContent = error.message;
    } finally {
      elements.authSubmit.disabled = false;
    }
  }

  /* OAuth provider를 Supabase authorize endpoint로 연결합니다. */
  function startOAuth(provider) {
    if (!state.supabase) {
      elements.authError.textContent = "Supabase 환경 변수가 설정되어 있지 않습니다.";
      return;
    }
    const redirect = `${location.origin}${location.pathname}#dashboard`;
    const query = new URLSearchParams({ provider, redirect_to: redirect });
    location.assign(`${state.supabase.url}/auth/v1/authorize?${query.toString()}`);
  }

  /* 로그인 상태를 삭제하고 데모 데이터 화면으로 안전하게 전환합니다. */
  function signOut() {
    const token = state.session?.access_token;
    if (token && state.supabase) {
      fetch(`${state.supabase.url}/auth/v1/logout`, {
        method: "POST",
        headers: { "apikey": state.supabase.publishableKey, "Authorization": `Bearer ${token}` }
      }).catch(() => {});
    }
    state.session = null;
    state.expenses = [...state.demoExpenses];
    state.budget = null;
    state.dataMode = "demo";
    persistSession();
    updateAuthChrome();
    navigate("dashboard");
    showToast("로그아웃했습니다. 데모 데이터로 전환합니다.");
  }

  /* HTML escape가 필요한 모든 사용자 데이터의 표시 문자열을 안전하게 만듭니다. */
  function textCell(value, className = "") {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = value == null || value === "" ? "—" : String(value);
    return cell;
  }

  /* 지출 목록 행을 만들고 상세 화면으로 이동하는 안전한 클릭 동작을 연결합니다. */
  function createExpenseRow(rawExpense, includePayment = false) {
    const expense = normalizeExpense(rawExpense);
    const row = document.createElement("tr");
    row.className = "clickable-row";
    row.tabIndex = 0;
    row.addEventListener("click", () => navigate("expense-detail", expense.id));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") navigate("expense-detail", expense.id);
    });
    row.append(textCell(formatDate(expense.purchasedAt, { month: "numeric", day: "numeric" })));
    row.append(textCell(expense.storeName, "store-cell"));
    if (includePayment) row.append(textCell(expense.paymentMethod));
    row.append(textCell(expense.overallCategory));
    row.append(textCell(currency(expense.totalAmount), "amount-cell"));
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = "상세 →";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      navigate("expense-detail", expense.id);
    });
    action.append(button);
    row.append(action);
    return row;
  }

  /* 월에 포함되는 지출만 선택해 화면 합계를 계산합니다. */
  function expensesForMonth(month) {
    return state.expenses
      .map(normalizeExpense)
      .filter((expense) => !month || expense.purchasedAt.startsWith(month));
  }

  /* 최근 6개월 막대 차트와 접근 가능한 금액 설명을 생성합니다. */
  function renderMonthlyChart() {
    const chart = document.querySelector("#monthly-chart");
    chart.replaceChildren();
    const months = [];
    const today = new Date();
    for (let offset = 5; offset >= 0; offset -= 1) {
      const date = new Date(today.getFullYear(), today.getMonth() - offset, 1);
      const month = currentMonth(date);
      const total = expensesForMonth(month).reduce((sum, expense) => sum + Number(expense.totalAmount || 0), 0);
      months.push({ label: `${date.getMonth() + 1}월`, total });
    }
    const max = Math.max(...months.map((month) => month.total), 1);
    for (const month of months) {
      const column = document.createElement("div");
      column.className = "chart-column";
      column.setAttribute("aria-label", `${month.label} ${currency(month.total)}`);
      const amount = document.createElement("span");
      amount.className = "chart-value";
      amount.textContent = month.total > 0 ? `${Math.round(month.total / 10000 * 10) / 10}만` : "";
      const track = document.createElement("div");
      track.className = "chart-bar-track";
      const bar = document.createElement("span");
      bar.className = "chart-bar";
      bar.style.height = `${month.total > 0 ? Math.max(7, month.total / max * 100) : 3}%`;
      track.append(bar);
      const label = document.createElement("span");
      label.className = "chart-label";
      label.textContent = month.label;
      column.append(amount, track, label);
      chart.append(column);
    }
  }

  /* 카테고리 금액을 겹쳐 합산하지 않는 도넛 차트와 범례를 표시합니다. */
  function renderCategoryChart(expenses, chartId, legendId) {
    const totals = new Map();
    expenses.forEach((expense) => {
      const category = expense.overallCategory || "기타";
      totals.set(category, (totals.get(category) || 0) + Number(expense.totalAmount || 0));
    });
    const entries = [...totals.entries()].sort((first, second) => second[1] - first[1]);
    const total = entries.reduce((sum, entry) => sum + entry[1], 0);
    const colors = ["#55866b", "#86aa92", "#b2c9b5", "#d0b179", "#cf8d70", "#929bc0", "#9d8caf", "#b8b9b2"];
    const chart = document.querySelector(`#${chartId}`);
    const legend = document.querySelector(`#${legendId}`);
    chart.replaceChildren();
    legend.replaceChildren();
    if (total === 0) {
      chart.classList.add("is-empty");
      chart.textContent = "아직 지출 데이터가 없어요.";
      return entries;
    }
    chart.classList.remove("is-empty");
    const stops = [];
    let cumulative = 0;
    entries.forEach((entry, index) => {
      const start = cumulative;
      cumulative += entry[1] / total * 100;
      stops.push(`${colors[index % colors.length]} ${start}% ${cumulative}%`);
      const line = document.createElement("div");
      line.className = "legend-line";
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.backgroundColor = colors[index % colors.length];
      const label = document.createElement("span");
      label.textContent = entry[0];
      const value = document.createElement("strong");
      value.textContent = currency(entry[1]);
      line.append(swatch, label, value);
      legend.append(line);
    });
    chart.style.background = `conic-gradient(${stops.join(", ")})`;
    const hole = document.createElement("div");
    hole.className = "donut-hole";
    const totalLabel = document.createElement("span");
    totalLabel.textContent = currency(total);
    hole.append(totalLabel);
    chart.append(hole);
    return entries;
  }

  /* 홈의 KPI, 월별 차트, 카테고리 차트와 최근 지출을 갱신합니다. */
  async function renderDashboard() {
    const month = currentMonth();
    await loadExpenses(month);
    const expenses = expensesForMonth(month);
    const total = expenses.reduce((sum, expense) => sum + Number(expense.totalAmount || 0), 0);
    const categories = renderCategoryChart(expenses, "dashboard-category-chart", "dashboard-category-legend");
    document.querySelector("#dashboard-month-label").textContent = `${month.replace("-", "년 ")}월 기준 지출과 예산을 보여드려요.`;
    document.querySelector("#kpi-total").textContent = currency(total);
    document.querySelector("#kpi-count").textContent = String(expenses.length);
    document.querySelector("#kpi-category").textContent = categories[0]?.[0] || "—";
    document.querySelector("#kpi-category-note").textContent = categories[0] ? currency(categories[0][1]) : "지출 기록이 없습니다";
    const budget = state.budget?.monthly_budget;
    document.querySelector("#kpi-remaining").textContent = budget ? currency(Number(budget) - total) : "미설정";
    document.querySelector("#kpi-budget-note").textContent = budget ? `월 예산 ${currency(budget)}` : "설정에서 월 예산을 추가해 보세요";
    renderMonthlyChart();
    const recent = document.querySelector("#recent-expenses");
    recent.replaceChildren(...expenses.slice(0, 5).map((expense) => createExpenseRow(expense)));
    document.querySelector("#dashboard-empty").hidden = expenses.length > 0;
  }

  /* 월/카테고리/검색 조건을 URL API와 데모 행에 일관되게 적용합니다. */
  async function renderExpenses() {
    const month = document.querySelector("#expense-month-filter").value || currentMonth();
    const category = document.querySelector("#expense-category-filter").value;
    const search = document.querySelector("#expense-search-filter").value.trim();
    if (state.session) {
      const query = new URLSearchParams({ month });
      if (category) query.set("category", category);
      if (search) query.set("q", search);
      const response = await apiRequest(`/api/expenses?${query}`);
      state.expenses = response.expenses || [];
    } else {
      await loadExpenses(month);
    }
    let expenses = expensesForMonth(month);
    if (category) expenses = expenses.filter((expense) =>
      expense.overallCategory === category || expense.items.some((item) => item.category === category));
    if (search) {
      const needle = search.toLocaleLowerCase("ko-KR");
      expenses = expenses.filter((expense) =>
        [expense.storeName, ...expense.items.map((item) => item.name)]
          .some((value) => String(value || "").toLocaleLowerCase("ko-KR").includes(needle)));
    }
    const body = document.querySelector("#expenses-table-body");
    body.replaceChildren(...expenses.map((expense) => createExpenseRow(expense, true)));
    document.querySelector("#expenses-empty").hidden = expenses.length > 0;
  }

  /* 식별된 지출 상세를 불러와 수정 가능한 상품별 카테고리 표를 표시합니다. */
  async function renderExpenseDetail(id) {
    let rawExpense;
    if (state.session) {
      const payload = await apiRequest(`/api/expenses/${encodeURIComponent(id)}`);
      rawExpense = payload.expense;
    } else {
      rawExpense = state.demoExpenses.find((expense) => expense.id === id);
    }
    if (!rawExpense) throw new Error("해당 지출 내역을 찾지 못했습니다.");
    const expense = normalizeExpense(rawExpense);
    state.currentExpense = expense;
    document.querySelector("#detail-title").textContent = expense.storeName;
    document.querySelector("#detail-subtitle").textContent = `${formatDate(expense.purchasedAt, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${expense.paymentMethod}`;
    const summary = document.querySelector("#detail-summary");
    summary.replaceChildren();
    for (const [label, value] of [
      ["상호명", expense.storeName],
      ["결제 일시", formatDate(expense.purchasedAt, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })],
      ["결제 수단", expense.paymentMethod],
      ["대표 카테고리", expense.overallCategory],
      ["총 지출", currency(expense.totalAmount)]
    ]) {
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value || "—";
      summary.append(term, description);
    }
    const imageBox = document.querySelector("#detail-receipt-image");
    imageBox.replaceChildren();
    if (expense.receiptImageUrl) {
      const image = document.createElement("img");
      image.src = expense.receiptImageUrl;
      image.alt = `${expense.storeName} 영수증`;
      imageBox.append(image);
    } else {
      imageBox.textContent = "등록된 영수증 이미지가 없습니다.";
    }
    const body = document.querySelector("#detail-items-body");
    body.replaceChildren(...expense.items.map((item, index) => createDetailItemRow(expense, item, index)));
    const itemsTotal = expense.items.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
    const mismatch = itemsTotal !== Number(expense.totalAmount);
    document.querySelector("#detail-total").textContent = `상품 합계 ${currency(itemsTotal)} · 결제 합계 ${currency(expense.totalAmount)}${mismatch ? " · ⚠ 금액 확인 필요" : ""}`;
    document.querySelector("#detail-total").classList.toggle("has-warning", mismatch);
    document.querySelector("#review-items-button").textContent =
      `검토 필요 항목 ${expense.items.filter((item) => item.needs_review).length}건`;
  }

  /* 상품 행을 편집 가능한 값 입력 및 기존 스키마 카테고리 선택기로 만듭니다. */
  function createDetailItemRow(expense, item, index) {
    const row = document.createElement("tr");
    row.dataset.itemId = item.id;
    row.append(textCell(item.name));
    for (const key of ["quantity", "unit_price", "total_price"]) {
      const cell = document.createElement("td");
      const input = document.createElement("input");
      input.className = "detail-input";
      input.type = "number";
      input.min = key === "quantity" ? "1" : "0";
      input.step = "1";
      input.value = item[key];
      input.dataset.itemField = key;
      input.setAttribute("aria-label", `${item.name} ${key === "quantity" ? "수량" : key === "unit_price" ? "단가" : "금액"}`);
      cell.append(input);
      row.append(cell);
    }
    const categoryCell = document.createElement("td");
    const select = createCategorySelect(item.category || "기타", `${item.name} 카테고리`);
    select.dataset.itemCategory = "";
    categoryCell.append(select);
    if (item.needs_review) {
      const warning = document.createElement("span");
      warning.className = "warning-badge";
      warning.textContent = "검토 필요";
      categoryCell.append(warning);
    }
    row.append(categoryCell);
    return row;
  }

  /* 상세 상품 변경을 검증한 다음 인증 사용자는 DB에 저장하고 데모는 로컬 상태만 갱신합니다. */
  async function saveDetailChanges() {
    if (!state.currentExpense) return;
    const button = document.querySelector("#save-detail-button");
    button.disabled = true;
    try {
      const rows = [...document.querySelectorAll("#detail-items-body tr")];
      const updates = rows.map((row) => {
        const quantity = Number(row.querySelector('[data-item-field="quantity"]').value);
        const unitPrice = Number(row.querySelector('[data-item-field="unit_price"]').value);
        const totalPrice = Number(row.querySelector('[data-item-field="total_price"]').value);
        const category = row.querySelector("[data-item-category]").value;
        if (!Number.isSafeInteger(quantity) || quantity <= 0 ||
          !Number.isSafeInteger(unitPrice) || unitPrice < 0 ||
          !Number.isSafeInteger(totalPrice) || totalPrice < 0) {
          throw new Error("상품 수량과 금액은 정수로 입력해 주세요.");
        }
        return {
          id: row.dataset.itemId,
          category,
          quantity,
          unitPrice,
          totalPrice,
          needsReview: category === "기타" || totalPrice !== quantity * unitPrice
        };
      });
      if (state.session) {
        for (const update of updates) {
          await apiRequest(`/api/expenses/${encodeURIComponent(state.currentExpense.id)}/items/${encodeURIComponent(update.id)}`, {
            method: "PATCH",
            body: JSON.stringify(update)
          });
        }
        const totalAmount = updates.reduce((sum, item) => sum + item.totalPrice, 0);
        const overallCategory = state.currentExpense.overallCategory;
        await apiRequest(`/api/expenses/${encodeURIComponent(state.currentExpense.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ overallCategory, totalAmount })
        });
      } else {
        updates.forEach((update) => {
          const item = state.currentExpense.items.find((candidate) => candidate.id === update.id);
          if (!item) return;
          item.category = update.category;
          item.quantity = update.quantity;
          item.unit_price = update.unitPrice;
          item.total_price = update.totalPrice;
          item.needs_review = update.needsReview;
        });
      }
      await renderCurrentView();
      showToast(state.session ? "상품 변경 내용을 Supabase에 저장했어요." : "데모 화면에 변경 내용을 적용했어요. 로그인하면 DB에 저장할 수 있어요.");
    } catch (error) {
      showToast(`저장 실패: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  /* 인증 API의 월별 집계를 받아 분석 차트와 검토 목록을 그립니다. */
  async function renderAnalytics() {
    const month = document.querySelector("#analytics-month").value || currentMonth();
    let expenses;
    let analytics;
    if (state.session) {
      const payload = await apiRequest(`/api/analytics?month=${encodeURIComponent(month)}`);
      analytics = payload.analytics;
      const list = await apiRequest(`/api/expenses?month=${encodeURIComponent(month)}`);
      expenses = (list.expenses || []).map(normalizeExpense);
    } else {
      expenses = expensesForMonth(month);
      analytics = aggregateLocalExpenses(expenses, month);
    }
    document.querySelector("#analytics-total").textContent = currency(analytics.totalAmount);
    document.querySelector("#analytics-average").textContent = currency(analytics.dailyAverage);
    document.querySelector("#average-period").textContent = `월 경과 ${analytics.elapsedDays}일 기준`;
    document.querySelector("#analytics-top-category").textContent = analytics.categories[0]?.category || "—";
    document.querySelector("#analytics-review-count").textContent = `${analytics.needsReviewCount}건`;
    renderCategoryChart(expenses, "analytics-category-chart", "analytics-category-legend");
    renderDailyChart(analytics.daily, analytics.daysInMonth);
    renderBreakdown(analytics.categories);
    renderOverspending(analytics.overspendingItems);
  }

  /* 지출 행으로부터 서버와 같은 중복 없는 월별 요약을 만듭니다. */
  function aggregateLocalExpenses(expenses, month) {
    const categories = new Map();
    const days = new Map();
    const overspendingItems = [];
    let totalAmount = 0;
    let needsReviewCount = 0;
    expenses.forEach((expense) => {
      totalAmount += Number(expense.totalAmount || 0);
      categories.set(expense.overallCategory, (categories.get(expense.overallCategory) || 0) + Number(expense.totalAmount || 0));
      const day = new Date(expense.purchasedAt).getDate();
      days.set(day, (days.get(day) || 0) + Number(expense.totalAmount || 0));
      expense.items.forEach((item) => {
        if (item.needs_review) needsReviewCount += 1;
        if (item.needs_review || Number(item.total_price) > 50000) overspendingItems.push({
          expenseId: expense.id, storeName: expense.storeName, name: item.name,
          category: item.category || "기타", amount: item.total_price, needsReview: item.needs_review
        });
      });
    });
    const [year, monthNumber] = month.split("-").map(Number);
    const daysInMonth = new Date(year, monthNumber, 0).getDate();
    const now = new Date();
    const elapsedDays = currentMonth(now) === month ? now.getDate() : daysInMonth;
    return {
      totalAmount,
      dailyAverage: elapsedDays ? Math.round(totalAmount / elapsedDays) : 0,
      elapsedDays,
      daysInMonth,
      needsReviewCount,
      categories: [...categories.entries()].map(([category, amount]) => ({
        category, amount, share: totalAmount ? amount / totalAmount : 0
      })).sort((first, second) => second.amount - first.amount),
      daily: [...days.entries()].map(([day, amount]) => ({ day, amount })).sort((first, second) => first.day - second.day),
      overspendingItems
    };
  }

  /* 사용 데이터의 일별 지출을 막대 그래프로 표시합니다. */
  function renderDailyChart(daily, daysInMonth) {
    const chart = document.querySelector("#daily-chart");
    chart.replaceChildren();
    const max = Math.max(...daily.map((item) => item.amount), 1);
    for (const item of daily) {
      const bar = document.createElement("div");
      bar.className = "daily-bar";
      bar.style.height = `${Math.max(4, item.amount / max * 100)}%`;
      bar.title = `${item.day}일 · ${currency(item.amount)}`;
      chart.append(bar);
    }
    const label = document.createElement("p");
    label.className = "chart-caption";
    label.textContent = `총 ${daysInMonth || 0}일 중 ${daily.length}일에 지출 기록`;
    chart.append(label);
  }

  /* 카테고리 소비 표를 금액 및 전체 비중과 함께 표시합니다. */
  function renderBreakdown(categories) {
    const container = document.querySelector("#category-breakdown");
    container.replaceChildren();
    if (!categories.length) {
      container.textContent = "분석할 지출 내역이 없습니다.";
      return;
    }
    for (const entry of categories) {
      const row = document.createElement("div");
      row.className = "breakdown-row";
      const label = document.createElement("span");
      label.textContent = entry.category;
      const amount = document.createElement("strong");
      amount.textContent = currency(entry.amount);
      const share = document.createElement("small");
      share.textContent = `${Math.round(entry.share * 100)}%`;
      row.append(label, amount, share);
      container.append(row);
    }
  }

  /* 고액 또는 검토 표시된 상품과 상세 진입 링크를 보여줍니다. */
  function renderOverspending(items) {
    const container = document.querySelector("#overspending-list");
    container.replaceChildren();
    if (!items.length) {
      container.textContent = "현재 검토 필요 또는 5만 원 초과 상품이 없습니다.";
      return;
    }
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "overspending-row";
      const title = document.createElement("span");
      title.textContent = `${item.name} · ${item.category}`;
      const value = document.createElement("strong");
      value.textContent = currency(item.amount);
      row.append(title, value);
      row.addEventListener("click", () => navigate("expense-detail", item.expenseId));
      container.append(row);
    }
  }

  /* 현재 및 이전 월 데이터를 비교해 확인 가능한 절약 팁을 생성합니다. */
  async function renderTips() {
    await loadExpenses();
    const current = expensesForMonth(currentMonth());
    const now = new Date();
    const previousDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonth = currentMonth(previousDate);
    const previous = expensesForMonth(previousMonth);
    const previousDays = new Date(previousDate.getFullYear(), previousDate.getMonth() + 1, 0).getDate();
    const comparisonDay = Math.min(now.getDate(), previousDays);
    const currentPeriod = current.filter((expense) => new Date(expense.purchasedAt).getDate() <= now.getDate());
    const previousPeriod = previous.filter((expense) => new Date(expense.purchasedAt).getDate() <= comparisonDay);
    const currentTotal = currentPeriod.reduce((sum, expense) => sum + Number(expense.totalAmount || 0), 0);
    const previousTotal = previousPeriod.reduce((sum, expense) => sum + Number(expense.totalAmount || 0), 0);
    const byCategory = new Map();
    current.forEach((expense) => byCategory.set(expense.overallCategory, (byCategory.get(expense.overallCategory) || 0) + Number(expense.totalAmount || 0)));
    const highest = [...byCategory.entries()].sort((first, second) => second[1] - first[1])[0];
    const change = previousTotal > 0 ? (currentTotal - previousTotal) / previousTotal * 100 : null;
    const savingEstimate = highest ? Math.round(highest[1] * 0.1) : 0;
    document.querySelector("#tips-top-category").textContent = highest?.[0] || "데이터 부족";
    document.querySelector("#tips-change").textContent = change === null ? "비교 불가" : `${change > 0 ? "+" : ""}${Math.round(change)}%`;
    document.querySelector("#tips-change-note").textContent = previousTotal
      ? `${previousMonth} 1~${comparisonDay}일 동일 기간 비교`
      : "비교 기간에 지난달 기록이 없습니다";
    document.querySelector("#tips-saving").textContent = highest ? currency(savingEstimate) : "데이터 부족";
    const list = document.querySelector("#tips-list");
    list.replaceChildren();
    const tips = [];
    if (highest) tips.push({
      title: `${highest[0]} 지출에서 10% 줄이기`,
      detail: `이번 달 ${highest[0]}에 ${currency(highest[1])}을 사용했어요. 구매 전 장바구니를 한 번 더 확인해 보세요. 10% 절약 가정 시 약 ${currency(savingEstimate)}을 줄일 수 있습니다.`,
      category: highest[0]
    });
    if (change !== null && change > 0) tips.push({
      title: "지난달보다 늘어난 소비 살펴보기",
      detail: `총지출이 지난달보다 ${Math.round(change)}% 증가했어요. 큰 금액의 지출부터 확인하면 조정할 항목을 찾기 쉬워요.`,
      category: highest?.[0] || "기타"
    });
    if (tips.length === 0) tips.push({
      title: current.length ? "현재 소비 흐름을 기록해 보세요" : "영수증을 등록해 맞춤 팁을 받아보세요",
      detail: current.length ? "지출이 안정적으로 기록되고 있어요. 한 달 동안 기록을 이어가면 비교 근거가 더 정확해져요." : "월별 비교와 절약 추정은 지출 데이터가 쌓인 뒤 표시됩니다. 데이터가 부족한 동안은 금액을 추정하지 않습니다.",
      category: "식비"
    });
    for (const tip of tips) {
      const card = document.createElement("article");
      card.className = "tip-card";
      const title = document.createElement("h3");
      title.textContent = tip.title;
      const detail = document.createElement("p");
      detail.textContent = tip.detail;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = `${tip.category} 지출 확인하기 →`;
      button.addEventListener("click", () => {
        document.querySelector("#expense-category-filter").value = tip.category;
        navigate("expenses");
      });
      card.append(title, detail, button);
      list.append(card);
    }
  }

  /* 월별 소비 분석 집계와 예산을 사용자 로그인 상태에 맞춰 그립니다. */
  async function renderSettings() {
    await loadExpenses();
    const month = document.querySelector("#budget-month");
    if (!month.value) month.value = currentMonth();
    if (state.session) {
      try {
        const result = await apiRequest(`/api/budgets?month=${encodeURIComponent(month.value)}`);
        state.budget = result.budget;
        document.querySelector("#budget-amount").value = result.budget?.monthly_budget || "";
        document.querySelector("#budget-message").textContent = result.budget ? `${month.value} 예산 ${currency(result.budget.monthly_budget)}` : "아직 설정된 예산이 없습니다.";
      } catch (error) {
        document.querySelector("#budget-message").textContent = `예산 조회 실패: ${error.message}`;
      }
    } else {
      document.querySelector("#budget-amount").value = "";
      document.querySelector("#budget-message").textContent = "예산은 로그인 후 Supabase에 저장할 수 있습니다.";
    }
  }

  /* 월 예산을 검증해 사용자 API로 저장하고 성공/실패를 표시합니다. */
  async function saveBudget(event) {
    event.preventDefault();
    const month = document.querySelector("#budget-month").value;
    const amount = Number(document.querySelector("#budget-amount").value);
    const message = document.querySelector("#budget-message");
    if (!state.session) {
      message.textContent = "예산 저장은 로그인 후 사용할 수 있습니다.";
      showToast("월 예산을 저장하려면 먼저 로그인해 주세요.");
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isSafeInteger(amount) || amount <= 0) {
      message.textContent = "월과 1 이상의 정수 예산을 확인해 주세요.";
      return;
    }
    const button = document.querySelector("#budget-form button");
    button.disabled = true;
    try {
      const result = await apiRequest("/api/budgets", {
        method: "PUT",
        body: JSON.stringify({ yearMonth: month, monthlyBudget: amount })
      });
      state.budget = result.budget;
      message.textContent = `${month} 예산 ${currency(amount)}을 저장했습니다.`;
      showToast("월 예산을 저장했습니다.");
    } catch (error) {
      message.textContent = `예산 저장 실패: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  /* 확인한 인식/분류 데이터 여러 건을 사용자 DB에 저장합니다. */
  async function saveReviewedExpenses() {
    if (!state.categoryReviewComplete) {
      showToast("먼저 카테고리 검토를 완료해 주세요.");
      return;
    }
    if (!state.session) {
      navigate("login");
      showToast("검토 결과를 저장하려면 로그인해 주세요.");
      return;
    }
    const button = elements.saveExpensesButton;
    button.disabled = true;
    let saved = 0;
    try {
      for (const result of state.results) {
        if (result.savedExpenseId) continue;
        const receipt = result.payload.receipt;
        const response = await apiRequest("/api/expenses", {
          method: "POST",
          body: JSON.stringify({
            storeName: receipt.storeName,
            purchasedAt: receipt.purchasedAt,
            paymentMethod: receipt.paymentMethod,
            overallCategory: result.classification.overallCategory,
            totalAmount: receipt.totalAmount,
            receiptImageUrl: null,
            items: receipt.items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice,
              category: item.category,
              needsReview: isItemNeedsReview(result, item) || isOverallCategoryNeedsReview(result.classification)
            }))
          })
        });
        if (!response.expense?.id || !Array.isArray(response.items)) throw new Error("저장 결과를 확인하지 못했습니다.");
        saved += 1;
        result.savedExpenseId = response.expense.id;
      }
      state.categoryReviewComplete = false;
      button.hidden = true;
      showToast(`${saved}건의 지출을 Supabase에 저장했습니다.`);
      navigate("expenses");
    } catch (error) {
      showToast(`${saved}건 저장 후 중단됐습니다. 이미 저장된 항목은 지출 목록에서 확인할 수 있습니다. 오류: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  /* 브라우저 hash 경로에 해당하는 앱 화면을 표시하고 필요한 데이터를 불러옵니다. */
  async function renderCurrentView() {
    const route = resolveRoute();
    state.currentView = route.view;
    document.querySelectorAll("[data-view]").forEach((element) => {
      element.hidden = element.dataset.view !== route.view;
    });
    updateAuthChrome();
    const titles = {
      dashboard: "홈 대시보드",
      upload: "영수증 업로드",
      expenses: "지출 목록",
      "expense-detail": "지출 상세",
      analytics: "월별 소비 분석",
      tips: "절약 팁",
      settings: "설정",
      login: "로그인"
    };
    document.title = `${titles[route.view]} | 스마트 가계부`;
    try {
      if (route.view === "dashboard") await renderDashboard();
      if (route.view === "expenses") await renderExpenses();
      if (route.view === "expense-detail") await renderExpenseDetail(route.id);
      if (route.view === "analytics") await renderAnalytics();
      if (route.view === "tips") await renderTips();
      if (route.view === "settings") await renderSettings();
      if (route.view === "login") setAuthMode(state.authMode);
    } catch (error) {
      showToast(error.message);
    }
  }

  /* 상단 통합 검색을 지출 목록 검색과 동기화합니다. */
  function submitGlobalSearch() {
    const query = elements.globalSearch.value.trim();
    document.querySelector("#expense-search-filter").value = query;
    document.querySelector(".global-search").classList.remove("search-open");
    navigate("expenses");
  }

  /* 파일 선택, 드롭, 분석, 검토 및 모바일 메뉴 이벤트를 연결합니다. */
  function bindEvents() {
    elements.browseButton = document.querySelector("#browse-button");
    elements.addMoreButton = document.querySelector("#add-more-button");
    elements.categorizeButton.addEventListener("click", categorizeReceipts);
    elements.reviewButton.addEventListener("click", finishCategoryReview);
    elements.saveExpensesButton.addEventListener("click", saveReviewedExpenses);
    elements.browseButton.addEventListener("click", () => elements.input.click());
    elements.addMoreButton.addEventListener("click", () => elements.input.click());
    elements.input.addEventListener("change", (event) => {
      addFiles(event.target.files);
      event.target.value = "";
    });
    elements.dropzone.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      elements.input.click();
    });
    elements.dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        elements.input.click();
      }
    });
    elements.dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      elements.dropzone.classList.add("is-dragging");
    });
    elements.dropzone.addEventListener("dragleave", (event) => {
      if (!elements.dropzone.contains(event.relatedTarget)) elements.dropzone.classList.remove("is-dragging");
    });
    elements.dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      elements.dropzone.classList.remove("is-dragging");
      addFiles(event.dataTransfer.files);
    });
    elements.analyzeButton.addEventListener("click", analyzeReceipts);
    elements.menuButton.addEventListener("click", () => toggleMenu());
    elements.sidebarBackdrop.addEventListener("click", () => toggleMenu(false));
    document.querySelectorAll("[data-route]").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (link.tagName === "A") event.preventDefault();
        navigate(link.dataset.route);
      });
    });
    document.querySelectorAll("[data-navigate]").forEach((button) => {
      button.addEventListener("click", () => navigate(button.dataset.navigate));
    });
    window.addEventListener("hashchange", () => { renderCurrentView(); });
    elements.profileButton.addEventListener("click", () => {
      if (state.session) signOut();
      else navigate("login");
    });
    elements.authForm.addEventListener("submit", submitAuth);
    elements.authModeToggle.addEventListener("click", () => setAuthMode(state.authMode === "login" ? "signup" : "login"));
    document.querySelectorAll(".oauth-button").forEach((button) => {
      button.addEventListener("click", () => startOAuth(button.dataset.provider));
    });
    document.querySelector("#settings-auth-button").addEventListener("click", () => {
      if (state.session) signOut();
      else navigate("login");
    });
    document.querySelector("#budget-form").addEventListener("submit", saveBudget);
    document.querySelector("#budget-month").addEventListener("change", () => { renderSettings(); });
    document.querySelector("#analytics-month").addEventListener("change", () => { renderAnalytics().catch((error) => showToast(error.message)); });
    document.querySelector("#expense-filter-button").addEventListener("click", () => { renderExpenses().catch((error) => showToast(error.message)); });
    document.querySelector("#expense-month-filter").value = currentMonth();
    document.querySelector("#analytics-month").value = currentMonth();
    document.querySelector("#budget-month").value = currentMonth();
    document.querySelector("#save-detail-button").addEventListener("click", saveDetailChanges);
    document.querySelector("#review-items-button").addEventListener("click", () => {
      const target = document.querySelector("#detail-items-body .warning-badge");
      if (target) target.closest("tr").scrollIntoView({ behavior: "smooth", block: "center" });
      else showToast("검토 필요 표시가 있는 항목이 없습니다.");
    });
    elements.globalSearch.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitGlobalSearch();
    });
    document.querySelector("#search-toggle").addEventListener("click", () => {
      const wrapper = document.querySelector(".global-search");
      wrapper.classList.add("search-open");
      elements.globalSearch.focus();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        toggleMenu(false);
        document.querySelector(".global-search").classList.remove("search-open");
      }
    });
    window.addEventListener("beforeunload", () => {
      state.files.forEach((entry) => URL.revokeObjectURL(entry.previewUrl));
    });
  }

  /* 화면 초기화 시 파일 목록과 이벤트 연결을 완료합니다. */
  function initialize() {
    bindEvents();
    renderPreviews();
    if (!location.hash) history.replaceState(null, "", `${location.pathname}${location.search}#upload`);
    initializeSupabase();
  }

  initialize();
})();
