import type { PreviewDuplicateCheck } from "./expense-duplicates.js";

export type ReviewTool = "create_invoice" | "create_other_liability" | "create_cash_voucher";
export type ReviewAction = "import" | "review" | "skip";
export type ReviewRow = {
  rowId: string;
  tool: ReviewTool;
  data: Record<string, any>;
  action: ReviewAction;
  reviewNotes: string;
  duplicateCheck?: PreviewDuplicateCheck;
  /** Visible POHODA target cells as read back (never data; see expense-review mapping). */
  targets?: Record<string, unknown>;
};
export type ReviewWorkbook = {
  reviewId: string;
  databaseId: string;
  vatPeriod: string;
  rows: ReviewRow[];
  examples: Array<Record<string, any>>;
};
export type ReviewWorkbookRead = Pick<ReviewWorkbook, "reviewId" | "databaseId" | "vatPeriod" | "rows">;
