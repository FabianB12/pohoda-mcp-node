/**
 * Forma úhrady (POHODA typ:paymentType) for the reviewed expense workbook.
 *
 * The workbook shows one editable payment-method column. Card numbering (PK series) is
 * not a separate reviewer choice: for Ostatní závazek it is derived from the method, so
 * a visible method and a hidden card flag can never disagree. Legacy workbooks with the
 * old "Platba kartou" Ano/Ne column are still read; a contradiction is a review issue.
 *
 * Values follow type.xsd paymentType/paymentType. A non-standard value is kept verbatim
 * (it is sent as typ:ids, a POHODA Forma úhrady abbreviation) but must be verified.
 */
import type { ReviewTool } from "./review-contract.js";

type Fields = Record<string, any>;

/** Official POHODA enumeration -> Czech label shown in the workbook. */
export const PAYMENT_METHOD_LABELS: Readonly<Record<string, string>> = {
  cash: "Hotově",
  creditcard: "Kartou",
  draft: "Převodem",
  delivery: "Dobírkou",
  postal: "Složenkou",
  encashment: "Inkasem",
  cheque: "Šekem",
  compensation: "Zápočtem",
  advance: "Zálohou"
};
/** Offered in the workbook drop-down; the others are retained when present. */
export const PRIMARY_PAYMENT_METHODS = ["cash", "creditcard", "draft", "delivery"] as const;
export const PAYMENT_METHOD_MAX_LENGTH = 32; // typ:ids is string32

const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const ALIASES = new Map<string, string>();
for (const [key, label] of Object.entries(PAYMENT_METHOD_LABELS)) { ALIASES.set(fold(key), key); ALIASES.set(fold(label), key); }
for (const [alias, key] of Object.entries({
  card: "creditcard", "credit card": "creditcard", karta: "creditcard", "platebni kartou": "creditcard", "platba kartou": "creditcard",
  hotovost: "cash", "v hotovosti": "cash",
  prikazem: "draft", prevod: "draft", "bankovnim prevodem": "draft", "bankovni prevod": "draft",
  dobirka: "delivery", slozenka: "postal", inkaso: "encashment", sek: "cheque", zapocet: "compensation"
})) ALIASES.set(alias, key);

const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/** "" for blank, the POHODA enumeration for a known method, otherwise the trimmed text. */
export function normalizePaymentMethod(value: unknown): string {
  if (blank(value)) return "";
  const raw = String(value).normalize("NFC").trim();
  return ALIASES.get(fold(raw)) ?? raw;
}

export const isStandardPaymentMethod = (value: unknown): boolean => normalizePaymentMethod(value) in PAYMENT_METHOD_LABELS;

export function paymentMethodLabel(value: unknown): string {
  const method = normalizePaymentMethod(value);
  return PAYMENT_METHOD_LABELS[method] ?? method;
}

const isCommitment = (tool: ReviewTool, data: Fields) => tool === "create_other_liability" || (tool === "create_invoice" && String(data.type ?? "").trim() === "commitment");

/** Method a row is shown with: explicit paymentType, else a legacy card flag, else cash for a cash voucher. */
export function displayedPaymentMethod(tool: ReviewTool, data: Fields): string {
  const method = normalizePaymentMethod(data?.paymentType);
  if (method) return method;
  if (data?.cardPayment === true) return "creditcard";
  return tool === "create_cash_voucher" ? "cash" : "";
}

/** Whether PK card numbering applies: card commitments only, derived from the method. */
export function effectiveCardPayment(tool: ReviewTool, data: Fields): boolean {
  return isCommitment(tool, data) && displayedPaymentMethod(tool, data) === "creditcard";
}

export type PaymentReconciliation = { data: Fields; conflict?: string; notes: string[] };

/**
 * Makes paymentType the single source of the payment method and derives cardPayment.
 * `legacyCard` is an explicit card flag from the caller or an old workbook column
 * (undefined when absent). Contradictions are returned, never silently resolved.
 */
export function reconcilePaymentMethod(tool: ReviewTool, input: Fields, legacyCard?: unknown): PaymentReconciliation {
  const data: Fields = { ...input };
  const notes: string[] = [];
  let conflict: string | undefined;
  let method = normalizePaymentMethod(data.paymentType);
  const card = legacyCard === true ? true : legacyCard === false ? false : undefined;
  const label = (m: string) => paymentMethodLabel(m) || "(prázdné)";

  if (card === true && method === "") method = "creditcard";
  else if (card === true && method !== "creditcard") conflict = `Platba kartou = Ano, ale Forma úhrady = ${label(method)}. Nastavte správnou Formu úhrady.`;
  else if (card === false && method === "creditcard" && isCommitment(tool, data)) conflict = "Platba kartou = Ne, ale Forma úhrady = Kartou. Karta u Ostatního závazku znamená číslování řady PK; potvrďte Formu úhrady.";

  if (tool === "create_cash_voucher") {
    // A cash voucher is cash by agenda; vch:voucherHeader has no paymentType element.
    if (method !== "" && method !== "cash") conflict ??= `Pokladní výdej se hradí hotově, Forma úhrady je ${label(method)}. Změňte Formu úhrady nebo připravte doklad jako fakturu/závazek.`;
    else method = "";
  } else if (method === "creditcard" && !isCommitment(tool, data) && card === true) {
    conflict ??= "Platba kartou u Přijaté faktury: číslování řady PK platí jen pro Ostatní závazek. Doklad zůstane Přijatou fakturou s Formou úhrady Kartou; potvrďte, nebo připravte jako Ostatní závazek.";
  }
  if (method && !(method in PAYMENT_METHOD_LABELS)) {
    if (method.length > PAYMENT_METHOD_MAX_LENGTH) conflict ??= `Forma úhrady "${method}" je delší než ${PAYMENT_METHOD_MAX_LENGTH} znaků.`;
    else notes.push(`Forma úhrady "${method}" není standardní forma POHODY (${PRIMARY_PAYMENT_METHODS.map((m) => PAYMENT_METHOD_LABELS[m]).join(", ")}); import ji pošle jako zkratku formy úhrady, ověřte ji v POHODĚ.`);
  }

  // The visible method is kept as given; with a conflict the row stays in review, and
  // the card flag always follows that visible method so preview and import agree.
  if (method) data.paymentType = method; else delete data.paymentType;
  if (isCommitment(tool, data) && method === "creditcard") data.cardPayment = true;
  else delete data.cardPayment;
  return conflict ? { data, conflict, notes } : { data, notes };
}
