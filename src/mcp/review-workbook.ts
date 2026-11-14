/**
 * Reviewed-XLSX workbook for the expense import flow:
 * PDFs -> read-only prepare -> user edits this workbook -> explicit import of the edited file.
 *
 * Design rules:
 * - The visible "Doklady" sheet is the only authoritative import data. The hidden `_meta`
 *   sheet carries only format/version/reviewId/databaseId/vatPeriod and never field values.
 * - Columns are matched by their Czech header label (or the internal key), so users may
 *   reorder, sort, filter and delete rows. Row identity is the visible `rowId` column.
 * - The parser returns only whitelisted data keys (REVIEW_DATA_FIELDS). Review notes are
 *   returned separately and are never copied into `data`/`intNote`.
 * - Formulas, error cells and merged cells in recognised columns are rejected; strings that
 *   start with "=" are written as literal text. Nothing is ever evaluated.
 * - Display-only columns (planned import transformations, source PDF path) are ignored on
 *   read; the import workflow recomputes the plan from the edited source cells and decides
 *   allowed source paths from its own manifest.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { resolveExpensePolicy } from "../pohoda/expense-policy.js";
import type { ReviewAction, ReviewRow, ReviewTool, ReviewWorkbook, ReviewWorkbookRead } from "./review-contract.js";

export const REVIEW_WORKBOOK_FORMAT = "pohoda-mcp-review-workbook";
export const REVIEW_WORKBOOK_SCHEMA_VERSION = 1;
export const REVIEW_SHEET_NAME = "Doklady";
export const REVIEW_EXAMPLES_SHEET_NAME = "Podobne doklady";
export const REVIEW_GUIDE_SHEET_NAME = "Navod";
export const REVIEW_META_SHEET_NAME = "_meta";
export const REVIEW_MAX_RECORDS = 500;
export const REVIEW_MAX_EXAMPLES = 200;
export const REVIEW_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_ID_LENGTH = 128;
const MAX_PAGE_NUMBER = 10_000;
const HEADER_SEARCH_ROWS = 5;
const FROZEN_COLUMNS = 2;

export const REVIEW_ACTION_LABELS: Readonly<Record<ReviewAction, string>> = {
  import: "Importovat",
  review: "Prověřit",
  skip: "Vynechat"
};
export const REVIEW_TOOL_LABELS: Readonly<Record<ReviewTool, string>> = {
  create_invoice: "Přijatá faktura",
  create_other_liability: "Ostatní závazek",
  create_cash_voucher: "Pokladní výdej"
};
export const REVIEW_TAX_MODE_LABELS: Readonly<Record<"auto" | "taxable" | "nonTax", string>> = {
  auto: "Automaticky",
  taxable: "Daňový (odpočet DPH)",
  nonTax: "PN (nedaňový)"
};
const BOOLEAN_LABELS = { true: "Ano", false: "Ne" } as const;

export type ReviewColumnKind = "rowId" | "action" | "reviewNotes" | "tool" | "plan" | "display"
  | "text" | "id" | "date" | "money" | "number" | "integer" | "boolean" | "taxMode" | "pages";
type ColumnGroup = "control" | "plan" | "source" | "advanced" | "trace";

export type ReviewColumn = {
  /** Internal key. For data columns this is the `ReviewRow.data` field name. */
  key: string;
  /** Czech header label shown in the workbook. */
  label: string;
  kind: ReviewColumnKind;
  group: ColumnGroup;
  width: number;
  /** Header note explaining the field (shown as an Excel comment). */
  note?: string;
};

const col = (key: string, label: string, kind: ReviewColumnKind, group: ColumnGroup, width: number, note?: string): ReviewColumn =>
  note === undefined ? { key, label, kind, group, width } : { key, label, kind, group, width, note };

/** Column layout of the "Doklady" sheet, in written order. */
export const REVIEW_COLUMNS: readonly ReviewColumn[] = [
  col("rowId", "ID řádku", "rowId", "control", 11, "Stabilní identifikátor řádku z přípravy. Neměňte jej. Řádky lze řadit, filtrovat i mazat; řádky s neznámým ID budou při importu odmítnuty."),
  col("action", "Akce", "action", "control", 13, "Importovat = řádek se importuje po vašem výslovném pokynu. Prověřit = zatím neimportovat. Vynechat = neimportovat."),
  col("reviewNotes", "Poznámka ke kontrole (neimportuje se)", "reviewNotes", "control", 32, "Vaše poznámka pro kontrolu. Do POHODY se NEPŘENÁŠÍ (ani do interní poznámky)."),
  col("tool", "Typ dokladu", "tool", "control", 17),
  col("plannedImport", "Plán importu (jen pro čtení, přepočítá se)", "plan", "plan", 44, "Informativní náhled úprav podle pravidel importu (pozdní DUZP, PN, číslování). Při importu se znovu spočítá z upravených zdrojových hodnot; tento sloupec se nikdy neimportuje."),
  col("text", "Text dokladu v POHODĚ (krátký, max. 240 znaků)", "text", "source", 34, "Krátký text, který se zapíše do POHODY jako text dokladu. Nezaměňujte s Poznámkou ke kontrole."),
  col("partnerName", "Dodavatel", "text", "source", 26),
  col("partnerIco", "IČO", "id", "source", 11, "Uloženo jako text, aby se zachovaly úvodní nuly."),
  col("partnerDic", "DIČ", "id", "source", 13),
  col("partnerCountry", "Země", "text", "source", 7),
  col("sourceDocumentNumber", "Číslo dokladu dodavatele", "id", "source", 18),
  col("sourceSymVar", "Variabilní symbol (zdroj)", "id", "source", 14),
  col("sourceIssueDate", "Datum vystavení (zdroj)", "date", "source", 12, "Datum přesně podle dokladu. Pozdní doklad se při importu přesune na 1. den zvoleného období DPH; původní datum se zachová."),
  col("sourceTaxDate", "DUZP (zdroj)", "date", "source", 12, "DUZP přesně podle dokladu. Nikdy jej neodvozujte z data vystavení."),
  col("sourcePaymentDate", "Datum úhrady (zdroj)", "date", "source", 12, "U pokladních výdajů skutečné datum platby."),
  col("dateDue", "Datum splatnosti (zdroj)", "date", "source", 12),
  col("taxMode", "Režim DPH", "taxMode", "source", 17, "Daňový = nárok na odpočet. PN = celá částka do 0 % sazby bez data KH. Automaticky = rozhodne import podle ověřených údajů o dodavateli."),
  col("sourceChargesVat", "Doklad účtuje DPH", "boolean", "source", 10, "Ano/Ne podle dokladu; prázdné = neznámo. Chybějící DIČ samo o sobě neprokazuje neplátce."),
  col("cardPayment", "Platba kartou", "boolean", "source", 10),
  col("currency", "Měna", "text", "source", 7),
  col("priceNone", "Bez DPH / 0 % (zdroj)", "money", "source", 13, "Částky přesně podle dokladu. Prázdná buňka ≠ 0."),
  col("priceLow", "Základ 12 % (zdroj)", "money", "source", 13),
  col("priceLowVAT", "DPH 12 % (zdroj)", "money", "source", 12),
  col("priceLowSum", "Celkem 12 % (zdroj)", "money", "source", 13),
  col("priceHigh", "Základ 21 % (zdroj)", "money", "source", 13),
  col("priceHighVAT", "DPH 21 % (zdroj)", "money", "source", 12),
  col("priceHighSum", "Celkem 21 % (zdroj)", "money", "source", 13),
  col("roundingAmount", "Zaokrouhlení (zdroj)", "money", "source", 12),
  col("total", "Celkem k úhradě (zdroj)", "money", "source", 14, "Přesná částka k úhradě PO zaokrouhlení."),
  col("homePayableCZK", "K úhradě v CZK (zdroj)", "money", "source", 14, "Ověřená částka v CZK u cizí měny. Nikdy ji neodhadujte kurzem 1."),
  col("price3", "Základ 3. sazba (zdroj)", "money", "advanced", 13),
  col("price3VAT", "DPH 3. sazba (zdroj)", "money", "advanced", 12),
  col("price3Sum", "Celkem 3. sazba (zdroj)", "money", "advanced", 13),
  col("currencyRate", "Kurz", "number", "advanced", 10, "Prázdné = kurz nastavený v POHODĚ. Nikdy nedoplňujte 1."),
  col("currencyAmount", "Kurz za množství", "integer", "advanced", 10),
  col("partnerId", "ID adresy v POHODĚ", "integer", "advanced", 11),
  col("partnerStreet", "Ulice dodavatele", "text", "advanced", 24),
  col("partnerCity", "Obec dodavatele", "text", "advanced", 20),
  col("partnerZip", "PSČ dodavatele", "id", "advanced", 10),
  col("partnerVatStatus", "Status DPH dodavatele", "text", "advanced", 18),
  col("vatStatusEvidence", "Podklad statusu DPH", "text", "advanced", 32),
  col("accounting", "Předkontace", "text", "advanced", 12),
  col("dateAccounting", "Datum účetního případu", "date", "advanced", 14),
  col("accountIds", "Účet dokladu", "text", "advanced", 14),
  col("paymentAccountNumber", "Číslo bankovního účtu", "id", "advanced", 24),
  col("paymentBankCode", "Kód banky", "id", "advanced", 10),
  col("note", "Poznámka v POHODĚ (importuje se)", "text", "advanced", 32),
  col("classificationVAT", "Členění DPH", "text", "advanced", 11),
  col("classificationKVDPH", "Členění KH DPH", "text", "advanced", 14),
  col("paymentType", "Forma úhrady", "text", "advanced", 14),
  col("centre", "Středisko", "text", "advanced", 11),
  col("activity", "Činnost", "text", "advanced", 11),
  col("contract", "Zakázka", "text", "advanced", 11),
  col("cashAccount", "Pokladna", "text", "advanced", 10),
  col("sourcePages", "Strany PDF", "pages", "advanced", 10, "Čísla stran zdrojového PDF, např. 1, 2 nebo 3-4."),
  col("sourcePdfPath", "Zdrojové PDF (jen pro dohledání)", "display", "trace", 42, "Jen pro dohledání. Povolené zdrojové soubory určuje manifest přípravy, ne tato buňka."),
  col("sourceType", "Způsob zadání (jen pro dohledání)", "display", "trace", 16),
  col("intNote", "Zdrojová interní poznámka (jen pro dohledání)", "display", "trace", 40)
];

const DATA_KINDS = new Set<ReviewColumnKind>(["text", "id", "date", "money", "number", "integer", "boolean", "taxMode", "pages"]);
const DISPLAY_KINDS = new Set<ReviewColumnKind>(["plan", "display"]);

/** Data keys the parser may return in `ReviewRow.data`. */
export const REVIEW_DATA_FIELDS: readonly string[] = REVIEW_COLUMNS.filter((c) => DATA_KINDS.has(c.kind)).map((c) => c.key);

export type ReviewWorkbookIssue = { code: string; message: string; sheet?: string; cell?: string; rowId?: string };

export class ReviewWorkbookError extends Error {
  public readonly issues: ReviewWorkbookIssue[];
  public constructor(issues: ReviewWorkbookIssue[]) {
    const head = issues.slice(0, 20).map((i) => `${i.code}${i.cell ? ` ${i.sheet ?? ""}!${i.cell}` : ""}: ${i.message}`).join("\n");
    super(`Review workbook rejected (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${head}${issues.length > 20 ? `\n… ${issues.length - 20} more` : ""}`);
    this.name = "ReviewWorkbookError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------------------
// Writing

const FILL = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const HEADER_COLORS: Record<ColumnGroup, string> = {
  control: "FF1F2937",
  plan: "FF6B7280",
  source: "FF1E3A8A",
  advanced: "FF475569",
  trace: "FF6B7280"
};
const BAND_LABELS: Record<ColumnGroup, string> = {
  control: "KONTROLA",
  plan: "PLÁN",
  source: "ZDROJOVÉ ÚDAJE",
  advanced: "DALŠÍ POLE (rozbalte +)",
  trace: "DOHLEDÁNÍ"
};
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFCBD5E1" } },
  bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
  left: { style: "thin", color: { argb: "FFCBD5E1" } },
  right: { style: "thin", color: { argb: "FFCBD5E1" } }
};
const NUM_FMT: Partial<Record<ReviewColumnKind, string>> = {
  money: "#,##0.00",
  date: "dd.mm.yyyy",
  integer: "0",
  number: "General",
  text: "@",
  id: "@",
  rowId: "@",
  pages: "@",
  reviewNotes: "@"
};

const DOCUMENT_TYPE_FOR_TOOL: Record<ReviewTool, string> = {
  create_invoice: "receivedInvoice",
  create_other_liability: "commitment",
  create_cash_voucher: "expense"
};

export async function writeReviewWorkbook(input: ReviewWorkbook, filePath: string): Promise<void> {
  if (path.extname(filePath).toLowerCase() !== ".xlsx") {
    throw new ReviewWorkbookError([{ code: "UNSUPPORTED_FORMAT", message: `Review workbook must be written as .xlsx, got "${path.basename(filePath)}".` }]);
  }
  validateWriteInput(input);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "pohoda-mcp-node";
  workbook.created = new Date();
  workbook.title = `Kontrola dokladů ${input.vatPeriod}`;
  workbook.views = [{ x: 0, y: 0, width: 24000, height: 14000, firstSheet: 0, activeTab: 0, visibility: "visible" }];

  writeMainSheet(workbook, input);
  await writeExamplesSheet(workbook, input.examples ?? []);
  await writeGuideSheet(workbook, input);
  await writeMetaSheet(workbook, input);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, buffer);
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function validateWriteInput(input: ReviewWorkbook): void {
  const issues: ReviewWorkbookIssue[] = [];
  checkMetaValues({ reviewId: input?.reviewId, databaseId: input?.databaseId, vatPeriod: input?.vatPeriod }, issues);
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  if (!Array.isArray(input?.rows)) issues.push({ code: "ROWS_REQUIRED", message: "rows must be an array." });
  if (rows.length > REVIEW_MAX_RECORDS) issues.push({ code: "TOO_MANY_ROWS", message: `At most ${REVIEW_MAX_RECORDS} records per review workbook, got ${rows.length}.` });
  if (input?.examples !== undefined && !Array.isArray(input.examples)) issues.push({ code: "EXAMPLES_INVALID", message: "examples must be an array." });
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const id = typeof row?.rowId === "string" ? row.rowId.trim() : "";
    const idIssue = rowIdProblem(id);
    if (idIssue) issues.push({ code: "ROW_ID_INVALID", message: `rows[${index}].rowId ${idIssue}` });
    else if (id !== row.rowId) issues.push({ code: "ROW_ID_INVALID", message: `rows[${index}].rowId must not have surrounding whitespace.` });
    else if (seen.has(id)) issues.push({ code: "DUPLICATE_ROW_ID", message: `Duplicate rowId "${id}".`, rowId: id });
    seen.add(id);
    if (!(row?.tool in REVIEW_TOOL_LABELS)) issues.push({ code: "TOOL_INVALID", message: `rows[${index}].tool "${String(row?.tool)}" is not a supported review tool.`, rowId: id });
    if (!(row?.action in REVIEW_ACTION_LABELS)) issues.push({ code: "ACTION_INVALID", message: `rows[${index}].action "${String(row?.action)}" is invalid.`, rowId: id });
    if (row?.data === null || typeof row?.data !== "object" || Array.isArray(row.data)) issues.push({ code: "DATA_INVALID", message: `rows[${index}].data must be an object.`, rowId: id });
    if (row?.reviewNotes !== undefined && typeof row.reviewNotes !== "string") issues.push({ code: "NOTES_INVALID", message: `rows[${index}].reviewNotes must be a string.`, rowId: id });
  });
  if (issues.length) throw new ReviewWorkbookError(issues);
}

function writeMainSheet(workbook: ExcelJS.Workbook, input: ReviewWorkbook): void {
  const ws = workbook.addWorksheet(REVIEW_SHEET_NAME, {
    views: [{ state: "frozen", xSplit: FROZEN_COLUMNS, ySplit: 2, topLeftCell: "C3", activeCell: "C3", zoomScale: 100 }],
    properties: { tabColor: { argb: "FF1E3A8A" }, defaultRowHeight: 18, outlineLevelCol: 1 }
  });
  ws.columns = REVIEW_COLUMNS.map((c) => ({
    key: c.key,
    width: c.width,
    hidden: c.group === "advanced",
    outlineLevel: c.group === "advanced" ? 1 : 0,
    style: NUM_FMT[c.kind] ? { numFmt: NUM_FMT[c.kind]! } : {}
  }));

  // Row 1: group band. Row 2: field headers.
  const band = ws.getRow(1);
  band.height = 20;
  REVIEW_COLUMNS.forEach((column, index) => {
    const cell = ws.getCell(1, index + 1);
    // Unmerged bands stay readable across frozen panes and render consistently.
    if (index === 0 || REVIEW_COLUMNS[index - 1]!.group !== column.group) cell.value = BAND_LABELS[column.group];
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9 };
    cell.fill = FILL(HEADER_COLORS[column.group]);
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  const header = ws.getRow(2);
  header.height = 48;
  REVIEW_COLUMNS.forEach((c, index) => {
    const cell = header.getCell(index + 1);
    cell.value = c.label;
    cell.numFmt = "General";
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = FILL(c.key === "reviewNotes" ? "FFB45309" : HEADER_COLORS[c.group]);
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = THIN_BORDER;
    if (c.note) cell.note = { texts: [{ text: c.note }] };
  });

  input.rows.forEach((row, index) => {
    const excelRow = ws.getRow(index + 3);
    const plan = describePlan(row, input.vatPeriod);
    const lineCount = (value: string, width: number) => value.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0);
    excelRow.height = Math.min(180, Math.max(32, 13 * Math.max(lineCount(plan, 58), lineCount(row.reviewNotes || "", 40))));
    REVIEW_COLUMNS.forEach((c, colIndex) => {
      const cell = excelRow.getCell(colIndex + 1);
      const value = cellValueFor(c, row, plan);
      cell.value = value;
      if (NUM_FMT[c.kind]) cell.numFmt = NUM_FMT[c.kind]!;
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: "top", wrapText: c.kind === "plan" || c.kind === "reviewNotes" || c.key === "text" || c.key === "partnerName" };
      if (c.kind === "rowId") { cell.fill = FILL("FFF1F5F9"); cell.font = { color: { argb: "FF475569" } }; }
      if (c.kind === "reviewNotes") cell.fill = FILL("FFFEF3C7");
      if (DISPLAY_KINDS.has(c.kind)) { cell.fill = FILL("FFF3F4F6"); cell.font = { italic: true, color: { argb: "FF4B5563" }, size: 9 }; }
    });
  });

  const lastRow = Math.max(3, input.rows.length + 2);
  const lastCol = ws.getColumn(REVIEW_COLUMNS.length).letter;
  ws.autoFilter = `A2:${lastCol}${lastRow}`;

  const list = (values: string[], title: string): ExcelJS.DataValidation => ({
    type: "list",
    allowBlank: true,
    formulae: [`"${values.join(",")}"`],
    showErrorMessage: true,
    errorStyle: "stop",
    errorTitle: title,
    error: `Vyberte jednu z hodnot: ${values.join(", ")}`
  });
  REVIEW_COLUMNS.forEach((c, index) => {
    const letter = ws.getColumn(index + 1).letter;
    const range = `${letter}3:${letter}${lastRow}`;
    const validation = c.kind === "action" ? list(Object.values(REVIEW_ACTION_LABELS), "Akce")
      : c.kind === "tool" ? list(Object.values(REVIEW_TOOL_LABELS), "Typ dokladu")
        : c.kind === "taxMode" ? list(Object.values(REVIEW_TAX_MODE_LABELS), "Režim DPH")
          : c.kind === "boolean" ? list([BOOLEAN_LABELS.true, BOOLEAN_LABELS.false], c.label) : undefined;
    // Per-cell validations are merged into one range by ExcelJS when the file is written.
    if (validation) for (let r = 3; r <= lastRow; r++) ws.getCell(r, index + 1).dataValidation = validation;
    if (c.kind === "action") {
      const colors: Record<ReviewAction, string> = { import: "FFDCFCE7", review: "FFFEF3C7", skip: "FFE5E7EB" };
      ws.addConditionalFormatting({
        ref: range,
        rules: (Object.keys(colors) as ReviewAction[]).map((action, priority) => ({
          type: "cellIs",
          operator: "equal",
          priority: priority + 1,
          formulae: [`"${REVIEW_ACTION_LABELS[action]}"`],
          style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: colors[action] } }, font: { bold: true } }
        }))
      });
    }
  });
}

function cellValueFor(column: ReviewColumn, row: ReviewRow, plan: string): ExcelJS.CellValue {
  switch (column.kind) {
    case "rowId": return row.rowId;
    case "action": return REVIEW_ACTION_LABELS[row.action];
    case "reviewNotes": return row.reviewNotes ? String(row.reviewNotes) : null;
    case "tool": return REVIEW_TOOL_LABELS[row.tool];
    case "plan": return plan;
    default: return dataCellValue(column, row.data?.[column.key]);
  }
}

function dataCellValue(column: ReviewColumn, value: unknown): ExcelJS.CellValue {
  if (value === undefined || value === null || value === "") {
    return column.key === "cardPayment" ? BOOLEAN_LABELS.false : column.kind === "taxMode" ? REVIEW_TAX_MODE_LABELS.auto : null;
  }
  switch (column.kind) {
    case "money":
    case "number":
    case "integer": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      const textValue = String(value).trim();
      return /^[+-]?\d+(\.\d+)?$/.test(textValue) ? Number(textValue) : textValue;
    }
    case "date": {
      const iso = typeof value === "string" ? value.trim() : "";
      const parsed = parseIsoDate(iso);
      return parsed ?? String(value);
    }
    case "boolean":
      if (value === true) return BOOLEAN_LABELS.true;
      if (value === false) return BOOLEAN_LABELS.false;
      return String(value);
    case "taxMode":
      return (REVIEW_TAX_MODE_LABELS as Record<string, string>)[String(value)] ?? String(value);
    case "pages":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "display":
    case "text":
    case "id":
    default:
      // Strings are stored as literal text; a leading "=" is never turned into a formula.
      return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

/** Human-readable preview of what the import policy would do with the prepared source values. */
function describePlan(row: ReviewRow, vatPeriod: string): string {
  if (row.action === "skip") return "Vynecháno – nic se neimportuje.";
  const data = row.data ?? {};
  const kind = row.tool === "create_cash_voucher" ? "voucher" : "invoice";
  const header: Record<string, any> = {
    ...data,
    type: data.type ?? DOCUMENT_TYPE_FOR_TOOL[row.tool],
    vatPeriod,
    ...(data.cardPayment === true ? { cardSequence: 1 } : {})
  };
  delete header._expensePolicy;
  try {
    const result = resolveExpensePolicy(header, [], kind);
    const policy = result._expensePolicy ?? {};
    const lines: string[] = [];
    if (policy.lateSource) lines.push(`Pozdní doklad → data na 1. den období ${czDate(`${vatPeriod}-01`)}; původní data zůstanou v interní poznámce.`);
    const dates = [`Datum ${czDate(result.date)}`, `DPH ${czDate(result.dateTax)}`];
    if (result.dateAccounting) dates.push(`účetní ${czDate(result.dateAccounting)}`);
    if (policy.taxMode === "taxable") dates.push(`KH ${czDate(result.dateKHDPH)}`);
    if (kind === "voucher") dates.push(`úhrada ${czDate(result.datePayment)}`);
    lines.push(dates.join(", "));
    if (policy.taxMode === "nonTax") lines.push(`PN: celá částka ${formatAmount(result.priceNone)} v sazbě 0 %, bez data KH.`);
    else if (policy.taxMode === "taxable") lines.push("Daňový doklad – odpočet DPH podle zdrojových částek.");
    if (policy.originalDocumentRule === "card-sequence") lines.push("Karta ≤ 10 000 Kč: Doklad K + další číslo řady PK, VS = stejné číslo (přidělí import).");
    else if (policy.originalDocumentRule === "card-source-document") lines.push(`Karta > 10 000 Kč: Doklad ${result.originalDocument}.`);
    else if (policy.originalDocumentRule === "omitted-at-or-below-threshold") lines.push("Hotovost ≤ 10 000 Kč: bez čísla Dokladu.");
    for (const warning of policy.warnings ?? []) lines.push(`Upozornění: ${warning}`);
    return lines.join("\n");
  } catch (error) {
    return `Nelze naplánovat – zkontrolujte zdrojové hodnoty: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function czDate(value: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "—";
}

function formatAmount(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value ?? "");
}

async function writeExamplesSheet(workbook: ExcelJS.Workbook, examples: Array<Record<string, any>>): Promise<void> {
  const ws = workbook.addWorksheet(REVIEW_EXAMPLES_SHEET_NAME, {
    views: [{ state: "frozen", ySplit: 2, xSplit: 0 }],
    properties: { tabColor: { argb: "FF9CA3AF" } }
  });
  const list = examples.slice(0, REVIEW_MAX_EXAMPLES).filter((e) => e && typeof e === "object" && !Array.isArray(e));
  const keys: string[] = [];
  for (const example of list) for (const key of Object.keys(example)) if (!keys.includes(key) && keys.length < 40) keys.push(key);
  const known = new Map(REVIEW_COLUMNS.map((c) => [c.key, c]));
  const width = Math.max(keys.length, 1);

  const title = ws.getCell(1, 1);
  title.value = list.length
    ? "Jen pro porovnání: podobné doklady z této účetní jednotky. Tento list se neimportuje a nelze jej upravovat."
    : "Žádné podobné doklady z této účetní jednotky nebyly nalezeny. Tento list se neimportuje.";
  title.font = { bold: true, color: { argb: "FF374151" } };
  title.fill = FILL("FFE5E7EB");
  title.alignment = { vertical: "middle", wrapText: true };
  ws.getRow(1).height = 30;
  if (width > 1) ws.mergeCells(1, 1, 1, width);

  keys.forEach((key, index) => {
    const column = known.get(key);
    const cell = ws.getCell(2, index + 1);
    cell.value = column?.label ?? key;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = FILL("FF6B7280");
    cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
    ws.getColumn(index + 1).width = Math.min(40, Math.max(10, column?.width ?? 14));
  });
  ws.getRow(2).height = 36;
  list.forEach((example, rowIndex) => {
    keys.forEach((key, index) => {
      const cell = ws.getCell(rowIndex + 3, index + 1);
      const value = example[key];
      const column = known.get(key);
      if (value === undefined || value === null || value === "") return;
      if (column && DATA_KINDS.has(column.kind)) {
        cell.value = dataCellValue(column, value);
        if (NUM_FMT[column.kind]) cell.numFmt = NUM_FMT[column.kind]!;
      } else if (typeof value === "number" || typeof value === "boolean") {
        cell.value = typeof value === "boolean" ? (value ? BOOLEAN_LABELS.true : BOOLEAN_LABELS.false) : value;
      } else if (value instanceof Date) {
        cell.value = value;
        cell.numFmt = "dd.mm.yyyy";
      } else {
        cell.value = typeof value === "string" ? value : JSON.stringify(value);
      }
      cell.font = { color: { argb: "FF4B5563" } };
    });
  });
  if (keys.length && list.length) ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: list.length + 2, column: keys.length } };
  await ws.protect("", { selectLockedCells: true, selectUnlockedCells: true, autoFilter: true, formatColumns: true });
}

async function writeGuideSheet(workbook: ExcelJS.Workbook, input: ReviewWorkbook): Promise<void> {
  const ws = workbook.addWorksheet(REVIEW_GUIDE_SHEET_NAME, { properties: { tabColor: { argb: "FF059669" } } });
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 100;
  const lines: Array<[string, string]> = [
    ["Kontrola dokladů před importem do POHODY", ""],
    ["Účetní jednotka", input.databaseId],
    ["Období DPH", input.vatPeriod],
    ["ID kontroly", input.reviewId],
    ["Počet řádků", String(input.rows.length)],
    ["", ""],
    ["1. Úpravy", "Hodnoty upravujte jen v listu Doklady. Modré sloupce jsou zdrojové hodnoty přesně podle dokladu (data, částky, čísla)."],
    ["2. Akce", "Importovat / Prověřit / Vynechat. Import proběhne pouze po vašem výslovném pokynu a jen pro řádky Importovat."],
    ["3. Text vs. poznámka", "„Text dokladu v POHODĚ“ je krátký text dokladu. „Poznámka ke kontrole“ slouží jen vám a do POHODY se nepřenáší."],
    ["4. Plán importu", "Šedý sloupec ukazuje úpravy podle pravidel importu. Při importu se vždy znovu spočítá z upravených zdrojových hodnot; sám se nikdy neimportuje."],
    ["5. Pozdní doklady", "Je-li DUZP (u PN datum dokladu) ve starším měsíci než zvolené období DPH, datum dokladu, DPH, účetní datum a datum KH se nastaví na 1. den období. Původní data se uloží do interní poznámky."],
    ["6. PN (nedaňový)", "Celá zdrojová částka včetně případné DPH dodavatele jde do sazby 0 % (Bez DPH), bez data KH. Chybějící DIČ samo neprokazuje neplátce."],
    ["7. Platba kartou", "Ostatní závazek s platbou kartou pokračuje řadou PK. Do 10 000 Kč: Doklad K + číslo, VS = číslo. Nad 10 000 Kč: číslo dokladu dodavatele."],
    ["8. Hotovost", "Pokladní výdej má Doklad jen nad 10 000 Kč po zaokrouhlení; datum úhrady je skutečné datum platby."],
    ["9. Částky", "Zadávejte přesné částky se 2 desetinnými místy. Prázdná buňka není totéž co 0."],
    ["10. Data", "Datum zadejte jako datum Excelu nebo text RRRR-MM-DD či DD.MM.RRRR."],
    ["11. Vzorce", "Vzorce nejsou povoleny. Pokud je použijete, vložte místo nich hodnoty (Vložit jinak → Hodnoty)."],
    ["12. Řádky", "Řádky lze řadit, filtrovat i mazat. Neměňte ID řádku. Nové řádky s neznámým ID budou odmítnuty."],
    ["13. Uložení", "Uložte soubor ve formátu .xlsx (ne .xls, .xlsm ani .csv)."],
    ["14. Podobné doklady", "List Podobne doklady obsahuje jen vzory z této účetní jednotky pro porovnání; neimportuje se."]
  ];
  lines.forEach(([a, b], index) => {
    const row = ws.getRow(index + 1);
    row.getCell(1).value = a;
    row.getCell(2).value = b;
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row.getCell(1).alignment = { vertical: "top" };
  });
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.mergeCells(1, 1, 1, 2);
  await ws.protect("", { selectLockedCells: true, selectUnlockedCells: true });
}

async function writeMetaSheet(workbook: ExcelJS.Workbook, input: ReviewWorkbook): Promise<void> {
  const ws = workbook.addWorksheet(REVIEW_META_SHEET_NAME, { state: "veryHidden" });
  const entries: Array<[string, string]> = [
    ["format", REVIEW_WORKBOOK_FORMAT],
    ["schemaVersion", String(REVIEW_WORKBOOK_SCHEMA_VERSION)],
    ["reviewId", input.reviewId],
    ["databaseId", input.databaseId],
    ["vatPeriod", input.vatPeriod],
    ["generatedAt", new Date().toISOString()],
    ["notice", "Metadata only. Visible cells in sheet Doklady are the only import data."]
  ];
  entries.forEach(([key, value], index) => {
    ws.getCell(index + 1, 1).value = key;
    ws.getCell(index + 1, 2).value = value;
  });
  await ws.protect("", { selectLockedCells: true, selectUnlockedCells: true });
}

// ---------------------------------------------------------------------------------------
// Reading

export async function readReviewWorkbook(filePath: string, suppliedBytes?: Uint8Array): Promise<ReviewWorkbookRead> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".xls") {
    throw new ReviewWorkbookError([{ code: "UNSUPPORTED_FORMAT", message: "Legacy .xls is not supported. Open the file in Excel and use Save As → Excel Workbook (.xlsx)." }]);
  }
  if (extension !== ".xlsx") {
    throw new ReviewWorkbookError([{ code: "UNSUPPORTED_FORMAT", message: `Only .xlsx review workbooks are accepted (got "${extension || "no extension"}"). Macro-enabled or other formats are rejected; use Save As → Excel Workbook (.xlsx).` }]);
  }
  if (!suppliedBytes) {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new ReviewWorkbookError([{ code: "NOT_A_FILE", message: "Review workbook path is not a regular file." }]);
    if (stat.size > REVIEW_MAX_FILE_BYTES) throw new ReviewWorkbookError([{ code: "FILE_TOO_LARGE", message: "Review workbook exceeds the size limit." }]);
  }
  const buffer = suppliedBytes ? Buffer.from(suppliedBytes) : await fs.readFile(filePath);
  if (buffer.length > REVIEW_MAX_FILE_BYTES) throw new ReviewWorkbookError([{ code: "FILE_TOO_LARGE", message: "Review workbook exceeds the size limit." }]);
  inspectZip(buffer);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch (error) {
    throw new ReviewWorkbookError([{ code: "MALFORMED_WORKBOOK", message: `The file could not be read as an .xlsx workbook: ${error instanceof Error ? error.message : String(error)}` }]);
  }

  const issues: ReviewWorkbookIssue[] = [];
  const meta = readMeta(workbook, issues);
  const ws = workbook.getWorksheet(REVIEW_SHEET_NAME);
  if (!ws) {
    issues.push({ code: "SHEET_MISSING", message: `Sheet "${REVIEW_SHEET_NAME}" is missing.` });
    throw new ReviewWorkbookError(issues);
  }
  const rows = readMainSheet(ws, issues);
  if (issues.length) throw new ReviewWorkbookError(issues);
  return { reviewId: meta.reviewId, databaseId: meta.databaseId, vatPeriod: meta.vatPeriod, rows };
}

/** Structural ZIP checks before handing the file to the XML parser (size bombs, macros, non-OOXML). */
function inspectZip(buffer: Buffer): void {
  const fail = (code: string, message: string): never => { throw new ReviewWorkbookError([{ code, message }]); };
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) fail("MALFORMED_WORKBOOK", "The file is not an .xlsx (ZIP) workbook.");
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail("MALFORMED_WORKBOOK", "The .xlsx ZIP directory is missing or truncated.");
  const entries = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || directoryOffset === 0xffffffff) fail("MALFORMED_WORKBOOK", "ZIP64 workbooks are not supported.");
  if (entries > MAX_ZIP_ENTRIES) fail("FILE_TOO_LARGE", `The workbook has too many parts (${entries}).`);
  let offset = directoryOffset;
  let total = 0;
  const names: string[] = [];
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) fail("MALFORMED_WORKBOOK", "The .xlsx ZIP directory is corrupt.");
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (size === 0xffffffff) fail("MALFORMED_WORKBOOK", "ZIP64 workbook parts are not supported.");
    names.push(buffer.toString("utf8", offset + 46, offset + 46 + nameLength));
    total += size;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (total > MAX_UNCOMPRESSED_BYTES) fail("FILE_TOO_LARGE", `The workbook expands to ${total} bytes; the limit is ${MAX_UNCOMPRESSED_BYTES}.`);
  if (names.some((name) => /vbaProject\.bin$/i.test(name))) fail("UNSUPPORTED_FORMAT", "Macro-enabled workbooks are rejected. Save as a plain .xlsx workbook.");
  if (!names.includes("xl/workbook.xml")) fail("MALFORMED_WORKBOOK", "The file is not an Excel .xlsx workbook (xl/workbook.xml missing).");
}

function readMeta(workbook: ExcelJS.Workbook, issues: ReviewWorkbookIssue[]): { reviewId: string; databaseId: string; vatPeriod: string } {
  const ws = workbook.getWorksheet(REVIEW_META_SHEET_NAME);
  const values: Record<string, string> = {};
  if (!ws) {
    issues.push({ code: "META_MISSING", message: `Hidden sheet "${REVIEW_META_SHEET_NAME}" is missing; export a fresh review workbook.` });
    return { reviewId: "", databaseId: "", vatPeriod: "" };
  }
  ws.eachRow((row) => {
    const keyCell = row.getCell(1);
    const valueCell = row.getCell(2);
    const key = readCell(keyCell, REVIEW_META_SHEET_NAME, issues);
    const value = readCell(valueCell, REVIEW_META_SHEET_NAME, issues);
    if (key?.kind === "string" && value && value.kind !== "date") {
      if (key.value in values) issues.push({ code: "META_INVALID", message: `Duplicate metadata key "${key.value}".`, sheet: REVIEW_META_SHEET_NAME, cell: keyCell.address });
      values[key.value] = value.kind === "blank" ? "" : String(value.value);
    }
  });
  if (values.format !== REVIEW_WORKBOOK_FORMAT) issues.push({ code: "META_INVALID", message: "This is not a POHODA MCP review workbook." });
  if (values.schemaVersion !== String(REVIEW_WORKBOOK_SCHEMA_VERSION)) {
    issues.push({ code: "META_VERSION", message: `Unsupported review workbook schema version "${values.schemaVersion ?? ""}"; expected ${REVIEW_WORKBOOK_SCHEMA_VERSION}.` });
  }
  const meta = { reviewId: values.reviewId ?? "", databaseId: values.databaseId ?? "", vatPeriod: values.vatPeriod ?? "" };
  checkMetaValues(meta, issues);
  return meta;
}

function checkMetaValues(meta: { reviewId: unknown; databaseId: unknown; vatPeriod: unknown }, issues: ReviewWorkbookIssue[]): void {
  for (const key of ["reviewId", "databaseId"] as const) {
    const value = meta[key];
    const problem = typeof value !== "string" ? "is required." : rowIdProblem(value);
    if (problem) issues.push({ code: "META_INVALID", message: `${key} ${problem}` });
  }
  if (typeof meta.vatPeriod !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(meta.vatPeriod)) {
    issues.push({ code: "META_INVALID", message: `vatPeriod must be YYYY-MM, got "${String(meta.vatPeriod ?? "")}".` });
  }
}

function rowIdProblem(id: string): string | undefined {
  if (id.trim() === "") return "is blank.";
  if (id.length > MAX_ID_LENGTH) return `is longer than ${MAX_ID_LENGTH} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(id)) return "contains control characters.";
  return undefined;
}

const normalizeHeader = (value: string): string => value.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("cs-CZ");

function readMainSheet(ws: ExcelJS.Worksheet, issues: ReviewWorkbookIssue[]): ReviewRow[] {
  const byHeader = new Map<string, ReviewColumn>();
  for (const column of REVIEW_COLUMNS) {
    byHeader.set(normalizeHeader(column.label), column);
    byHeader.set(normalizeHeader(column.key), column);
  }
  const rowIdHeaders = new Set([normalizeHeader(REVIEW_COLUMNS[0]!.label), normalizeHeader("rowId")]);

  let headerRowNumber = 0;
  for (let r = 1; r <= HEADER_SEARCH_ROWS && !headerRowNumber; r++) {
    ws.getRow(r).eachCell((cell) => {
      if (typeof cell.value === "string" && rowIdHeaders.has(normalizeHeader(cell.value))) headerRowNumber = r;
    });
  }
  if (!headerRowNumber) {
    issues.push({ code: "HEADER_MISSING", message: `Header row with column "${REVIEW_COLUMNS[0]!.label}" was not found in the first ${HEADER_SEARCH_ROWS} rows of ${REVIEW_SHEET_NAME}.`, sheet: REVIEW_SHEET_NAME });
    return [];
  }

  const positions = new Map<string, number>();
  ws.getRow(headerRowNumber).eachCell((cell, colNumber) => {
    if (typeof cell.value !== "string") return;
    const column = byHeader.get(normalizeHeader(cell.value));
    if (!column) return; // user helper columns are ignored
    if (positions.has(column.key)) {
      issues.push({ code: "DUPLICATE_COLUMN", message: `Column "${column.label}" appears more than once.`, sheet: REVIEW_SHEET_NAME, cell: cell.address });
      return;
    }
    positions.set(column.key, colNumber);
  });
  for (const column of REVIEW_COLUMNS) {
    if (!DISPLAY_KINDS.has(column.kind) && !positions.has(column.key)) {
      issues.push({ code: "MISSING_COLUMN", message: `Required column "${column.label}" (${column.key}) is missing.`, sheet: REVIEW_SHEET_NAME });
    }
  }
  if (issues.some((i) => i.code === "MISSING_COLUMN" || i.code === "DUPLICATE_COLUMN")) return [];
  const columns = REVIEW_COLUMNS.filter((c) => !DISPLAY_KINDS.has(c.kind)).map((c) => ({ column: c, position: positions.get(c.key)! }));

  const rows: ReviewRow[] = [];
  const seen = new Map<string, string>();
  let records = 0;
  let tooMany = false;
  ws.eachRow({ includeEmpty: false }, (excelRow, rowNumber) => {
    if (rowNumber <= headerRowNumber || tooMany) return;
    const rowIssues: ReviewWorkbookIssue[] = [];
    const cells = columns.map(({ column, position }) => {
      const cell = excelRow.getCell(position);
      return { column, cell, raw: readCell(cell, REVIEW_SHEET_NAME, rowIssues) };
    });
    const nonEmpty = rowIssues.length > 0 || cells.some((c) => c.raw && c.raw.kind !== "blank");
    if (!nonEmpty) return;
    if (excelRow.hidden) rowIssues.push({ code: "HIDDEN_ROW", message: "A document row is hidden or filtered out. Unhide all rows and use Akce=Vynechat to exclude documents explicitly.", sheet: REVIEW_SHEET_NAME, cell: `A${rowNumber}` });
    records++;
    if (records > REVIEW_MAX_RECORDS) {
      tooMany = true;
      issues.push({ code: "TOO_MANY_ROWS", message: `At most ${REVIEW_MAX_RECORDS} records per review workbook.`, sheet: REVIEW_SHEET_NAME });
      return;
    }

    const data: Record<string, any> = {};
    let rowId = "";
    let action: ReviewAction | undefined;
    let tool: ReviewTool | undefined;
    let reviewNotes = "";
    for (const { column, cell, raw } of cells) {
      if (!raw) continue;
      const at = { sheet: REVIEW_SHEET_NAME, cell: cell.address };
      const bad = (code: string, message: string) => rowIssues.push({ code, message, ...at });
      switch (column.kind) {
        case "rowId": {
          const value = toText(raw, true, bad);
          if (value === undefined) break;
          const problem = rowIdProblem(value);
          if (problem) bad("ROW_ID_INVALID", `Row ID ${problem}`);
          else rowId = value;
          break;
        }
        case "action": {
          if (raw.kind === "blank") { action = "review"; break; }
          action = matchEnum(raw, REVIEW_ACTION_LABELS);
          if (!action) bad("ACTION_INVALID", `Unknown action "${rawText(raw)}". Use ${Object.values(REVIEW_ACTION_LABELS).join(" / ")}.`);
          break;
        }
        case "tool": {
          tool = raw.kind === "blank" ? undefined : matchEnum(raw, REVIEW_TOOL_LABELS);
          if (!tool) bad("TOOL_INVALID", `Unknown or blank document type "${rawText(raw)}". Use ${Object.values(REVIEW_TOOL_LABELS).join(" / ")}.`);
          break;
        }
        case "reviewNotes": {
          reviewNotes = raw.kind === "blank" ? "" : rawText(raw);
          break;
        }
        default: {
          const parsed = parseDataCell(column, raw, bad);
          if (parsed.ok) data[column.key] = parsed.value;
        }
      }
    }
    if (rowId) {
      const previous = seen.get(rowId);
      if (previous) rowIssues.push({ code: "DUPLICATE_ROW_ID", message: `Row ID "${rowId}" also appears at ${previous}.`, sheet: REVIEW_SHEET_NAME, cell: `A${rowNumber}`, rowId });
      else seen.set(rowId, `row ${rowNumber}`);
    } else if (!rowIssues.some((i) => i.code === "ROW_ID_INVALID")) {
      rowIssues.push({ code: "ROW_ID_INVALID", message: `Row ${rowNumber} has data but a blank row ID.`, sheet: REVIEW_SHEET_NAME });
    }
    for (const issue of rowIssues) issues.push(rowId && !issue.rowId ? { ...issue, rowId } : issue);
    if (!rowIssues.length && tool && action) rows.push({ rowId, tool, action, data, reviewNotes });
  });
  return rows;
}

type RawCell =
  | { kind: "blank" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "date"; value: Date };

/** Reads a cell's literal value. Formulas (even with cached results), errors and merged cells are rejected. */
function readCell(cell: ExcelJS.Cell, sheet: string, issues: ReviewWorkbookIssue[]): RawCell | undefined {
  const at = { sheet, cell: cell.address };
  const value = cell.value as any;
  if (value && typeof value === "object" && !(value instanceof Date) && ("formula" in value || "sharedFormula" in value)) {
    issues.push({ code: "FORMULA_NOT_ALLOWED", message: "Formulas are not accepted in review cells (even with a cached result). Replace them with values (Paste Special → Values).", ...at });
    return undefined;
  }
  switch (cell.type) {
    case ExcelJS.ValueType.Null:
      return { kind: "blank" };
    case ExcelJS.ValueType.Merge:
      issues.push({ code: "MERGED_CELL", message: "Merged cells are not allowed in the review table; unmerge them.", ...at });
      return undefined;
    case ExcelJS.ValueType.Formula:
      issues.push({ code: "FORMULA_NOT_ALLOWED", message: "Formulas are not accepted in review cells. Replace them with values.", ...at });
      return undefined;
    case ExcelJS.ValueType.Error:
      issues.push({ code: "CELL_ERROR", message: `Cell contains an Excel error (${String(value?.error ?? "")}).`, ...at });
      return undefined;
    case ExcelJS.ValueType.Number:
      return Number.isFinite(value) ? { kind: "number", value } : (issues.push({ code: "NUMBER_INVALID", message: "Non-finite number.", ...at }), undefined);
    case ExcelJS.ValueType.Boolean:
      return { kind: "boolean", value: Boolean(value) };
    case ExcelJS.ValueType.Date:
      return value instanceof Date && !Number.isNaN(value.getTime()) ? { kind: "date", value } : (issues.push({ code: "DATE_INVALID", message: "Invalid date cell.", ...at }), undefined);
    case ExcelJS.ValueType.RichText:
      return stringCell((value?.richText ?? []).map((part: { text?: string }) => part.text ?? "").join(""));
    case ExcelJS.ValueType.Hyperlink:
      return stringCell(typeof value?.text === "string" ? value.text : (value?.text?.richText ?? []).map((part: { text?: string }) => part.text ?? "").join(""));
    case ExcelJS.ValueType.String:
    case ExcelJS.ValueType.SharedString:
      return stringCell(String(value ?? ""));
    default:
      issues.push({ code: "CELL_UNSUPPORTED", message: "Unsupported cell content.", ...at });
      return undefined;
  }
}

function stringCell(value: string): RawCell {
  const trimmed = value.normalize("NFC").trim();
  return trimmed === "" ? { kind: "blank" } : { kind: "string", value: trimmed };
}

function rawText(raw: RawCell): string {
  if (raw.kind === "blank") return "";
  if (raw.kind === "date") return raw.value.toISOString().slice(0, 10);
  return String(raw.value);
}

function matchEnum<T extends string>(raw: RawCell, labels: Readonly<Record<T, string>>): T | undefined {
  if (raw.kind !== "string") return undefined;
  const wanted = normalizeHeader(raw.value);
  for (const [key, label] of Object.entries(labels) as Array<[T, string]>) {
    if (normalizeHeader(label) === wanted || normalizeHeader(key) === wanted) return key;
  }
  return undefined;
}

type Bad = (code: string, message: string) => void;

function toText(raw: RawCell, identifier: boolean, bad: Bad): string | undefined {
  switch (raw.kind) {
    case "blank": return "";
    case "string": return raw.value;
    case "number":
      if (Number.isSafeInteger(raw.value) && raw.value >= 0) return String(raw.value);
      if (!identifier) return String(raw.value);
      bad("IDENTIFIER_NOT_TEXT", `Identifier was stored as a number (${raw.value}) and may have lost digits; re-enter it as text.`);
      return undefined;
    case "boolean":
      bad("TEXT_INVALID", "Expected text, found TRUE/FALSE.");
      return undefined;
    case "date":
      bad("TEXT_INVALID", "Excel converted this text to a date; re-enter it as text.");
      return undefined;
  }
}

function parseDataCell(column: ReviewColumn, raw: RawCell, bad: Bad): { ok: true; value: unknown } | { ok: false } {
  const ok = (value: unknown) => ({ ok: true as const, value });
  switch (column.kind) {
    case "text":
    case "id": {
      const value = toText(raw, column.kind === "id", bad);
      return value === undefined ? { ok: false } : ok(value);
    }
    case "date": {
      if (raw.kind === "blank") return ok("");
      if (raw.kind === "date") {
        const d = raw.value;
        if (d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() || d.getUTCMilliseconds()) {
          bad("DATE_INVALID", "Date contains a time of day; enter a plain date.");
          return { ok: false };
        }
        return ok(d.toISOString().slice(0, 10));
      }
      if (raw.kind === "string") {
        const iso = parseDateText(raw.value);
        if (iso) return ok(iso);
      }
      bad("DATE_INVALID", `"${rawText(raw)}" is not a valid date. Use an Excel date, YYYY-MM-DD or DD.MM.YYYY.`);
      return { ok: false };
    }
    case "money": {
      if (raw.kind === "blank") return ok(null);
      if (raw.kind === "number") return ok(raw.value);
      if (raw.kind === "string") {
        const compact = raw.value.replace(/[\s  ]/g, "");
        return ok(/^[+-]?\d+([.,]\d+)?$/.test(compact) ? compact.replace(",", ".") : raw.value);
      }
      bad("MONEY_INVALID", `"${rawText(raw)}" is not an amount.`);
      return { ok: false };
    }
    case "number":
    case "integer": {
      if (raw.kind === "blank") return ok(null);
      let n = Number.NaN;
      if (raw.kind === "number") n = raw.value;
      else if (raw.kind === "string") {
        const compact = raw.value.replace(/[\s  ]/g, "");
        if (/^[+-]?\d+([.,]\d+)?$/.test(compact)) n = Number(compact.replace(",", "."));
      }
      if (!Number.isFinite(n) || (column.kind === "integer" && !Number.isSafeInteger(n))) {
        bad("NUMBER_INVALID", `"${rawText(raw)}" is not a valid ${column.kind === "integer" ? "whole number" : "number"}.`);
        return { ok: false };
      }
      return ok(n);
    }
    case "boolean": {
      if (raw.kind === "blank") return ok(column.key === "cardPayment" ? false : null);
      if (raw.kind === "boolean") return ok(raw.value);
      const textValue = normalizeHeader(rawText(raw));
      if (["ano", "true", "1", "yes"].includes(textValue)) return ok(true);
      if (["ne", "false", "0", "no"].includes(textValue)) return ok(false);
      bad("BOOLEAN_INVALID", `"${rawText(raw)}" must be Ano or Ne.`);
      return { ok: false };
    }
    case "taxMode": {
      if (raw.kind === "blank") return ok("auto");
      const mode = matchEnum(raw, REVIEW_TAX_MODE_LABELS);
      if (!mode) {
        bad("TAX_MODE_INVALID", `Unknown VAT mode "${rawText(raw)}". Use ${Object.values(REVIEW_TAX_MODE_LABELS).join(" / ")}.`);
        return { ok: false };
      }
      return ok(mode);
    }
    case "pages": {
      if (raw.kind === "blank") return ok([]);
      if (raw.kind === "number") {
        if (Number.isSafeInteger(raw.value) && raw.value > 0 && raw.value <= MAX_PAGE_NUMBER) return ok([raw.value]);
      } else if (raw.kind === "string") {
        const pages = parsePages(raw.value);
        if (pages) return ok(pages);
      }
      bad("PAGES_INVALID", `"${rawText(raw)}" is not a page list such as 1, 2 or 3-4.`);
      return { ok: false };
    }
    default:
      return { ok: false };
  }
}

function parsePages(value: string): number[] | undefined {
  const pages: number[] = [];
  for (const part of value.split(/[,;\s]+/).filter(Boolean)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return undefined;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from < 1 || to < from || to > MAX_PAGE_NUMBER || to - from > 1000) return undefined;
    for (let page = from; page <= to; page++) if (!pages.includes(page)) pages.push(page);
  }
  return pages.length ? pages : undefined;
}

function parseIsoDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? validDate(Number(match[1]), Number(match[2]), Number(match[3])) : undefined;
}

function parseDateText(value: string): string | undefined {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const cz = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(value);
  const date = iso ? validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    : cz ? validDate(Number(cz[3]), Number(cz[2]), Number(cz[1])) : undefined;
  return date?.toISOString().slice(0, 10);
}

function validDate(year: number, month: number, day: number): Date | undefined {
  if (year < 1900 || year > 2999) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
}
