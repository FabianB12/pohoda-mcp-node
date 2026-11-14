export type ReviewTool = "create_invoice" | "create_other_liability" | "create_cash_voucher";
export type ReviewAction = "import" | "review" | "skip";
export type ReviewRow = {
  rowId: string;
  tool: ReviewTool;
  data: Record<string, any>;
  action: ReviewAction;
  reviewNotes: string;
};
export type ReviewWorkbook = {
  reviewId: string;
  databaseId: string;
  vatPeriod: string;
  rows: ReviewRow[];
  examples: Array<Record<string, any>>;
};
export type ReviewWorkbookRead = Pick<ReviewWorkbook, "reviewId" | "databaseId" | "vatPeriod" | "rows">;
