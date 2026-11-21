type Fields = Record<string, any>;
export type ExpenseWriteItem = { id: string; state: string; data: Fields; attributes?: Record<string, string> };
type Response = { state: string; items: ExpenseWriteItem[]; transport?: Fields };
export type ExpenseWriteOutcome = {
  outcome: "created" | "rejected" | "missing" | "conflict";
  item?: ExpenseWriteItem;
  id?: number;
  expectedItemId: string;
};

const scalar = (value: any): string => value == null ? "" : typeof value === "object" ? scalar(value["#text"]) : String(value).trim();
function hasError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasError);
  const object = value as Fields;
  return scalar(object.state ?? object["@state"]) === "error" || Object.values(object).some(hasError);
}

/** Match by dataPackItem ID. A missing/duplicate response cannot be assigned by position. */
export function classifyExpenseWriteResponse(response: Response | undefined, packId: string, count: number): ExpenseWriteOutcome[] {
  const byId = new Map<string, ExpenseWriteItem[]>();
  for (const item of response?.items ?? []) byId.set(item.id, [...(byId.get(item.id) ?? []), item]);
  const packRejected = response?.state === "error" && response.items.length === 0 && response.transport?.responseOutcome === "rejected";
  return Array.from({ length: count }, (_, index) => {
    const expectedItemId = `${packId}-${index + 1}`;
    const items = byId.get(expectedItemId) ?? [];
    if (items.length !== 1) return { expectedItemId, outcome: packRejected ? "rejected" : "missing" };
    const item = items[0]!;
    const rawId = scalar(item.data?.producedDetails?.id);
    const parsedId = Number(rawId);
    const id = Number.isSafeInteger(parsedId) && parsedId > 0 ? parsedId : undefined;
    const error = item.state === "error" || hasError(item.data);
    if (id !== undefined) return { expectedItemId, item, id, outcome: error ? "conflict" : "created" };
    const definiteRejection = error && (rawId === "" || rawId === "0");
    return { expectedItemId, item, outcome: definiteRejection ? "rejected" : "missing" };
  });
}
