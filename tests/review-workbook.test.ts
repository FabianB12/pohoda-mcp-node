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
  readReviewWorkbook,
  writeReviewWorkbook
} from "../src/mcp/review-workbook.js";

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
      sourceDocumentNumber: "0042026",
      sourceSymVar: "0042026",
      sourceIssueDate: "2026-02-14",
      sourceTaxDate: "2026-02-14",
      sourcePaymentDate: "",
      taxMode: "taxable", classificationVAT: "PD",
      sourceChargesVat: true,
      cardPayment: false,
      priceNone: 0,
      priceLow: null,
      priceHigh: 1000,
      priceHighVAT: 210,
      priceHighSum: 1210,
      total: 1210,
      accounting: "1Np",
      sourcePages: [1, 2],
      partnerId: null,
      currencyRate: null
    });
    expect(second!.reviewNotes).toBe("Duplicita: PK26007 (#72).\nOvěřit, zda jde o platbu kartou");
    expect(second!.data).toMatchObject({ taxMode: "nonTax", cardPayment: true, sourceChargesVat: false, priceNone: 250, total: 250, sourcePages: [3] });
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
    expect(ws.getCell(3, colOf("sourceIssueDate")).value).toBeInstanceOf(Date);
    expect(ws.getCell(3, colOf("priceHigh")).type).toBe(ExcelJS.ValueType.Number);
    expect(ws.getCell(3, colOf("priceHigh")).numFmt).toBe("#,##0.00");
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
    expect(ws.getCell(2, colOf("priceHigh")).value).toMatch(/zdroj/);
    expect(ws.getColumn(colOf("price3")).hidden).toBe(true);
    expect(ws.getColumn(colOf("price3")).outlineLevel).toBe(1);
    expect(ws.getColumn(colOf("total")).hidden).toBe(false);
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

  it("keeps ordinary rows quiet and highlights duplicates and invalid amounts without another status column", async () => {
    const input = syntheticReview();
    input.rows.push({ ...input.rows[0]!, rowId: "bad-total", duplicateCheck: undefined, action: "review", data: { ...input.rows[0]!.data, total: 1 }, reviewNotes: "Ověřit součet." });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(await written(input));
    const sheet = wb.getWorksheet(REVIEW_SHEET_NAME)!;
    const color = (row: number, key: string) => (sheet.getCell(row, colOf(key)).fill as ExcelJS.FillPattern).fgColor?.argb;
    expect(REVIEW_COLUMNS.some((c) => c.key === "duplicateCheck")).toBe(false);
    expect(sheet.getCell(3, colOf("reviewNotes")).value).toBeNull();
    expect(color(3, "total")).toBe("FFFFFFFF");
    expect(color(4, "text")).toBe("FFFFF1F2");
    expect(color(4, "sourceDocumentNumber")).toBe("FFFFCDD2");
    expect(sheet.getCell(4, colOf("reviewNotes")).text).not.toContain("2026-03-20");
    expect(color(5, "total")).toBe("FFF1F5F9");
    expect(color(6, "total")).toBe("FFFEF3C7");
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
    expect(read.rows[0]!.data.sourceIssueDate).toBe("2026-02-14");
    expect(JSON.stringify(read.rows)).not.toContain("passwd");
    expect(JSON.stringify(read.rows)).not.toContain("přepsáno");
  });
});

describe("user edits", () => {
  it("reads edited values, actions, dates, tax mode and notes from visible cells", async () => {
    const edited = await edit(await written(), (ws) => {
      const r = rowNumberOf(ws, "r002");
      ws.getCell(r, colOf("action")).value = "Importovat";
      ws.getCell(r, colOf("reviewNotes")).value = "Kontrolováno, karta";
      ws.getCell(r, colOf("total")).value = "1 234,50";
      ws.getCell(r, colOf("priceNone")).value = 1234.5;
      ws.getCell(r, colOf("sourceIssueDate")).value = "06.03.2026";
      ws.getCell(r, colOf("sourceTaxDate")).value = new Date(Date.UTC(2026, 2, 7));
      ws.getCell(r, colOf("sourcePaymentDate")).value = "2026-03-08";
      ws.getCell(r, colOf("taxMode")).value = "Daňový (odpočet DPH)";
      ws.getCell(r, colOf("sourceChargesVat")).value = null;
      ws.getCell(r, colOf("currencyRate")).value = "25,125";
      ws.getCell(r, colOf("sourcePages")).value = "3-5, 7";
      const r3 = rowNumberOf(ws, "r003");
      ws.getCell(r3, colOf("action")).value = null;
    });
    const read = await readReviewWorkbook(edited);
    const row = read.rows.find((r) => r.rowId === "r002")!;
    expect(row.action).toBe("import");
    expect(row.reviewNotes).toBe("Kontrolováno, karta");
    expect(row.data).toMatchObject({
      total: "1234.50",
      priceNone: 1234.5,
      sourceIssueDate: "2026-03-06",
      sourceTaxDate: "2026-03-07",
      sourcePaymentDate: "2026-03-08",
      taxMode: "taxable",
      sourceChargesVat: null,
      currencyRate: 25.125,
      sourcePages: [3, 4, 5, 7]
    });
    expect(JSON.stringify(row.data)).not.toContain("Kontrolováno");
    expect(read.rows.find((r) => r.rowId === "r003")!.action).toBe("review");
  });

  it("preserves blank versus zero amounts", async () => {
    const edited = await edit(await written(), (ws) => {
      ws.getCell(3, colOf("priceNone")).value = null;
      ws.getCell(3, colOf("roundingAmount")).value = 0;
      ws.getCell(3, colOf("priceLowVAT")).value = "0";
    });
    const data = (await readReviewWorkbook(edited)).rows[0]!.data;
    expect(data.priceNone).toBeNull();
    expect(data.roundingAmount).toBe(0);
    expect(data.priceLowVAT).toBe("0");
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
      ws.getCell(3, colOf("sourceSymVar")).value = 42026;
    });
    expect((await readReviewWorkbook(edited)).rows[0]!.data.sourceSymVar).toBe("42026");

    const broken = await edit(await written(), (ws) => {
      ws.getCell(3, colOf("sourceDocumentNumber")).value = 1.2345678901234567e19;
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
      ws.getCell(3, colOf("sourceIssueDate")).value = "31.02.2026";
      ws.getCell(3, colOf("partnerId")).value = "12.5";
      ws.getCell(3, colOf("sourcePages")).value = "0";
      ws.getCell(3, colOf("taxMode")).value = "nevím";
      ws.getCell(3, colOf("tool")).value = null;
      ws.getCell(3, colOf("cardPayment")).value = "snad";
      ws.getCell(4, colOf("sourceTaxDate")).value = new Date(Date.UTC(2026, 2, 5, 13, 30));
    });
    const error = await rejection(edited);
    expect(error.issues.map((i) => i.code).sort()).toEqual([
      "ACTION_INVALID", "BOOLEAN_INVALID", "DATE_INVALID", "DATE_INVALID", "NUMBER_INVALID", "PAGES_INVALID", "TAX_MODE_INVALID", "TOOL_INVALID"
    ]);
    expect(error.issues.find((i) => i.code === "ACTION_INVALID")!.cell).toBe("B3");
  });
});

describe("structural rejection", () => {
  it("rejects formulas and shared formulas even with cached results", async () => {
    const edited = await edit(await written(), (ws) => {
      ws.getCell(3, colOf("total")).value = { formula: "W3+X3", result: 1210 };
      ws.getCell(4, colOf("text")).value = { formula: "\"x\"", result: "x" };
      ws.getCell(5, colOf("text")).value = { sharedFormula: ws.getCell(4, colOf("text")).address, result: "x" } as any;
    });
    const error = await rejection(edited);
    const formulaIssues = error.issues.filter((i) => i.code === "FORMULA_NOT_ALLOWED");
    expect(formulaIssues.length).toBeGreaterThanOrEqual(2);
    const letter = new ExcelJS.Workbook().addWorksheet("x").getColumn(colOf("total")).letter;
    expect(formulaIssues).toContainEqual(expect.objectContaining({ sheet: REVIEW_SHEET_NAME, cell: `${letter}3`, rowId: "r001" }));
  });

  it("rejects error cells", async () => {
    const edited = await edit(await written(), (ws) => { ws.getCell(3, colOf("total")).value = { error: "#REF!" } as any; });
    expect((await rejection(edited)).issues[0]!.code).toBe("CELL_ERROR");
  });

  it("rejects missing and duplicate required columns", async () => {
    const missing = await edit(await written(), (ws) => { ws.spliceColumns(colOf("partnerIco"), 1); });
    const missingError = await rejection(missing);
    expect(missingError.issues).toEqual([expect.objectContaining({ code: "MISSING_COLUMN", message: expect.stringContaining("partnerIco") })]);

    const duplicate = await edit(await written(), (ws) => { ws.getCell(2, colOf("sourcePdfPath") + 1).value = "Celkem k úhradě (zdroj)"; });
    expect((await rejection(duplicate)).issues[0]!.code).toBe("DUPLICATE_COLUMN");
  });

  it("accepts a header written as the internal key", async () => {
    const edited = await edit(await written(), (ws) => { ws.getCell(2, colOf("total")).value = "total"; });
    expect((await readReviewWorkbook(edited)).rows[0]!.data.total).toBe(1210);
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
