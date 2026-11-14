import { describe, expect, it } from "vitest";
import { ExpensePolicyError, deriveSymVarFromDocumentNumber, isExpenseDocument, resolveExpensePolicy } from "../src/pohoda/expense-policy.js";

const taxable = {
  type: "receivedInvoice",
  text: "Material",
  vatPeriod: "2026-08",
  taxMode: "taxable", classificationVAT: "PD",
  date: "2026-08-03",
  dateKHDPH: "2026-08-02",
  originalDocument: "FA-1",
  priceHigh: 100,
  priceHighVAT: 21,
  total: 121
};

function policyError(fn: () => unknown): ExpensePolicyError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ExpensePolicyError);
    return error as ExpensePolicyError;
  }
  throw new Error("Expected ExpensePolicyError");
}

describe("isExpenseDocument", () => {
  it("covers received invoices, commitments, and cash expenses only", () => {
    expect(isExpenseDocument({ type: "receivedInvoice" })).toBe(true);
    expect(isExpenseDocument({ type: "commitment" }, "invoice")).toBe(true);
    expect(isExpenseDocument({ type: "issuedInvoice" })).toBe(false);
    expect(isExpenseDocument({ type: "receivable" })).toBe(false);
    expect(isExpenseDocument({ type: "receivedCreditNotice" })).toBe(false);
    expect(isExpenseDocument({ type: "expense" }, "voucher")).toBe(true);
    expect(isExpenseDocument({ voucherType: "expense" }, "voucher")).toBe(true);
    expect(isExpenseDocument({ type: "receipt" }, "voucher")).toBe(false);
  });
});

describe("resolveExpensePolicy", () => {
  it("returns non-expense headers unchanged", () => {
    const header = { type: "issuedInvoice", date: "2026-08-01" };
    expect(resolveExpensePolicy(header, [{ text: "x" }], "invoice")).toEqual(header);
  });

  it("normalizes an on-time taxable received invoice and records immutable source facts", () => {
    const input = { ...taxable };
    const result = resolveExpensePolicy(input, [], "invoice");
    expect(input).toEqual(taxable);
    expect(result.date).toBe("2026-08-03");
    expect(result.dateTax).toBe("2026-08-02");
    expect(result.dateKHDPH).toBe("2026-08-02");
    expect(result.dateAccounting).toBeUndefined();
    expect(result.originalDocument).toBe("FA-1");
    expect(result.sourceIssueDate).toBe("2026-08-03");
    expect(result.sourceTaxDate).toBe("2026-08-02");
    expect(result.sourceDocumentNumber).toBe("FA-1");
    expect(result.priceHighSum).toBe(121);
    expect(result.intNote).toBeUndefined();
    expect(result._expensePolicy).toMatchObject({ lateSource: false, taxMode: "taxable", vatPeriod: "2026-08" });
  });

  it("moves all four dates of a late taxable source to the period start and preserves originals", () => {
    const result = resolveExpensePolicy({ ...taxable, dateKHDPH: "2026-06-28", date: "2026-06-30", intNote: "Manual note" }, [], "invoice");
    expect(result.date).toBe("2026-08-01");
    expect(result.dateTax).toBe("2026-08-01");
    expect(result.dateAccounting).toBe("2026-08-01");
    expect(result.dateKHDPH).toBe("2026-08-01");
    expect(result.originalDocument).toBe("FA-1");
    expect(result.intNote).toBe("Manual note\nZdroj: doklad FA-1; vystaveno 2026-06-30; DUZP 2026-06-28");
    expect(result.sourceIssueDate).toBe("2026-06-30");
    expect(result.sourceTaxDate).toBe("2026-06-28");
  });

  it("is idempotent when re-applied to its own output", () => {
    const first = resolveExpensePolicy({ ...taxable, dateKHDPH: "2026-06-28", date: "2026-06-30" }, [], "invoice");
    const second = resolveExpensePolicy(first, [], "invoice");
    expect(second).toEqual(first);
    const third = resolveExpensePolicy({ ...second }, [], "invoice");
    expect(third.intNote).toBe(first.intNote);
  });

  it("never derives a taxable DUZP from the issue date", () => {
    const error = policyError(() => resolveExpensePolicy({ ...taxable, dateKHDPH: "", dateTax: "" }, [], "invoice"));
    expect(error.code).toBe("SOURCE_TAX_DATE_REQUIRED");
    expect(error.needsReview).toBe(true);
  });

  it("uses dateTax as source DUZP only when dateKHDPH is absent", () => {
    const result = resolveExpensePolicy({ ...taxable, dateKHDPH: "", dateTax: "2026-08-02" }, [], "invoice");
    expect(result.dateKHDPH).toBe("2026-08-02");
  });

  it("allows a later deduction date inside the period but rejects one outside it", () => {
    const later = resolveExpensePolicy({ ...taxable, dateTax: "2026-08-20" }, [], "invoice");
    expect(later.dateTax).toBe("2026-08-20");
    expect(later.dateKHDPH).toBe("2026-08-02");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, dateTax: "2026-09-01" }, [], "invoice")).code).toBe("DATE_PERIOD_MISMATCH");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, vatPeriod: "2026-07" }, [], "invoice")).code).toBe("VAT_PERIOD_BEFORE_SOURCE");
  });

  it("validates required header fields", () => {
    expect(policyError(() => resolveExpensePolicy(taxable, [{ text: "item" }], "invoice")).code).toBe("ITEMS_NOT_ALLOWED");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, text: " " }, [], "invoice")).code).toBe("TEXT_REQUIRED");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, text: "x".repeat(241) }, [], "invoice")).code).toBe("TEXT_TOO_LONG");
    expect(resolveExpensePolicy({ ...taxable, text: "x".repeat(240) }, [], "invoice").text).toHaveLength(240);
    expect(policyError(() => resolveExpensePolicy({ ...taxable, vatPeriod: undefined }, [], "invoice")).code).toBe("VAT_PERIOD_REQUIRED");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, vatPeriod: "2026-13" }, [], "invoice")).code).toBe("VAT_PERIOD_INVALID");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, date: "2026-02-30" }, [], "invoice")).code).toBe("DATE_INVALID");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, originalDocument: "" }, [], "invoice")).code).toBe("SOURCE_DOCUMENT_NUMBER_REQUIRED");
  });

  it("validates exact summary arithmetic without recalculating VAT", () => {
    expect(policyError(() => resolveExpensePolicy({ ...taxable, total: 121.01 }, [], "invoice")).code).toBe("SUMMARY_MISMATCH");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, priceHighSum: 120 }, [], "invoice")).code).toBe("SUMMARY_MISMATCH");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, priceHighVAT: undefined, priceHighSum: 121 }, [], "invoice")).code).toBe("SUMMARY_INCOMPLETE");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, total: undefined }, [], "invoice")).code).toBe("TOTAL_REQUIRED");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, priceHigh: undefined, priceHighVAT: undefined, total: 0 }, [], "invoice")).code).toBe("SUMMARY_REQUIRED");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, priceHigh: 100.001, total: 121.001 }, [], "invoice")).code).toBe("AMOUNT_PRECISION");

    // Implausible source VAT is kept exactly as stated, with a warning only.
    const odd = resolveExpensePolicy({ ...taxable, priceHighVAT: 30, total: 130 }, [], "invoice");
    expect(odd.priceHighVAT).toBe(30);
    expect(odd._expensePolicy.warnings.join(" ")).toMatch(/not corrected/);

    // Rounding and string amounts.
    const rounded = resolveExpensePolicy({ ...taxable, priceHigh: "99.67", priceHighVAT: "20.93", roundingAmount: "0.4", total: "121" }, [], "invoice");
    expect(rounded.priceHigh).toBe(99.67);
    expect(rounded.priceHighSum).toBe(120.6);
    expect(rounded.total).toBe(121);
  });

  it("derives tax mode only from confirmed Czech VAT status evidence", () => {
    const auto = { ...taxable, taxMode: "auto" };
    expect(resolveExpensePolicy({ ...auto, partnerCountry: "CZ", partnerVatStatus: "payer", vatStatusEvidence: "ADIS 2026-08-03" }, [], "invoice").taxMode).toBe("taxable");

    const nonPayer = resolveExpensePolicy({
      ...auto, partnerCountry: "CZ", partnerVatStatus: "non-payer", classificationVAT: "", vatStatusEvidence: "ARES 2026-08-03",
      priceHigh: undefined, priceHighVAT: undefined, priceNone: 500, total: 500, dateKHDPH: ""
    }, [], "invoice");
    expect(nonPayer.taxMode).toBe("nonTax");
    expect(nonPayer.classificationVAT).toBe("PN");
    expect(nonPayer.dateKHDPH).toBeUndefined();
    expect(nonPayer.dateTax).toBe("2026-08-03");

    const unknownCountry = policyError(() => resolveExpensePolicy({ ...auto, partnerVatStatus: "non-payer", classificationVAT: "", vatStatusEvidence: "ARES" }, [], "invoice"));
    expect(unknownCountry.code).toBe("TAX_MODE_REQUIRED");
    expect(unknownCountry.needsReview).toBe(true);
    expect(policyError(() => resolveExpensePolicy({ ...auto, partnerCountry: "DE", partnerVatStatus: "non-payer", classificationVAT: "", vatStatusEvidence: "VIES" }, [], "invoice")).code).toBe("TAX_MODE_REQUIRED");
    expect(policyError(() => resolveExpensePolicy({ ...auto, partnerCountry: "CZ", partnerVatStatus: "non-payer" }, [], "invoice")).code).toBe("VAT_STATUS_EVIDENCE_REQUIRED");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, taxMode: undefined }, [], "invoice")).code).toBe("TAX_MODE_REQUIRED");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, taxMode: "reverse" }, [], "invoice")).code).toBe("TAX_MODE_INVALID");
  });

  it("selects an exact POHODA rounding mode and rejects unrepresentable source rounding", () => {
    expect(policyError(() => resolveExpensePolicy({ ...taxable, classificationVAT: "" }, [], "invoice")).code).toBe("VAT_CLASSIFICATION_REQUIRED");
    const supported = resolveExpensePolicy({ ...taxable, priceHigh: 101.12, priceHighVAT: 21.24, roundingAmount: -0.36, total: 122 }, [], "invoice");
    expect(supported.roundingDocument).toBe("math2one");
    expect(supported.roundingAmount).toBe(-0.36);
    expect(policyError(() => resolveExpensePolicy({ ...taxable, priceHigh: 101.12, priceHighVAT: 21.24, roundingAmount: -0.42, total: 121.94 }, [], "invoice")).code).toBe("SOURCE_ROUNDING_UNSUPPORTED");
  });

  it("preserves generated source-note order across repeated builder policy application", () => {
    const first = resolveExpensePolicy({ ...taxable, date: "2026-07-10", dateTax: "2026-07-10", dateKHDPH: "2026-07-10" }, [], "invoice");
    first.intNote += "\nMCP-ID:pohoda-mcp-expenses|example";
    const second = resolveExpensePolicy(first, [], "invoice");
    expect(second.intNote).toBe(first.intNote);
  });

  it("forces PN for non-tax documents and rejects conflicting classifications", () => {
    const nonTax = { ...taxable, taxMode: "nonTax", classificationVAT: "", priceHigh: undefined, priceHighVAT: undefined, priceNone: 100, total: 100 };
    expect(resolveExpensePolicy(nonTax, [], "invoice").classificationVAT).toBe("PN");
    expect(resolveExpensePolicy({ ...nonTax, classificationVAT: "PN" }, [], "invoice").classificationVAT).toBe("PN");
    expect(policyError(() => resolveExpensePolicy({ ...nonTax, classificationVAT: "UD" }, [], "invoice")).code).toBe("TAX_MODE_CONFLICT");
    expect(policyError(() => resolveExpensePolicy({ ...taxable, classificationVAT: "PN" }, [], "invoice")).code).toBe("TAX_MODE_CONFLICT");
  });

  it("collapses source VAT into priceNone for non-tax documents and preserves the breakdown", () => {
    const result = resolveExpensePolicy({
      ...taxable,
      taxMode: "nonTax", classificationVAT: "",
      priceNone: 4.5,
      priceLow: 100,
      priceLowVAT: 12,
      priceHigh: 200,
      priceHighVAT: 42,
      roundingAmount: 0.5,
      total: 359
    }, [], "invoice");
    expect(result.priceNone).toBe(358.5);
    for (const key of ["priceLow", "priceLowVAT", "priceLowSum", "priceHigh", "priceHighVAT", "priceHighSum"]) {
      expect(result[key]).toBeUndefined();
    }
    expect(result.roundingAmount).toBe(0.5);
    expect(result.dateKHDPH).toBeUndefined();
    expect(result.sourceVatBreakdown).toEqual([{ bucket: "low", base: 100, vat: 12 }, { bucket: "high", base: 200, vat: 42 }]);
    expect(result._expensePolicy.sourceVatBreakdown).toEqual(result.sourceVatBreakdown);
    expect(result.intNote).toContain("DPH dle dokladu: snizena zaklad 100.00 DPH 12.00, zakladni zaklad 200.00 DPH 42.00");

    const again = resolveExpensePolicy(result, [], "invoice");
    expect(again.priceNone).toBe(358.5);
    expect(again.sourceVatBreakdown).toEqual(result.sourceVatBreakdown);
    expect(again.intNote).toBe(result.intNote);

    // Source arithmetic is still validated before collapsing.
    expect(policyError(() => resolveExpensePolicy({ ...taxable, taxMode: "nonTax", classificationVAT: "", total: 120 }, [], "invoice")).code).toBe("SUMMARY_MISMATCH");
  });

  it("uses issue date for lateness of non-tax documents and never emits dateKHDPH", () => {
    const result = resolveExpensePolicy({ ...taxable, taxMode: "nonTax", classificationVAT: "", dateKHDPH: "", date: "2026-07-15", priceHigh: undefined, priceHighVAT: undefined, priceNone: 100, total: 100 }, [], "invoice");
    expect(result.date).toBe("2026-08-01");
    expect(result.dateTax).toBe("2026-08-01");
    expect(result.dateAccounting).toBe("2026-08-01");
    expect(result.dateKHDPH).toBeUndefined();
    expect(result.intNote).toBe("Zdroj: doklad FA-1; vystaveno 2026-07-15");
  });

  it("handles explicit foreign non-tax documents and blocks unexpressible foreign VAT splits", () => {
    const foreign = { ...taxable, taxMode: "nonTax", classificationVAT: "", currency: "EUR", priceHigh: 100, priceHighVAT: 19, total: 119 };
    const result = resolveExpensePolicy(foreign, [], "invoice");
    expect(result.priceNone).toBe(119);
    expect(result.currencyPriceSum).toBe(119);
    expect(result.currencyRate).toBeUndefined();
    expect(result.sourceVatBreakdown).toEqual([{ bucket: "high", base: 100, vat: 19 }]);

    const split = policyError(() => resolveExpensePolicy({ ...taxable, currency: "EUR" }, [], "invoice"));
    expect(split.code).toBe("FOREIGN_TAXABLE_SPLIT_UNSUPPORTED");
    expect(split.needsReview).toBe(true);
    expect(policyError(() => resolveExpensePolicy({ ...foreign, currencyPriceSum: 120 }, [], "invoice")).code).toBe("SUMMARY_MISMATCH");

    // CZK is treated as home currency.
    const czk = resolveExpensePolicy({ ...taxable, currency: "CZK", currencyRate: 1 }, [], "invoice");
    expect(czk.currency).toBeUndefined();
    expect(czk.currencyRate).toBeUndefined();
  });

  it("applies cash-expense originalDocument threshold on the final payable amount", () => {
    const expense = { ...taxable, type: "expense", originalDocument: "UCT-9", datePayment: "2026-08-05" };
    const atLimit = resolveExpensePolicy({ ...expense, priceHigh: 8264.46, priceHighVAT: 1735.54, total: 10000 }, [], "voucher");
    expect(atLimit.originalDocument).toBeUndefined();
    expect(atLimit.sourceDocumentNumber).toBe("UCT-9");
    expect(atLimit.intNote).toBe("Zdroj: doklad UCT-9; vystaveno 2026-08-03; DUZP 2026-08-02; uhrazeno 2026-08-05");
    expect(atLimit.datePayment).toBe("2026-08-05");
    expect(atLimit.dateAccounting).toBeUndefined();

    const roundedDown = resolveExpensePolicy({ ...expense, priceHigh: 8264.88, priceHighVAT: 1735.62, roundingAmount: -0.5, total: 10000 }, [], "voucher");
    expect(roundedDown.originalDocument).toBeUndefined();

    const above = resolveExpensePolicy({ ...expense, priceHigh: 8264.47, priceHighVAT: 1735.54, roundingAmount: 0, total: 10000.01 }, [], "voucher");
    expect(above.originalDocument).toBe("UCT-9");
    expect(above.intNote).toBeUndefined();

    expect(policyError(() => resolveExpensePolicy({ ...expense, originalDocument: "", priceHigh: 9000, priceHighVAT: 1890, total: 10890 }, [], "voucher")).code).toBe("SOURCE_DOCUMENT_NUMBER_REQUIRED");
  });

  it("keeps the actual cash payment date when the voucher dates move for a late source", () => {
    const result = resolveExpensePolicy({ ...taxable, type: "expense", date: "2026-07-20", dateKHDPH: "2026-07-20", datePayment: "2026-07-21", dateAccounting: "2026-07-21" }, [], "voucher");
    expect(result.date).toBe("2026-08-01");
    expect(result.dateTax).toBe("2026-08-01");
    expect(result.dateKHDPH).toBe("2026-08-01");
    expect(result.datePayment).toBe("2026-07-21");
    expect(result.dateAccounting).toBeUndefined();
  });

  it("requires explicit CZK payable for foreign thresholds", () => {
    const foreignCash = { ...taxable, type: "expense", taxMode: "nonTax", classificationVAT: "", datePayment: "2026-07-20", currency: "EUR", priceHigh: undefined, priceHighVAT: undefined, priceNone: 50, total: 50 };
    const error = policyError(() => resolveExpensePolicy(foreignCash, [], "voucher"));
    expect(error.code).toBe("FOREIGN_THRESHOLD_NEEDS_CZK");
    expect(error.needsReview).toBe(true);
    expect(resolveExpensePolicy({ ...foreignCash, homePayableCZK: 1250 }, [], "voucher").originalDocument).toBeUndefined();
    expect(resolveExpensePolicy({ ...foreignCash, homePayableCZK: 10000.01 }, [], "voucher").originalDocument).toBe("FA-1");
  });

  it("resolves card commitments from the PK sequence", () => {
    const card = { ...taxable, type: "commitment", cardPayment: true, originalDocument: "UCT-5", symVar: "777" };
    const small = resolveExpensePolicy({ ...card, cardSequence: 12 }, [], "invoice");
    expect(small.originalDocument).toBe("K12");
    expect(small.symVar).toBe("12");
    expect(small.paymentType).toBe("creditcard");
    expect(small.sourceDocumentNumber).toBe("UCT-5");
    expect(small.sourceSymVar).toBe("777");
    expect(small.intNote).toContain("Zdroj: doklad UCT-5");

    // Re-resolving with a different sequence keeps the source facts, not the generated K number.
    const renumbered = resolveExpensePolicy({ ...small, cardSequence: 13 }, [], "invoice");
    expect(renumbered.originalDocument).toBe("K13");
    expect(renumbered.symVar).toBe("13");
    expect(renumbered.sourceDocumentNumber).toBe("UCT-5");
    expect(renumbered.intNote).toBe(small.intNote);

    const large = resolveExpensePolicy({ ...card, cardSequence: 14, priceHigh: 10000, priceHighVAT: 2100, total: 12100 }, [], "invoice");
    expect(large.originalDocument).toBe("UCT-5");
    expect(large.symVar).toBe("777");
    const largeNumeric = resolveExpensePolicy({ ...card, symVar: "", originalDocument: "2026001", cardSequence: 15, priceHigh: 10000, priceHighVAT: 2100, total: 12100 }, [], "invoice");
    expect(largeNumeric.symVar).toBe("2026001");

    expect(policyError(() => resolveExpensePolicy({ ...card, cardSequence: 0 }, [], "invoice")).code).toBe("CARD_SEQUENCE_REQUIRED");
    expect(policyError(() => resolveExpensePolicy({ ...card, cardSequence: 1.5 }, [], "invoice")).code).toBe("CARD_SEQUENCE_REQUIRED");
    expect(policyError(() => resolveExpensePolicy({ ...card, type: "receivedInvoice", cardSequence: 1 }, [], "invoice")).code).toBe("CARD_NOT_COMMITMENT");
    expect(policyError(() => resolveExpensePolicy({ ...card, cardSequence: 1, paymentType: "cash" }, [], "invoice")).code).toBe("CARD_PAYMENT_TYPE_CONFLICT");
    expect(resolveExpensePolicy({ ...card, cardSequence: 1, paymentType: "KARTA" }, [], "invoice").paymentType).toBe("KARTA");
    expect(policyError(() => resolveExpensePolicy({ ...card, cardSequence: 1, currency: "EUR", taxMode: "nonTax", classificationVAT: "" }, [], "invoice")).code).toBe("FOREIGN_THRESHOLD_NEEDS_CZK");
  });

  describe("received invoice variable symbol", () => {
    const received = { ...taxable, originalDocument: "FV-2026/0007" };

    it("derives a missing VS from the supplier document number, ASCII digits only, keeping leading zeros", () => {
      const result = resolveExpensePolicy(received, [], "invoice");
      expect(result.symVar).toBe("20260007");
      expect(result.originalDocument).toBe("FV-2026/0007");
      expect(result.sourceDocumentNumber).toBe("FV-2026/0007");
      expect(result.sourceSymVar).toBeUndefined();
      expect(result._expensePolicy.symVarRule).toBe("derived-from-source-document");
      expect(result._expensePolicy.original.symVar).toBeUndefined();
      expect(result._expensePolicy.warnings.join(" ")).toContain('derived from supplier document number "FV-2026/0007"');
      expect(resolveExpensePolicy({ ...taxable, originalDocument: "00-12/A.3 b" }, [], "invoice").symVar).toBe("00123");
      expect(resolveExpensePolicy({ ...taxable, originalDocument: "0007" }, [], "invoice").symVar).toBe("0007");
      expect(resolveExpensePolicy({ ...taxable, originalDocument: "FA\u00a0٣12" }, [], "invoice").symVar).toBe("12");
      // A blank explicit symVar counts as missing.
      expect(resolveExpensePolicy({ ...received, symVar: "  ", sourceSymVar: "" }, [], "invoice").symVar).toBe("20260007");
    });

    it("keeps an explicit VS unchanged", () => {
      for (const extra of [{ symVar: "0001" }, { sourceSymVar: "0042026" }, { sourceSymVar: "123", symVar: "999" }]) {
        const result = resolveExpensePolicy({ ...received, ...extra }, [], "invoice");
        expect(result.symVar).toBe(extra.sourceSymVar ?? extra.symVar);
        expect(result.sourceSymVar).toBe(result.symVar);
        expect(result._expensePolicy.symVarRule).toBe("source");
      }
    });

    it("uses the supplier number, never internal numbering, and is idempotent", () => {
      const first = resolveExpensePolicy({ ...received, number: "FP260001" }, [], "invoice");
      expect(first.symVar).toBe("20260007");
      const again = resolveExpensePolicy(first, [], "invoice");
      expect(again.symVar).toBe("20260007");
      expect(again.sourceSymVar).toBeUndefined();
      expect(again._expensePolicy).toEqual(first._expensePolicy);
      // A changed persisted supplier number re-derives; the stale derived symVar is not treated as source.
      const changed = resolveExpensePolicy({ ...first, sourceDocumentNumber: "FV-2026/0008" }, [], "invoice");
      expect(changed.symVar).toBe("20260008");
      const explicit = resolveExpensePolicy({ ...received, symVar: "55" }, [], "invoice");
      expect(resolveExpensePolicy(explicit, [], "invoice").symVar).toBe("55");
    });

    it("leaves VS empty for review when the number has no digits or too many digits", () => {
      const none = resolveExpensePolicy({ ...taxable, originalDocument: "ABC-X" }, [], "invoice");
      expect(none.symVar).toBeUndefined();
      expect(none.originalDocument).toBe("ABC-X");
      expect(none._expensePolicy.symVarRule).toBe("missing-no-digits");
      expect(none._expensePolicy.warnings.join(" ")).toContain("has no digits");
      const long = `FV-${"1".repeat(21)}`;
      const overflow = resolveExpensePolicy({ ...taxable, originalDocument: long }, [], "invoice");
      expect(overflow.symVar).toBeUndefined();
      expect(overflow._expensePolicy.symVarRule).toBe("missing-too-long");
      expect(overflow._expensePolicy.warnings.join(" ")).toContain("not truncated");
      // POHODA allows 20 characters; above 10 digits it warns about Czech bank payment limits.
      const twenty = resolveExpensePolicy({ ...taxable, originalDocument: "9".repeat(20) }, [], "invoice");
      expect(twenty.symVar).toBe("9".repeat(20));
      expect(twenty._expensePolicy.warnings.join(" ")).toContain("at most 10");
      // A stale symVar on a re-applied header is removed when nothing can be derived.
      expect(resolveExpensePolicy({ ...none, symVar: "1" }, [], "invoice").symVar).toBeUndefined();
      // Non-tax received invoice without any document number: nothing derived, no warning added.
      const noNumber = resolveExpensePolicy({ ...taxable, originalDocument: "", taxMode: "nonTax", classificationVAT: "" }, [], "invoice");
      expect(noNumber.symVar).toBeUndefined();
      expect(noNumber._expensePolicy.symVarRule).toBe("none");
    });

    it("applies only to received invoices", () => {
      expect(resolveExpensePolicy({ ...received, type: "commitment" }, [], "invoice").symVar).toBeUndefined();
      expect(resolveExpensePolicy({ ...received, type: "commitment", symVar: "77" }, [], "invoice").symVar).toBe("77");
      const cash = resolveExpensePolicy({ ...received, type: "expense", datePayment: "2026-11-03", priceHigh: 10000, priceHighVAT: 2100, total: 12100 }, [], "voucher");
      expect(cash.originalDocument).toBe("FV-2026/0007");
      expect(cash.symVar).toBeUndefined();
      const card = resolveExpensePolicy({ ...received, type: "commitment", cardPayment: true, cardSequence: 4, priceHigh: 10000, priceHighVAT: 2100, total: 12100 }, [], "invoice");
      expect(card.symVar).toBeUndefined();
      expect(resolveExpensePolicy({ ...received, type: "issuedInvoice" }, [], "invoice").symVar).toBeUndefined();
    });
  });

  it("deriveSymVarFromDocumentNumber never invents or truncates", () => {
    expect(deriveSymVarFromDocumentNumber("FV-2026/0007")).toMatchObject({ symVar: "20260007", reason: "derived-from-source-document" });
    expect(deriveSymVarFromDocumentNumber(" ")).toEqual({ reason: "none" });
    expect(deriveSymVarFromDocumentNumber("ŘÁD-Č.")).toMatchObject({ reason: "missing-no-digits" });
    expect(deriveSymVarFromDocumentNumber("1".repeat(21)).symVar).toBeUndefined();
  });
});
