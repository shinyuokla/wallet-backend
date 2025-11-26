const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHEET_ID =
  process.env.GOOGLE_SHEET_ID || "1MeCb_ClcxP-H_e6vYid49l-ayRd0cF-TE_StXRO9dnM";
const TRANSACTION_SHEET_RANGE =
  process.env.GOOGLE_TRANSACTION_RANGE || "'transactions'!A:F";
const TRANSACTION_COLUMNS = [
  "id",
  "date",
  "type",
  "category_id",
  "amount",
  "note",
];
const REQUIRED_TRANSACTION_COLUMNS = ["id", "date", "type", "amount"];
const CATEGORY_SHEET_RANGE =
  process.env.GOOGLE_CATEGORY_RANGE || "'categories'!A:C";
const CATEGORY_COLUMNS = ["id", "name", "color_hex"];
const DEFAULT_CATEGORY = {
  id: "1",
  name: "未分類",
  color_hex: "#9E9E9E",
};
const BUDGET_SHEET_RANGE = process.env.GOOGLE_BUDGET_RANGE || "'budgets'!A:B";
const BUDGET_COLUMNS = ["id", "amount"];
const DEFAULT_BUDGET = {
  id: "1",
  amount: "0",
};
const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{6})$/;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "gonsakon";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "!Nba1q2w3e4r";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "365d";
const API_ENDPOINTS = [
  { method: "POST", path: "/auth/login", description: "登入並取得 JWT" },
  { method: "GET", path: "/api/transactions", description: "取得所有記帳資料" },
  { method: "POST", path: "/api/transactions", description: "新增記帳資料" },
  { method: "PUT", path: "/api/transactions/:id", description: "更新記帳資料" },
  {
    method: "DELETE",
    path: "/api/transactions/:id",
    description: "刪除記帳資料",
  },
  { method: "GET", path: "/api/categories", description: "取得所有類別與色碼" },
  { method: "POST", path: "/api/categories", description: "新增類別" },
  { method: "PUT", path: "/api/categories/:id", description: "更新類別" },
  { method: "DELETE", path: "/api/categories/:id", description: "刪除類別" },
  { method: "GET", path: "/api/budget", description: "取得預算" },
  { method: "PUT", path: "/api/budget", description: "更新預算" },
];

/**
 * Reuse the Google Sheets client so we do not re-authenticate on every request.
 */
const buildCredentialsFromEnv = () => {
  const requiredKeys = [
    "GOOGLE_SA_TYPE",
    "GOOGLE_SA_PROJECT_ID",
    "GOOGLE_SA_PRIVATE_KEY_ID",
    "GOOGLE_SA_PRIVATE_KEY",
    "GOOGLE_SA_CLIENT_EMAIL",
    "GOOGLE_SA_CLIENT_ID",
  ];

  const hasAll = requiredKeys.every((key) => !!process.env[key]);
  if (!hasAll) {
    return null;
  }

  return {
    type: process.env.GOOGLE_SA_TYPE,
    project_id: process.env.GOOGLE_SA_PROJECT_ID,
    private_key_id: process.env.GOOGLE_SA_PRIVATE_KEY_ID,
    private_key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.GOOGLE_SA_CLIENT_EMAIL,
    client_id: process.env.GOOGLE_SA_CLIENT_ID,
  };
};

const getSheetsClient = (() => {
  let cached;
  return () => {
    if (cached) return cached;

    const credentials = buildCredentialsFromEnv();
    const auth = new google.auth.GoogleAuth({
      ...(credentials
        ? { credentials }
        : {
            keyFile:
              process.env.GOOGLE_APPLICATION_CREDENTIALS ||
              path.join(
                __dirname,
                "sunlit-adviser-479406-r0-b5a712496697.json"
              ),
          }),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    cached = google.sheets({ version: "v4", auth });
    return cached;
  };
})();

const normalizeRows = (rows) => {
  if (!rows || rows.length === 0) {
    return [];
  }

  const [header, ...dataRows] = rows;
  return dataRows.map((row) =>
    header.reduce((acc, key, index) => {
      acc[key] = row[index] ?? "";
      return acc;
    }, {})
  );
};

const appendRow = async (sheets, range, columns, payload) => {
  const row = columns.map((key) => {
    const value = payload[key];
    return value === undefined || value === null ? "" : value;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [row],
    },
  });
};

/**
 * 找出指定 id 在工作表中的列索引（0-based，不含標題列）
 * 回傳 { rowIndex, rowData } 或 null
 */
const findRowById = async (sheetRange, idColumn, targetId) => {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: sheetRange,
  });

  const rows = response.data.values || [];
  if (rows.length < 2) return null;

  const [header, ...dataRows] = rows;
  const idIndex = header.indexOf(idColumn);
  if (idIndex === -1) return null;

  const normalizedTarget = (targetId ?? "").toString().trim();
  for (let i = 0; i < dataRows.length; i++) {
    const rowId = (dataRows[i][idIndex] ?? "").toString().trim();
    if (rowId === normalizedTarget) {
      const rowData = header.reduce((acc, key, idx) => {
        acc[key] = dataRows[i][idx] ?? "";
        return acc;
      }, {});
      return { rowIndex: i + 2, rowData }; // +2: 1 for 1-based, 1 for header
    }
  }
  return null;
};

/**
 * 更新指定列的資料
 */
const updateRow = async (sheetName, rowIndex, columns, payload) => {
  const sheets = getSheetsClient();
  const row = columns.map((key) => {
    const value = payload[key];
    return value === undefined || value === null ? "" : value;
  });

  const range = `'${sheetName}'!A${rowIndex}:${String.fromCharCode(
    64 + columns.length
  )}${rowIndex}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [row],
    },
  });
};

/**
 * 刪除指定列（使用 batchUpdate 刪除整列）
 */
const deleteRow = async (sheetName, rowIndex) => {
  const sheets = getSheetsClient();

  // 先取得 sheetId
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });

  const sheet = spreadsheet.data.sheets.find(
    (s) => s.properties.title === sheetName
  );
  if (!sheet) {
    throw new Error(`找不到工作表: ${sheetName}`);
  }

  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowIndex - 1, // 0-based
              endIndex: rowIndex,
            },
          },
        },
      ],
    },
  });
};

const initializeCategorySheet = async (sheets) => {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: CATEGORY_SHEET_RANGE,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        CATEGORY_COLUMNS,
        CATEGORY_COLUMNS.map((key) => DEFAULT_CATEGORY[key] || ""),
      ],
    },
  });
};

const initializeBudgetSheet = async (sheets) => {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: BUDGET_SHEET_RANGE,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        BUDGET_COLUMNS,
        BUDGET_COLUMNS.map((key) => DEFAULT_BUDGET[key] || ""),
      ],
    },
  });
};

const normalizeCategoryId = (value) => (value ?? "").toString().trim();

const normalizeCategoryName = (value) =>
  (value ?? "").toString().trim().toLowerCase();

const findCategoryById = (categories, id) => {
  const normalized = normalizeCategoryId(id);
  if (!normalized) return null;
  return (
    categories.find(
      (category) => normalizeCategoryId(category.id) === normalized
    ) || null
  );
};

const findCategoryByName = (categories, name) => {
  const normalized = normalizeCategoryName(name);
  if (!normalized) return null;
  return (
    categories.find(
      (category) => normalizeCategoryName(category.name) === normalized
    ) || null
  );
};

const generateCategoryId = (categories) => {
  const numericIds = categories
    .map((category) => Number(category.id))
    .filter((value) => Number.isFinite(value));

  if (numericIds.length === categories.length && numericIds.length > 0) {
    const next = Math.max(...numericIds) + 1;
    return String(next);
  }

  return Date.now().toString();
};

const getCategoryRows = async () => {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values
    .get({
      spreadsheetId: SHEET_ID,
      range: CATEGORY_SHEET_RANGE,
    })
    .catch((error) => {
      if (error.code === 400 || error.code === 404) {
        return { data: { values: [] } };
      }
      throw error;
    });

  const rawValues = response.data.values || [];
  if (rawValues.length === 0) {
    await initializeCategorySheet(sheets);
    return [{ ...DEFAULT_CATEGORY }];
  }

  const categories = normalizeRows(rawValues).map((category) => ({
    ...category,
    id: normalizeCategoryId(category.id),
  }));
  const hasDefault = categories.some(
    (row) =>
      normalizeCategoryId(row.id) === normalizeCategoryId(DEFAULT_CATEGORY.id)
  );

  if (!hasDefault) {
    await appendRow(
      sheets,
      CATEGORY_SHEET_RANGE,
      CATEGORY_COLUMNS,
      DEFAULT_CATEGORY
    );
    categories.push({ ...DEFAULT_CATEGORY });
  }

  return categories;
};

const getBudget = async () => {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values
    .get({
      spreadsheetId: SHEET_ID,
      range: BUDGET_SHEET_RANGE,
    })
    .catch((error) => {
      if (error.code === 400 || error.code === 404) {
        return { data: { values: [] } };
      }
      throw error;
    });

  const rawValues = response.data.values || [];
  if (rawValues.length === 0) {
    await initializeBudgetSheet(sheets);
    return { ...DEFAULT_BUDGET };
  }

  const budgets = normalizeRows(rawValues);
  if (budgets.length === 0) {
    await appendRow(sheets, BUDGET_SHEET_RANGE, BUDGET_COLUMNS, DEFAULT_BUDGET);
    return { ...DEFAULT_BUDGET };
  }

  return budgets[0];
};

const generateToken = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

const requireAuth = (req, res, next) => {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "未授權：請提供 token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "token 無效或已過期" });
  }
};

app.get("/", (req, res) => {
  res.json({
    message: "Google Sheets 商品 API",
    sheetId: SHEET_ID,
    endpoints: API_ENDPOINTS,
  });
});

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "帳號或密碼錯誤" });
  }

  const token = generateToken({ username });
  res.json({ token, expiresIn: JWT_EXPIRES_IN });
});

const listTransactionsHandler = async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const response = await sheets.spreadsheets.values
      .get({
        spreadsheetId: SHEET_ID,
        range: TRANSACTION_SHEET_RANGE,
      })
      .catch((error) => {
        if (error.code === 400 || error.code === 404) {
          return { data: { values: [] } };
        }
        throw error;
      });

    const transactions = normalizeRows(response.data.values);
    const categories = await getCategoryRows();
    const categoryMap = categories.reduce((acc, category) => {
      const id = normalizeCategoryId(category.id);
      if (id) {
        acc[id] = category;
      }
      return acc;
    }, {});

    const data = transactions.map((transaction) => {
      const rawCategoryId =
        normalizeCategoryId(transaction.category_id) ||
        normalizeCategoryId(transaction.category);
      const category =
        categoryMap[rawCategoryId] ||
        findCategoryByName(categories, transaction.category) ||
        DEFAULT_CATEGORY;

      return {
        ...transaction,
        category_id: category.id,
        category_name: category.name,
        category_color_hex: category.color_hex,
      };
    });

    res.json({ data });
  } catch (error) {
    console.error("Failed to fetch transaction data:", error);
    res.status(500).json({ message: "無法讀取記帳資料", error: error.message });
  }
};

app.get("/api/transactions", listTransactionsHandler);
// 向後相容既有的 /api/products route
app.get("/api/products", listTransactionsHandler);

const createTransactionHandler = async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ message: "請提供記帳資料" });
    }

    const missing = REQUIRED_TRANSACTION_COLUMNS.filter(
      (key) => !req.body[key]
    );
    if (missing.length > 0) {
      return res
        .status(400)
        .json({ message: `缺少必填欄位: ${missing.join(", ")}` });
    }

    const categories = await getCategoryRows();
    const requestedCategoryId = normalizeCategoryId(req.body.category_id);
    const requestedCategoryName = (req.body.category || "").trim();

    const resolvedCategory = findCategoryById(
      categories,
      requestedCategoryId
    ) ||
      findCategoryByName(categories, requestedCategoryName) ||
      findCategoryById(categories, DEFAULT_CATEGORY.id) || {
        ...DEFAULT_CATEGORY,
      };

    const payload = {
      ...req.body,
      category_id: resolvedCategory.id,
    };
    delete payload.category;

    const sheets = getSheetsClient();
    await appendRow(
      sheets,
      TRANSACTION_SHEET_RANGE,
      TRANSACTION_COLUMNS,
      payload
    );
    res.status(201).json({
      message: "記帳資料新增成功",
      data: {
        ...payload,
        category_name: resolvedCategory.name,
        category_color_hex: resolvedCategory.color_hex,
      },
    });
  } catch (error) {
    console.error("Failed to append transaction data:", error);
    res.status(500).json({ message: "無法新增記帳資料", error: error.message });
  }
};

app.post("/api/transactions", requireAuth, createTransactionHandler);
// 向後相容既有的 /api/products route
app.post("/api/products", requireAuth, createTransactionHandler);

// PUT /api/transactions/:id - 更新記帳資料
app.put("/api/transactions/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ message: "請提供記帳資料" });
    }

    const found = await findRowById(TRANSACTION_SHEET_RANGE, "id", id);
    if (!found) {
      return res.status(404).json({ message: "找不到該筆記帳資料" });
    }

    const categories = await getCategoryRows();
    const requestedCategoryId = normalizeCategoryId(req.body.category_id);
    const requestedCategoryName = (req.body.category || "").trim();

    const resolvedCategory = findCategoryById(
      categories,
      requestedCategoryId
    ) ||
      findCategoryByName(categories, requestedCategoryName) ||
      findCategoryById(categories, found.rowData.category_id) ||
      findCategoryById(categories, DEFAULT_CATEGORY.id) || {
        ...DEFAULT_CATEGORY,
      };

    const payload = {
      ...found.rowData,
      ...req.body,
      id, // 確保 id 不被覆蓋
      category_id: resolvedCategory.id,
    };
    delete payload.category;

    await updateRow(
      "transactions",
      found.rowIndex,
      TRANSACTION_COLUMNS,
      payload
    );

    res.json({
      message: "記帳資料更新成功",
      data: {
        ...payload,
        category_name: resolvedCategory.name,
        category_color_hex: resolvedCategory.color_hex,
      },
    });
  } catch (error) {
    console.error("Failed to update transaction:", error);
    res.status(500).json({ message: "無法更新記帳資料", error: error.message });
  }
});

// DELETE /api/transactions/:id - 刪除記帳資料
app.delete("/api/transactions/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const found = await findRowById(TRANSACTION_SHEET_RANGE, "id", id);
    if (!found) {
      return res.status(404).json({ message: "找不到該筆記帳資料" });
    }

    await deleteRow("transactions", found.rowIndex);

    res.json({ message: "記帳資料刪除成功", data: found.rowData });
  } catch (error) {
    console.error("Failed to delete transaction:", error);
    res.status(500).json({ message: "無法刪除記帳資料", error: error.message });
  }
});

app.get("/api/categories", async (req, res) => {
  try {
    const categories = await getCategoryRows();
    res.json({ data: categories });
  } catch (error) {
    console.error("Failed to fetch categories:", error);
    res.status(500).json({ message: "無法讀取類別資料", error: error.message });
  }
});

app.post("/api/categories", requireAuth, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ message: "請提供類別資料" });
    }

    const name = (req.body.name || "").trim();
    const colorHex =
      (req.body.color_hex || "").trim() || DEFAULT_CATEGORY.color_hex;

    if (!name) {
      return res.status(400).json({ message: "類別名稱不得為空" });
    }

    if (!HEX_COLOR_REGEX.test(colorHex)) {
      return res.status(400).json({ message: "色碼格式須為 #RRGGBB" });
    }

    const categories = await getCategoryRows();
    const exists = categories.some(
      (category) =>
        (category.name || "").trim().toLowerCase() === name.toLowerCase()
    );

    if (exists) {
      return res.status(409).json({ message: "類別名稱已存在" });
    }

    const payload = {
      id: generateCategoryId(categories),
      name,
      color_hex: colorHex.toUpperCase(),
    };

    const sheets = getSheetsClient();
    await appendRow(sheets, CATEGORY_SHEET_RANGE, CATEGORY_COLUMNS, payload);

    res.status(201).json({ message: "類別新增成功", data: payload });
  } catch (error) {
    console.error("Failed to append category:", error);
    res.status(500).json({ message: "無法新增類別", error: error.message });
  }
});

// PUT /api/categories/:id - 更新類別
app.put("/api/categories/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ message: "請提供類別資料" });
    }

    // 不允許修改預設類別的 id
    if (normalizeCategoryId(id) === normalizeCategoryId(DEFAULT_CATEGORY.id)) {
      // 允許修改名稱和顏色，但不能刪除
    }

    const found = await findRowById(CATEGORY_SHEET_RANGE, "id", id);
    if (!found) {
      return res.status(404).json({ message: "找不到該類別" });
    }

    const name = (req.body.name ?? found.rowData.name ?? "").trim();
    const colorHex =
      (req.body.color_hex ?? found.rowData.color_hex ?? "").trim() ||
      DEFAULT_CATEGORY.color_hex;

    if (!name) {
      return res.status(400).json({ message: "類別名稱不得為空" });
    }

    if (!HEX_COLOR_REGEX.test(colorHex)) {
      return res.status(400).json({ message: "色碼格式須為 #RRGGBB" });
    }

    // 檢查名稱是否與其他類別重複
    const categories = await getCategoryRows();
    const duplicate = categories.some(
      (category) =>
        normalizeCategoryId(category.id) !== normalizeCategoryId(id) &&
        (category.name || "").trim().toLowerCase() === name.toLowerCase()
    );

    if (duplicate) {
      return res.status(409).json({ message: "類別名稱已存在" });
    }

    const payload = {
      id,
      name,
      color_hex: colorHex.toUpperCase(),
    };

    await updateRow("categories", found.rowIndex, CATEGORY_COLUMNS, payload);

    res.json({ message: "類別更新成功", data: payload });
  } catch (error) {
    console.error("Failed to update category:", error);
    res.status(500).json({ message: "無法更新類別", error: error.message });
  }
});

// DELETE /api/categories/:id - 刪除類別
app.delete("/api/categories/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // 不允許刪除預設類別
    if (normalizeCategoryId(id) === normalizeCategoryId(DEFAULT_CATEGORY.id)) {
      return res.status(400).json({ message: "無法刪除預設類別「未分類」" });
    }

    const found = await findRowById(CATEGORY_SHEET_RANGE, "id", id);
    if (!found) {
      return res.status(404).json({ message: "找不到該類別" });
    }

    await deleteRow("categories", found.rowIndex);

    res.json({ message: "類別刪除成功", data: found.rowData });
  } catch (error) {
    console.error("Failed to delete category:", error);
    res.status(500).json({ message: "無法刪除類別", error: error.message });
  }
});

app.get("/api/budget", async (req, res) => {
  try {
    const budget = await getBudget();
    res.json({ data: budget });
  } catch (error) {
    console.error("Failed to fetch budget:", error);
    res.status(500).json({ message: "無法讀取預算", error: error.message });
  }
});

app.put("/api/budget", requireAuth, async (req, res) => {
  try {
    if (!req.body || typeof req.body.amount === "undefined") {
      return res.status(400).json({ message: "請提供預算金額" });
    }

    const amount = Math.max(0, Number(req.body.amount));
    const budget = await getBudget();
    const found = await findRowById(BUDGET_SHEET_RANGE, "id", budget.id);

    if (!found) {
      // Should not happen if getBudget works correctly, but safe fallback
      return res.status(500).json({ message: "找不到預算設定" });
    }

    const payload = {
      ...budget,
      amount,
    };

    await updateRow("budgets", found.rowIndex, BUDGET_COLUMNS, payload);

    res.json({ message: "預算更新成功", data: payload });
  } catch (error) {
    console.error("Failed to update budget:", error);
    res.status(500).json({ message: "無法更新預算", error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
