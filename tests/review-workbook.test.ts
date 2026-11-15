import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewWorkbook } from "../src/mcp/review-contract.js";
import {
  REVIEW_COLUMNS,
  REVIEW_DATA_FIELDS,
  REVIEW_EXAMPLES_SHEET_NAME,
  REVIEW_MAX_RECORDS,
  REVIEW_META_SHEET_NAME,
  REVIEW_SHEET_NAME,
  ReviewWorkbookError,
  collapsedReviewColumns,
  REVIEW_LEGACY_COLUMNS,
  readReviewWorkbook,
  updateReviewDuplicateChecks,
  writeReviewWorkbook
} from "../src/mcp/review-workbook.js";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { ReviewRow } from "../src/mcp/review-contract.js";

/** Synthetic data only. Suppliers and numbers are invented; nothing comes from a live POHODA. */
export function syntheticReview(): ReviewWorkbook {
  return {
    reviewId: "rev-SYNTH-0001",
    databaseId: "DEMO_TEST_UNIT",
    vatPeriod: "2026-03",
    rows: [
      {
        rowId: "r001",
        duplicateCheck: { status: "clear", checkedAt: "2026-03-20T10:00:00Z", message: "Bez nalezené shody v POHODĚ a této dávce.", matches: [], matchCount: 0 },
        tool: "create_invoice",
        action: "import",
        reviewNotes: "",
        data: {
          text: "Kancelářské potřeby (SYNTETICKÝ PŘÍKLAD)",
          partnerName: "Ukázkový Dodavatel s.r.o. [SYNTETICKÝ]",
          partnerIco: "00012345",
          partnerDic: "CZ00012345",
          partnerCountry: "CZ",
          sourceDocumentNumber: "0042026",
          sourceSymVar: "0042026",
          sourceIssueDate: "2026-02-14",
          sourceTaxDate: "2026-02-14",
          taxMode: "taxable", classificationVAT: "PD",
          sourceChargesVat: true,
          priceNone: 0,
          priceHigh: 1000,
          priceHighVAT: 210,
          priceHighSum: 1210,
          total: 1210,
          accounting: "1Np",
          sourcePages: [1, 2],
          sourcePdfPath: "/synthetic/inbox/faktura-0042026.pdf",
          intNote: "must not round-trip",
          unknownField: "dropped"
        }
      },
      {
        rowId: "r002",
        duplicateCheck: { status: "possible", checkedAt: "2026-03-20T10:00:00Z", message: "Možná duplicita: POHODA commitment #72 (PK26007) — stejný dodavatel a číslo dokladu, 250.00 CZK.", matches: [{ location: "pohoda", reason: "reference", agenda: "invoice", type: "commitment", id: "72", number: "PK26007", date: "2026-03-05", total: 250, currency: "CZK" }], matchCount: 1 },
        tool: "create_other_liability",
        action: "review",
        reviewNotes: "Ověřit, zda jde o platbu kartou",
        data: {
          text: "Parkování (SYNTETICKÝ PŘÍKLAD)",
          partnerName: "Fiktivní Parking a.s. [SYNTETICKÝ]",
          partnerIco: "99999999",
          sourceDocumentNumber: "P-7781",
          sourceIssueDate: "2026-03-05",
          sourceTaxDate: "2026-03-05",
          taxMode: "nonTax",
          sourceChargesVat: false,
          cardPayment: true,
          priceNone: "250.00",
          total: "250.00",
          sourcePages: [3]
        }
      },
      {
        rowId: "r003",
        tool: "create_cash_voucher",
        action: "skip",
        reviewNotes: "=nejde o vzorec",
        data: {
          text: "=SUM(A1:A2) jen text",
          partnerName: "Vzorová Prodejna [SYNTETICKÝ]",
          sourceIssueDate: "2026-03-10",
          sourceTaxDate: "2026-03-10",
          sourcePaymentDate: "2026-03-10",
          taxMode: "taxable", classificationVAT: "PD",
          cashAccount: "HP",
          priceLow: 100,
          priceLowVAT: 12,
          priceLowSum: 112,
          roundingAmount: -0.0,
          total: 112,
          sourcePages: [4]
        }
      }
    ],
    examples: [
      { number: "FP-2026-0001", partnerName: "Ukázkový Dodavatel s.r.o. [SYNTETICKÝ]", text: "Kancelářské potřeby", accounting: "1Np", total: 968, sourceIssueDate: "2026-01-12" },
      { number: "OZ-2026-0007", partnerName: "Fiktivní Parking a.s. [SYNTETICKÝ]", text: "Parkování", classificationVAT: "PN", total: 300, nested: { a: 1 } }
    ]
  };
}

let dir = "";
beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-workbook-")); });
afterAll(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

let counter = 0;
const file = (ext = ".xlsx") => path.join(dir, `wb-${++counter}${ext}`);

async function written(input: ReviewWorkbook = syntheticReview()): Promise<string> {
  const target = file();
  await writeReviewWorkbook(input, target);
  return target;
}

async function edit(filePath: string, mutate: (ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook) => void | Promise<void>): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  await mutate(wb.getWorksheet(REVIEW_SHEET_NAME)!, wb);
  const target = file();
  await wb.xlsx.writeFile(target);
  return target;
}

const colOf = (key: string) => REVIEW_COLUMNS.findIndex((c) => c.key === key) + 1;
const rowNumberOf = (ws: ExcelJS.Worksheet, rowId: string) => {
  for (let r = 3; r <= ws.rowCount; r++) if (ws.getCell(r, 1).value === rowId) return r;
  throw new Error(`row ${rowId} not found`);
};

async function rejection(filePath: string): Promise<ReviewWorkbookError> {
  try {
    await readReviewWorkbook(filePath);
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewWorkbookError);
    return error as ReviewWorkbookError;
  }
  throw new Error("expected rejection");
}

describe("review workbook round trip", () => {
  it("writes a real xlsx and reads back metadata, rows and only whitelisted data keys", async () => {
    const target = await written();
    const bytes = await fs.readFile(target);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");

    const read = await readReviewWorkbook(target);
    expect(read).toMatchObject({ reviewId: "rev-SYNTH-0001", databaseId: "DEMO_TEST_UNIT", vatPeriod: "2026-03" });
    expect(read.rows.map((r) => [r.rowId, r.tool, r.action])).toEqual([
      ["r001", "create_invoice", "import"],
      ["r002", "create_other_liability", "review"],
      ["r003", "create_cash_voucher", "skip"]
    ]);
    const [first, second, third] = read.rows;
    expect(Object.keys(first!.data).sort()).toEqual([...REVIEW_DATA_FIELDS].sort());
    expect(first!.data).not.toHaveProperty("intNote");
    expect(first!.data).not.toHaveProperty("unknownField");
    expect(first!.data).not.toHaveProperty("sourcePdfPath");
    expect(first!.data).not.toHaveProperty("reviewNotes");
    expect(first!.data).toMatchObject({
      partnerIco: "00012345",
      partnerDic: "CZ00012345",
      classificationVAT: "PD",
      paymentType: "",
      accounting: "1Np",
      sourcePages: [1, 2],
      partnerId: null,
      currencyRate: null
    });
    // Source facts are not columns any more; the visible cells are the POHODA values.
    for (const key of ["sourceDocumentNumber", "sourceIssueDate", "sourceTaxDate", "taxMode", "priceHigh", "total"]) expect(first!.data).not.toHaveProperty(key);
    expect(first!.targets).toMatchObject({
      targetDocument: "0042026", targetSymVar: "0042026",
      // Late source (February) in the March VAT period: all four dates on day one.
      targetDate: "2026-03-01", targetDateTax: "2026-03-01", targetDateAccounting: "2026-03-01", targetDateKHDPH: "2026-03-01",
      targetPriceNone: 0, targetPriceHigh: 1000, targetPriceHighVAT: 210, targetTotal: 1210
    });
    expect(second!.reviewNotes).toBe("Duplicita: PK26007 (#72).\nOvěřit, zda jde o platbu kartou");
    // A prepared card flag without a method is shown and read back as Kartou, not blank.
    expect(second!.data).toMatchObject({ paymentType: "creditcard", classificationVAT: "PN", sourcePages: [3] });
    expect(second!.data).not.toHaveProperty("cardPayment");
    expect(second!.targets).toMatchObject({ targetDocument: "Přidělí se z PK", targetSymVar: "Přidělí se z PK", targetPriceNone: 250, targetTotal: 250, targetDateKHDPH: null });
    expect(third!.reviewNotes).toBe("=nejde o vzorec");
    expect(third!.data.text).toBe("=SUM(A1:A2) jen text");
    expect(third!.data.cashAccount).toBe("HP");
    expect(Object.values(third!.data)).not.toContain("=nejde o vzorec");
  });

  it("stores identifiers as text, dates/amounts as typed cells and leading '=' strings as literals", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(await written());
    const ws = wb.getWorksheet(REVIEW_SHEET_NAME)!;
    const ico = ws.getCell(3, colOf("partnerIco"));
    expect(ico.type).toBe(ExcelJS.ValueType.String);
    expect(ico.value).toBe("00012345");
    expect(ws.getCell(3, colOf("targetDate")).value).toBeInstanceOf(Date);
    expect(ws.getCell(3, colOf("targetDate")).numFmt).toBe("dd.mm.yyyy");
    expect(ws.getCell(3, colOf("targetPriceHigh")).type).toBe(ExcelJS.ValueType.Number);
    expect(ws.getCell(3, colOf("targetPriceHigh")).numFmt).toBe("#,##0.00");
    expect(ws.getCell(3, colOf("targetSymVar")).type).toBe(ExcelJS.ValueType.String);
    const text = ws.getCell(5, colOf("text"));
    expect(text.type).toBe(ExcelJS.ValueType.String);
    expect(text.formula).toBeUndefined();
  });

  it("lays out an editable main sheet, read-only examples and very hidden metadata", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(await written());
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([REVIEW_SHEET_NAME, REVIEW_EXAMPLES_SHEET_NAME, "Navod", REVIEW_META_SHEET_NAME]);
    const ws = wb.getWorksheet(REVIEW_SHEET_NAME)!;
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 2, ySplit: 2 });
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.getCell(2, colOf("text")).value).toMatch(/Text dokladu v POHODĚ/);
    expect(ws.getCell(2, colOf("reviewNotes")).value).toMatch(/neimportuje se/);
    expect(ws.getCell(1, colOf("text")).value).toBe("DO POHODY (zapíše se)");
    // No source-only column is written: every visible header is a POHODA value or control.
    expect((ws.getRow(2).values as unknown[]).map(String).filter((h) => /\(zdroj\)/.test(h))).toEqual([]);
    expect(ws.getColumn(colOf("targetPrice3")).hidden).toBe(true);
    expect(ws.getColumn(colOf("targetPrice3")).outlineLevel).toBe(1);
    expect(ws.getColumn(colOf("targetTotal")).hidden).toBe(false);
    expect(ws.getCell(3, colOf("action")).dataValidation).toMatchObject({ type: "list" });

    const examples = wb.getWorksheet(REVIEW_EXAMPLES_SHEET_NAME)!;
    expect(examples.sheetProtection?.sheet).toBe(true);
    expect(examples.getCell(3, 1).value).toBe("FP-2026-0001");

    const meta = wb.getWorksheet(REVIEW_META_SHEET_NAME)!;
    expect(meta.state).toBe("veryHidden");
    const metaKeys: string[] = [];
    meta.eachRow((row) => metaKeys.push(String(row.getCell(1).value)));
    expect(metaKeys).toEqual(["format", "schemaVersion", "reviewId", "databaseId", "vatPeriod", "generatedAt", "notice"]);
  });

  it("always shows Datum splatnosti as written: source due date, else the issue date; blank only for Pokladna", async () => {
    const input = syntheticReview();
    input.rows[0]!.data.dateDue = "2026-02-28"; // invoice with a printed due date (caller alias)
    const target = await written(input);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(target);
    const sheet = wb.getWorksheet(REVIEW_SHEET_NAME)!;
    const due = (rowId: string) => sheet.getCell(rowNumberOf(sheet, rowId), colOf("targetDateDue")).value;
    expect(sheet.getColumn(colOf("targetDateDue")).hidden).toBe(false);
    expect(sheet.getCell(2, colOf("targetDateDue")).value).toBe("Datum splatnosti");
    expect(due("r001")).toEqual(new Date(Date.UTC(2026, 1, 28)));
    // Card receipt (Ostatní závazek) without a printed due date: due on its issue date.
    expect(due("r002")).toEqual(new Date(Date.UTC(2026, 2, 5)));
    // Pokladna: vch:voucherHeader has no due date, so nothing is shown as sent.
    expect(due("r003")).toBeNull();
    const read = await readReviewWorkbook(target);
    expect(read.rows.map((row) => row.targets?.targetDateDue)).toEqual(["2026-02-28", "2026-03-05", null]);
    for (const row of read.rows) expect(row.data).not.toHaveProperty("dateDue");
  });

  it("keeps Datum splatnosti visible in a cash/card-only batch", async () => {
    const input = syntheticReview(); input.rows = input.rows.slice(1);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(await written(input));
    expect(wb.getWorksheet(REVIEW_SHEET_NAME)!.getColumn(colOf("targetDateDue")).hidden).toBe(false);
    input.rows = [input.rows[1]!];
    expect(collapsedReviewColumns(input.rows, input.vatPeriod)).not.toContain("targetDateDue");
  });

  it("keeps ordinary rows quiet and highlights duplicates and invalid amounts without another status column", async () => {
    const input = syntheticReview();
    input.rows.push({ ...input.rows[0]!, rowId: "bad-total", duplicateCheck: undefined, action: "review", data: { ...input.rows[0]!.data, total: 1 }, reviewNotes: "Ověřit součet." });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(await written(input));
    const sheet = wb.getWorksheet(REVIEW_SHEET_NAME)!;
    const color = (row: number, key: string) => (sheet.getCell(row, colOf(key)).fill as ExcelJS.FillPattern).fgColor?.argb;
    expect(REVIEW_COLUMNS.some((c) => c.key === "duplicateCheck")).toBe(false);
    expect(sheet.getCell(3, colOf("reviewNotes")).value).toBeNull();
    expect(color(3, "targetTotal")).toBe("FFFFFFFF");
    expect(color(4, "text")).toBe("FFFFF1F2");
    expect(color(4, "targetDocument")).toBe("FFFFCDD2");
    expect(sheet.getCell(4, colOf("reviewNotes")).text).not.toContain("2026-03-20");
    expect(color(5, "targetTotal")).toBe("FFF1F5F9");
    // A row the import rejects: the Czech reason is in the note and Celkem is marked; the
    // source total stays as given (never replaced by the bucket sum), nothing is invented.
    expect(color(6, "targetTotal")).toBe("FFFEF3C7");
    expect(sheet.getCell(6, colOf("targetTotal")).value).toBe(1);
    expect(sheet.getCell(6, colOf("reviewNotes")).text).toMatch(/^Ověřit součet\.\nSoučet částek .* neodpovídá částce Celkem 1,00; ověřte částky na dokladu\.$/);
    expect(sheet.getColumn(colOf("plannedImport")).hidden).toBe(true);
  });

  it("shows planned late-date and PN transformations in a read-only column that is never imported", async () => {
    const target = await written();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(target);
    const ws = wb.getWorksheet(REVIEW_SHEET_NAME)!;
    const plan = colOf("plannedImport");
    expect(String(ws.getCell(3, plan).value)).toMatch(/Pozdní doklad → data na 1\. den období 01\.03\.2026/);
    expect(String(ws.getCell(3, plan).value)).toMatch(/KH 01\.03\.2026/);
    expect(String(ws.getCell(4, plan).value)).toMatch(/PN: celá částka 250,00 v sazbě 0 %, bez data KH/);
    expect(String(ws.getCell(4, plan).value)).toMatch(/Doklad K \+ další číslo řady PK/);

    const edited = await edit(target, (sheet) => {
      sheet.getCell(3, plan).value = "1.1.2020 přepsáno uživatelem";
      sheet.getCell(3, colOf("sourcePdfPath")).value = "/etc/passwd";
    });
    const read = await readReviewWorkbook(edited);
    expect(read.rows[0]!.targets!.targetDate).toBe("2026-03-01");
    expect(JSON.stringify(read.rows)).not.toContain("passwd");
    expect(JSON.stringify(read.rows)).not.toContain("přepsáno");
  });
});

describe("user edits", () => {
  it("reads edited data and target cells separately, with actions and notes", async () => {
    const edited = await edit(await written(), (ws) => {
      const r = rowNumberOf(ws, "r002");
      ws.getCell(r, colOf("action")).value = "Importovat";
      ws.getCell(r, colOf("reviewNotes")).value = "Kontrolováno, karta";
      ws.getCell(r, colOf("targetTotal")).value = "1 234,50";
      ws.getCell(r, colOf("targetPriceNone")).value = 1234.5;
      ws.getCell(r, colOf("targetDate")).value = "06.03.2026";
      ws.getCell(r, colOf("targetDateTax")).value = new Date(Date.UTC(2026, 2, 7));
      ws.getCell(r, colOf("targetSymVar")).value = 42026;
      ws.getCell(r, colOf("targetDateDue")).value = "2026-03-08";
      ws.getCell(r, colOf("classificationVAT")).value = "PD";
      ws.getCell(r, colOf("paymentType")).value = "převodem";
      ws.getCell(r, colOf("currencyRate")).value = "25,125";
      ws.getCell(r, colOf("sourcePages")).value = "3-5, 7";
      const r3 = rowNumberOf(ws, "r003");
      ws.getCell(r3, colOf("action")).value = null;
    });
    const read = await readReviewWorkbook(edited);
    const row = read.rows.find((r) => r.rowId === "r002")!;
    expect(row.action).toBe("import");
    expect(row.reviewNotes).toBe("Kontrolováno, karta");
    expect(row.data).toMatchObject({ classificationVAT: "PD", paymentType: "draft", currencyRate: 25.125, sourcePages: [3, 4, 5, 7] });
    // Target cells never become data keys in the codec; the import maps them deliberately.
    expect(row.targets).toMatchObject({ targetTotal: "1234.50", targetPriceNone: 1234.5, targetDate: "2026-03-06", targetDateTax: "2026-03-07", targetSymVar: "42026", targetDateDue: "2026-03-08" });
    for (const key of ["total", "priceNone", "sourceIssueDate", "sourceTaxDate", "sourceSymVar", "dateDue", "sourceDueDate"]) expect(row.data).not.toHaveProperty(key);
    expect(JSON.stringify(row.data)).not.toContain("Kontrolováno");
    expect(read.rows.find((r) => r.rowId === "r003")!.action).toBe("review");
  });

  it("preserves blank versus zero amounts", async () => {
    const edited = await edit(await written(), (ws) => {
      ws.getCell(3, colOf("targetPriceNone")).value = null;
      ws.getCell(3, colOf("targetRounding")).value = 0;
      ws.getCell(3, colOf("targetPriceLowVAT")).value = "0";
    });
    const targets = (await readReviewWorkbook(edited)).rows[0]!.targets!;
    expect(targets.targetPriceNone).toBeNull();
    expect(targets.targetRounding).toBe(0);
    expect(targets.targetPriceLowVAT).toBe("0");
  });

  it("keeps row identity after sorting, reordering and deleting rows, and ignores helper columns", async () => {
    const edited = await edit(await written(), (ws) => {
      const last = colOf("sourcePdfPath");
      const snapshot = [3, 4, 5].map((r) => Array.from({ length: last }, (_, i) => ws.getCell(r, i + 1).value));
      // Simulate a sort by supplier: r003, r001; delete r002.
      for (const [target, source] of [[3, 2], [4, 0]] as const) {
        snapshot[source]!.forEach((value, i) => { ws.getCell(target, i + 1).value = value; });
      }
      ws.spliceRows(5, 1);
      ws.getCell(2, last + 1).value = "Moje pomocná kontrola";
      ws.getCell(3, last + 1).value = { formula: "1+1", result: 2 };
    });
    const read = await readReviewWorkbook(edited);
    expect(read.rows.map((r) => r.rowId)).toEqual(["r003", "r001"]);
    expect(read.rows[1]!.data.partnerIco).toBe("00012345");
  });

  it("converts numeric identifiers safely and rejects ones that lost precision or became dates", async () => {
    const edited = await edit(await written(), (ws) => {
      ws.getCell(3, colOf("partnerIco")).value = 42026;
    });
    expect((await readReviewWorkbook(edited)).rows[0]!.data.partnerIco).toBe("42026");

    const broken = await edit(await written(), (ws) => {
      ws.getCell(3, colOf("targetDocument")).value = 1.2345678901234567e19;
      // Pasting a date carries its date format along, overriding the column's text format.
      ws.getCell(4, colOf("partnerIco")).value = new Date(Date.UTC(2026, 0, 2));
      // ExcelJS shares loaded style objects between cells; assign a fresh style to change only this cell.
      const cell = ws.getCell(4, colOf("partnerIco"));
      cell.style = { ...cell.style, numFmt: "dd.mm.yyyy" };
    });
    const error = await rejection(broken);
    expect(error.issues.map((i) => i.code).sort()).toEqual(["IDENTIFIER_NOT_TEXT", "TEXT_INVALID"]);
    expect(error.issues[0]!.rowId).toBeTruthy();
  });

  it("rejects invalid enum, date, number and page values with cell addresses", async () => {
    const edited = await edit(await written(), (ws) => {
      ws.getCell(3, colOf("action")).value = "Možná";
      ws.getCell(3, colOf("targetDate")).value = "31.02.2026";
      ws.getCell(3, colOf("partnerId")).value = "12.5";
      ws.getCell(3, colOf("sourcePages")).value = "0";
      ws.getCell(3, colOf("tool")).value = null;
      ws.getCell(3, colOf("paymentType")).value = true;
      ws.getCell(4, colOf("targetDateDue")).value = new Date(Date.UTC(2026, 2, 5, 13, 30));
    });
    const error = await rejection(edited);
    expect(error.issues.map((i) => i.code).sort()).toEqual([
      "ACTION_INVALID", "DATE_INVALID", "DATE_INVALID", "NUMBER_INVALID", "PAGES_INVALID", "TEXT_INVALID", "TOOL_INVALID"
    ]);
    expect(error.issues.find((i) => i.code === "ACTION_INVALID")!.cell).toBe("B3");
  });
});

describe("structural rejection", () => {
  it("rejects formulas and shared formulas even with cached results", async () => {
    const edited = await edit(await written(), (ws) => {
      ws.getCell(3, colOf("targetTotal")).value = { formula: "W3+X3", result: 1210 };
      ws.getCell(4, colOf("text")).value = { formula: "\"x\"", result: "x" };
      ws.getCell(5, colOf("text")).value = { sharedFormula: ws.getCell(4, colOf("text")).address, result: "x" } as any;
    });
    const error = await rejection(edited);
    const formulaIssues = error.issues.filter((i) => i.code === "FORMULA_NOT_ALLOWED");
    expect(formulaIssues.length).toBeGreaterThanOrEqual(2);
    const letter = new ExcelJS.Workbook().addWorksheet("x").getColumn(colOf("targetTotal")).letter;
    expect(formulaIssues).toContainEqual(expect.objectContaining({ sheet: REVIEW_SHEET_NAME, cell: `${letter}3`, rowId: "r001" }));
  });

  it("rejects error cells", async () => {
    const edited = await edit(await written(), (ws) => { ws.getCell(3, colOf("targetTotal")).value = { error: "#REF!" } as any; });
    expect((await rejection(edited)).issues[0]!.code).toBe("CELL_ERROR");
  });

  it("rejects missing and duplicate required columns", async () => {
    const missing = await edit(await written(), (ws) => { ws.spliceColumns(colOf("partnerIco"), 1); });
    const missingError = await rejection(missing);
    expect(missingError.issues).toEqual([expect.objectContaining({ code: "MISSING_COLUMN", message: expect.stringContaining("partnerIco") })]);

    const duplicate = await edit(await written(), (ws) => { ws.getCell(2, colOf("sourcePdfPath") + 1).value = "Celkem"; });
    expect((await rejection(duplicate)).issues[0]!.code).toBe("DUPLICATE_COLUMN");
  });

  it("accepts a header written as the internal key", async () => {
    const edited = await edit(await written(), (ws) => { ws.getCell(2, colOf("accounting")).value = "accounting"; ws.getCell(2, colOf("targetTotal")).value = "targetTotal"; });
    const row = (await readReviewWorkbook(edited)).rows[0]!;
    expect(row.data.accounting).toBe("1Np");
    expect(row.targets!.targetTotal).toBe(1210);
  });

  it("rejects duplicate and blank row IDs on non-empty rows but skips empty rows", async () => {
    const edited = await edit(await written(), (ws) => {
      ws.getCell(4, 1).value = "r001";
      ws.getCell(5, 1).value = null;
      ws.getCell(8, colOf("reviewNotes")).value = "  ";
    });
    const codes = (await rejection(edited)).issues.map((i) => i.code).sort();
    expect(codes).toEqual(["DUPLICATE_ROW_ID", "ROW_ID_INVALID"]);
  });

  it("rejects merged cells in the table", async () => {
    const edited = await edit(await written(), (ws) => { ws.mergeCells(3, colOf("text"), 3, colOf("partnerName")); });
    expect((await rejection(edited)).issues.map((i) => i.code)).toContain("MERGED_CELL");
  });

  it("validates metadata version and identifiers", async () => {
    const version = await edit(await written(), (_ws, wb) => { wb.getWorksheet(REVIEW_META_SHEET_NAME)!.getCell(2, 2).value = "2"; });
    expect((await rejection(version)).issues.map((i) => i.code)).toEqual(["META_VERSION"]);

    const blankId = await edit(await written(), (_ws, wb) => { wb.getWorksheet(REVIEW_META_SHEET_NAME)!.getCell(3, 2).value = null; });
    expect((await rejection(blankId)).issues.map((i) => i.code)).toEqual(["META_INVALID"]);

    const noMeta = await edit(await written(), (_ws, wb) => { wb.removeWorksheet(wb.getWorksheet(REVIEW_META_SHEET_NAME)!.id); });
    expect((await rejection(noMeta)).issues.map((i) => i.code)).toContain("META_MISSING");
  });

  it("rejects more than the record limit", async () => {
    const edited = await edit(await written(), (ws) => {
      for (let i = 0; i < REVIEW_MAX_RECORDS; i++) {
        const r = 6 + i;
        ws.getCell(r, 1).value = `extra-${i}`;
        ws.getCell(r, colOf("tool")).value = "Pokladní výdej";
      }
    });
    expect((await rejection(edited)).issues.map((i) => i.code)).toContain("TOO_MANY_ROWS");
  });

  it("rejects unsupported formats, oversized and malformed files", async () => {
    const xls = file(".xls");
    await fs.writeFile(xls, "x");
    expect((await rejection(xls)).issues[0]).toMatchObject({ code: "UNSUPPORTED_FORMAT", message: expect.stringContaining("Save As") });
    const xlsm = file(".xlsm");
    await fs.copyFile(await written(), xlsm);
    expect((await rejection(xlsm)).issues[0]!.code).toBe("UNSUPPORTED_FORMAT");

    const garbage = file();
    await fs.writeFile(garbage, "this is not a workbook at all");
    expect((await rejection(garbage)).issues[0]!.code).toBe("MALFORMED_WORKBOOK");

    const truncated = file();
    const full = await fs.readFile(await written());
    await fs.writeFile(truncated, full.subarray(0, Math.floor(full.length / 2)));
    expect((await rejection(truncated)).issues[0]!.code).toBe("MALFORMED_WORKBOOK");

    const huge = file();
    const handle = await fs.open(huge, "w");
    await handle.truncate(11 * 1024 * 1024);
    await handle.close();
    expect((await rejection(huge)).issues[0]!.code).toBe("FILE_TOO_LARGE");

    const otherWorkbook = file();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Sheet1").getCell("A1").value = "hello";
    await wb.xlsx.writeFile(otherWorkbook);
    const codes = (await rejection(otherWorkbook)).issues.map((i) => i.code);
    expect(codes).toContain("META_MISSING");
    expect(codes).toContain("SHEET_MISSING");
  });
});

describe("write validation", () => {
  it("rejects duplicate or blank row IDs, bad enums, too many rows and non-xlsx targets", async () => {
    const input = syntheticReview();
    input.rows[1]!.rowId = "r001";
    input.rows[2]!.rowId = " ";
    (input.rows[0] as any).action = "maybe";
    await expect(writeReviewWorkbook(input, file())).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_ROW_ID" }),
        expect.objectContaining({ code: "ROW_ID_INVALID" }),
        expect.objectContaining({ code: "ACTION_INVALID" })
      ])
    });

    const many = syntheticReview();
    many.rows = Array.from({ length: REVIEW_MAX_RECORDS + 1 }, (_, i) => ({ ...many.rows[0]!, rowId: `r${i}` }));
    await expect(writeReviewWorkbook(many, file())).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "TOO_MANY_ROWS" })] });

    const badPeriod = { ...syntheticReview(), vatPeriod: "2026-13" };
    await expect(writeReviewWorkbook(badPeriod, file())).rejects.toBeInstanceOf(ReviewWorkbookError);
    await expect(writeReviewWorkbook(syntheticReview(), file(".xls"))).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "UNSUPPORTED_FORMAT" })] });
  });

  it("writes an empty review with a placeholder examples sheet", async () => {
    const target = await written({ ...syntheticReview(), rows: [], examples: [] });
    const read = await readReviewWorkbook(target);
    expect(read.rows).toEqual([]);
  });
});

describe.runIf(process.env.REVIEW_SAMPLE_OUT)("synthetic visual sample", () => {
  it("writes the synthetic QA sample", async () => {
    await writeReviewWorkbook(syntheticReview(), process.env.REVIEW_SAMPLE_OUT!);
    expect((await readReviewWorkbook(process.env.REVIEW_SAMPLE_OUT!)).rows).toHaveLength(3);
  });
});

describe("column visibility contract", () => {
  const [invoice, card, cash] = syntheticReview().rows as [ReviewRow, ReviewRow, ReviewRow];
  const asImport = (row: ReviewRow): ReviewRow => ({ ...row, action: "import", data: { ...row.data } });
  const scenarios: Record<string, ReviewRow[]> = {
    invoice: [asImport(invoice)],
    card: [asImport(card)],
    cash: [asImport(cash)],
    mixed: [asImport(invoice), asImport(card), asImport(cash)]
  };
  const visible = async (rows: ReviewRow[]) => {
    const input = syntheticReview(); input.rows = rows;
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(await written(input));
    const ws = wb.getWorksheet(REVIEW_SHEET_NAME)!;
    return new Set(REVIEW_COLUMNS.filter((c) => !ws.getColumn(colOf(c.key)).hidden).map((c) => c.key));
  };
  const ALWAYS = ["rowId", "action", "reviewNotes", "tool", "text", "partnerName", "partnerIco", "partnerDic", "partnerCountry",
    "targetDocument", "targetSymVar", "targetDate", "targetDateTax", "targetDateAccounting", "targetDateKHDPH", "targetDateDue",
    "paymentType", "targetTotal", "accounting", "classificationVAT"];

  it.each(Object.keys(scenarios))("keeps essential review and accounting fields visible for %s previews, even when blank", async (name) => {
    const rows = scenarios[name]!.map((row) => ({ ...row, data: { ...row.data, accounting: "" } }));
    const shown = await visible(rows);
    for (const key of ALWAYS) expect(shown, key).toContain(key);
    expect(shown.has("cashAccount")).toBe(rows.some((row) => row.tool === "create_cash_voucher"));
    for (const key of ["plannedImport", "sourcePdfPath", "intNote", "partnerStreet", "targetPrice3", "currency"]) expect(shown.has(key), key).toBe(false);
  });

  it("collapses target fields nothing writes, per document kind", () => {
    const hidden = (rows: ReviewRow[]) => collapsedReviewColumns(rows, "2026-03");
    // Invoice: CZ so no currency, no 12 % bucket, no rounding.
    for (const key of ["currency", "targetPriceLow", "targetPriceLowVAT", "targetRounding", "cashAccount"]) expect(hidden(scenarios.invoice!), key).toContain(key);
    for (const key of ["targetDateDue", "targetPriceNone", "targetPriceHigh"]) expect(hidden(scenarios.invoice!), key).not.toContain(key);
    // Datum splatnosti is always visible (blank for Pokladna); PN card has no rate buckets.
    for (const name of ["card", "cash"]) expect(hidden(scenarios[name]!)).not.toContain("targetDateDue");
    expect(hidden(scenarios.card!)).toContain("targetPriceHigh");
    // Mixed batches keep fields any row writes; a zero rounding is a value, not a blank.
    const mixed = hidden(scenarios.mixed!);
    for (const key of ["targetDateDue", "targetPriceLow", "targetPriceHigh", "targetPriceNone", "targetRounding", "cashAccount"]) expect(mixed, key).not.toContain(key);
    expect(mixed).toContain("currency");
  });

  it("shows populated optional values and marks the visible field for a policy problem", () => {
    const hidden = (data: Record<string, unknown>, row: ReviewRow = invoice) => collapsedReviewColumns([{ ...asImport(row), data: { ...row.data, ...data } }], "2026-03");
    expect(hidden({ paymentType: "draft", dateDue: "2026-03-01" }, card)).not.toContain("targetDateDue");
    expect(hidden({ priceNone: null, roundingAmount: 0, total: 1210 })).not.toContain("targetRounding");
    expect(hidden({ partnerStreet: "Ulice 1" })).not.toContain("partnerStreet");
    expect(hidden({ currency: "EUR", taxMode: "nonTax", classificationVAT: "PN", priceNone: 1210, priceHigh: null, priceHighVAT: null, priceHighSum: null })).not.toContain("currency");
    // A policy problem reveals the matching visible target column, never a source column.
    const noSum = hidden({ priceNone: null, priceHigh: null, priceHighVAT: null, priceHighSum: null });
    expect(noSum).not.toContain("targetPriceNone");
    const flagged = hidden({ taxMode: "auto", partnerVatStatus: "payer", vatStatusEvidence: "" });
    expect(flagged).not.toContain("classificationVAT");
    expect([...flagged].some((key) => !REVIEW_COLUMNS.some((c) => c.key === key))).toBe(false);
    expect(collapsedReviewColumns([{ ...asImport(cash), data: { ...cash.data, cashAccount: "" } }], "2026-03")).not.toContain("cashAccount");
  });

  it("shows POHODA Doklad/VS as values the codec returns as targets, never as data", async () => {
    const target = await written({ ...syntheticReview(), rows: [asImport(invoice), asImport(card), asImport(cash)] });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(target);
    const ws = wb.getWorksheet(REVIEW_SHEET_NAME)!;
    expect(ws.getCell(2, colOf("targetDocument")).value).toBe("Doklad v POHODĚ");
    expect(ws.getCell(2, colOf("targetSymVar")).value).toBe("VS v POHODĚ");
    expect([3, 4, 5].map((r) => [ws.getCell(r, colOf("targetDocument")).value, ws.getCell(r, colOf("targetSymVar")).value])).toEqual([
      ["0042026", "0042026"], ["Přidělí se z PK", "Přidělí se z PK"], [null, null]
    ]);
    const before = await readReviewWorkbook(target);
    const changed = await edit(target, (sheet) => { sheet.getCell(3, colOf("targetDocument")).value = "HACK"; sheet.getCell(3, colOf("targetSymVar")).value = "1"; });
    const after = await readReviewWorkbook(changed);
    expect(after.rows.map((r) => r.data)).toEqual(before.rows.map((r) => r.data));
    expect(after.rows[0]!.targets).toMatchObject({ targetDocument: "HACK", targetSymVar: "1" });
    // Older previews: legacy "(vypočteno)" headers and placeholders still read as targets.
    const legacy = await edit(target, (sheet) => {
      sheet.getCell(2, colOf("targetDocument")).value = "Doklad v POHODĚ (vypočteno)";
      sheet.getCell(4, colOf("targetDocument")).value = "K + další č. PK";
      sheet.getCell(4, colOf("targetSymVar")).value = "další č. PK";
    });
    expect((await readReviewWorkbook(legacy)).rows[1]!.targets).toMatchObject({ targetDocument: "Přidělí se z PK", targetSymVar: "Přidělí se z PK" });
    const without = await edit(target, (sheet) => { sheet.spliceColumns(colOf("targetDocument"), 2); });
    expect((await readReviewWorkbook(without)).rows.map((r) => r.data)).toEqual(before.rows.map((r) => r.data));
  });

  it("keeps edits in a collapsed column and the reviewer's visibility choices on duplicate refresh", async () => {
    const input = syntheticReview(); input.rows = [asImport(invoice)];
    const original = await written(input);
    const changed = await edit(original, (ws) => {
      ws.getColumn(colOf("targetRounding")).hidden = false; // reviewer expands a collapsed field
      ws.getCell(3, colOf("targetRounding")).value = 0.4;
      ws.getColumn(colOf("partnerDic")).hidden = true; // and hides one they do not need
      ws.getCell(3, colOf("accounting")).value = "518";
    });
    const sha = createHash("sha256").update(await fs.readFile(changed)).digest("hex");
    await updateReviewDuplicateChecks(changed, { [invoice.rowId]: { status: "clear", checkedAt: "2026-03-21T10:00:00Z", message: "", matches: [], matchCount: 0 } }, sha);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(changed);
    const ws = wb.getWorksheet(REVIEW_SHEET_NAME)!;
    expect(ws.getColumn(colOf("targetRounding")).hidden).toBe(false);
    expect(ws.getColumn(colOf("partnerDic")).hidden).toBe(true);
    expect(ws.getColumn(colOf("currency")).hidden).toBe(true);
    const row = (await readReviewWorkbook(changed)).rows[0]!;
    expect(row.data).toMatchObject({ accounting: "518" });
    expect(row.targets).toMatchObject({ targetRounding: 0.4 });
  });

  it("does not write Datum úhrady, yet still reads it from an older workbook that has it", async () => {
    const target = await written();
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(target);
    const headers = (wb.getWorksheet(REVIEW_SHEET_NAME)!.getRow(2).values as unknown[]).map(String);
    expect(headers).not.toContain("Datum úhrady (zdroj)");
    expect(REVIEW_COLUMNS.map((c) => c.key)).not.toContain("sourcePaymentDate");
    expect(REVIEW_DATA_FIELDS).not.toContain("sourcePaymentDate");
    // Absent column: the parser returns no value, so the import keeps the prepared date.
    expect((await readReviewWorkbook(target)).rows.every((r) => !("sourcePaymentDate" in r.data))).toBe(true);
    const legacy = await edit(target, (ws) => {
      const column = ws.columnCount + 1;
      ws.getCell(2, column).value = REVIEW_LEGACY_COLUMNS[0]!.label;
      ws.getCell(rowNumberOf(ws, "r003"), column).value = "2026-03-11";
    });
    const rows = (await readReviewWorkbook(legacy)).rows;
    expect(rows.find((r) => r.rowId === "r003")!.data.sourcePaymentDate).toBe("2026-03-11");
    expect(rows.find((r) => r.rowId === "r001")!.data.sourcePaymentDate).toBe("");
  });
});

/** Re-saves a workbook the way Open XML SDK writers do: x:-prefixed SpreadsheetML,
 * absolute relationship targets and a non-conventional VML part name. Synthetic data. */
async function asOpenXmlSdkPackage(source: string, mutateSheetXml: (xml: string) => string = (x) => x): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(source));
  const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  for (const name of Object.keys(zip.files).filter((n) => n.endsWith(".xml") && n.startsWith("xl/"))) {
    let xml = await zip.file(name)!.async("string");
    if (!xml.includes(`xmlns="${MAIN}"`)) continue;
    xml = xml.replace(/<(\/?)(?![?!])([A-Za-z])/g, "<$1x:$2").replace(`xmlns="${MAIN}"`, `xmlns:x="${MAIN}"`);
    zip.file(name, name === "xl/worksheets/sheet1.xml" ? mutateSheetXml(xml) : xml);
  }
  for (const name of Object.keys(zip.files).filter((n) => n.endsWith(".rels"))) {
    const dir = path.posix.dirname(path.posix.dirname(name));
    const xml = await zip.file(name)!.async("string");
    zip.file(name, xml.replace(/Target="([^"]+)"/g, (_m, t: string) => `Target="/${path.posix.normalize(path.posix.join(dir === "." ? "" : dir, t))}"`.replace("vmlDrawing1.vml", "vmldrawing.vml")));
  }
  const vml = Object.keys(zip.files).find((n) => /vmlDrawing1\.vml$/.test(n));
  if (vml) { zip.file("xl/drawings/vmldrawing.vml", await zip.file(vml)!.async("uint8array")); zip.remove(vml); }
  const target = file();
  await fs.writeFile(target, await zip.generateAsync({ type: "nodebuffer" }));
  return target;
}

describe("workbooks re-saved by other OOXML writers", () => {
  it("reads prefixed-namespace packages with absolute relationship targets", async () => {
    const original = await written();
    const converted = await asOpenXmlSdkPackage(original);
    await expect(new ExcelJS.Workbook().xlsx.readFile(converted)).rejects.toThrow(); // the ExcelJS limitation
    const [a, b] = [await readReviewWorkbook(original), await readReviewWorkbook(converted)];
    expect(b).toEqual(a);
  });

  it("keeps formula and hidden-row guards on normalized packages", async () => {
    const original = await written();
    const totalRef = `${new ExcelJS.Workbook().addWorksheet("x").getColumn(colOf("targetTotal")).letter}3`;
    const formula = await asOpenXmlSdkPackage(original, (xml) => xml.replace(new RegExp(`<x:c r="${totalRef}"([^>]*?)(/>|>.*?</x:c>)`), `<x:c r="${totalRef}"$1><x:f>100+21</x:f><x:v>121</x:v></x:c>`));
    expect((await rejection(formula)).issues.map((i) => i.code)).toContain("FORMULA_NOT_ALLOWED");
    const hidden = await asOpenXmlSdkPackage(original, (xml) => xml.replace('<x:row r="3"', '<x:row r="3" hidden="1"'));
    expect((await rejection(hidden)).issues.map((i) => i.code)).toContain("HIDDEN_ROW");
  });

  it("refreshes duplicate checks on such a package without losing edits", async () => {
    const converted = await asOpenXmlSdkPackage(await written());
    const sha = createHash("sha256").update(await fs.readFile(converted)).digest("hex");
    await updateReviewDuplicateChecks(converted, { r001: { status: "possible", checkedAt: "2026-03-21T10:00:00Z", message: "", matches: [{ location: "pohoda", reason: "reference", agenda: "invoice", type: "receivedInvoice", id: "9", number: "FP1", date: "2026-02-14", total: 1210, currency: "CZK" }], matchCount: 1 } }, sha);
    const row = (await readReviewWorkbook(converted)).rows.find((r) => r.rowId === "r001")!;
    expect(row.action).toBe("review");
    expect(row.reviewNotes).toContain("FP1");
    expect(row.targets!.targetDocument).toBe("0042026");
  });
});
