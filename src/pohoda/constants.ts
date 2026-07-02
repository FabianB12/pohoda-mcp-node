export const namespaces = {
  dat: "http://www.stormware.cz/schema/version_2/data.xsd",
  typ: "http://www.stormware.cz/schema/version_2/type.xsd",
  ftr: "http://www.stormware.cz/schema/version_2/filter.xsd",
  inv: "http://www.stormware.cz/schema/version_2/invoice.xsd",
  vch: "http://www.stormware.cz/schema/version_2/voucher.xsd",
  bnk: "http://www.stormware.cz/schema/version_2/bank.xsd",
  int: "http://www.stormware.cz/schema/version_2/intDoc.xsd",
  vyd: "http://www.stormware.cz/schema/version_2/vydejka.xsd",
  pri: "http://www.stormware.cz/schema/version_2/prijemka.xsd",
  pro: "http://www.stormware.cz/schema/version_2/prodejka.xsd",
  pre: "http://www.stormware.cz/schema/version_2/prevodka.xsd",
  vyr: "http://www.stormware.cz/schema/version_2/vyroba.xsd",
  ofr: "http://www.stormware.cz/schema/version_2/offer.xsd",
  enq: "http://www.stormware.cz/schema/version_2/enquiry.xsd",
  con: "http://www.stormware.cz/schema/version_2/contract.xsd",
  cen: "http://www.stormware.cz/schema/version_2/centre.xsd",
  acv: "http://www.stormware.cz/schema/version_2/activity.xsd",
  ord: "http://www.stormware.cz/schema/version_2/order.xsd",
  adb: "http://www.stormware.cz/schema/version_2/addressbook.xsd",
  stk: "http://www.stormware.cz/schema/version_2/stock.xsd",
  sto: "http://www.stormware.cz/schema/version_2/store.xsd",
  str: "http://www.stormware.cz/schema/version_2/storage.xsd",
  bka: "http://www.stormware.cz/schema/version_2/bankAccount.xsd",
  prm: "http://www.stormware.cz/schema/version_2/parameter.xsd",
  sup: "http://www.stormware.cz/schema/version_2/supplier.xsd",
  bal: "http://www.stormware.cz/schema/version_2/balance.xsd",
  prn: "http://www.stormware.cz/schema/version_2/print.xsd",
  lst: "http://www.stormware.cz/schema/version_2/list.xsd",
  lStk: "http://www.stormware.cz/schema/version_2/list_stock.xsd",
  lAdb: "http://www.stormware.cz/schema/version_2/list_addBook.xsd",
  lCon: "http://www.stormware.cz/schema/version_2/list_contract.xsd",
  lCen: "http://www.stormware.cz/schema/version_2/list_centre.xsd",
  lAcv: "http://www.stormware.cz/schema/version_2/list_activity.xsd",
  acu: "http://www.stormware.cz/schema/version_2/accountingunit.xsd",
  mov: "http://www.stormware.cz/schema/version_2/movement.xsd",
  req: "http://www.stormware.cz/schema/version_2/productRequirement.xsd",
  srv: "http://www.stormware.cz/schema/version_2/service.xsd",
  clm: "http://www.stormware.cz/schema/version_2/claim.xsd",
  rgn: "http://www.stormware.cz/schema/version_2/registrationNumber.xsd",
  rul: "http://www.stormware.cz/schema/version_2/rulesPairing.xsd",
  uag: "http://www.stormware.cz/schema/version_2/userAgenda.xsd",
  grs: "http://www.stormware.cz/schema/version_2/groupStocks.xsd",
  acp: "http://www.stormware.cz/schema/version_2/actionPrice.xsd",
  ilt: "http://www.stormware.cz/schema/version_2/inventoryLists.xsd",
  pay: "http://www.stormware.cz/schema/version_2/payment.xsd",
  unt: "http://www.stormware.cz/schema/version_2/measureUnit.xsd",
  vat: "http://www.stormware.cz/schema/version_2/classificationVAT.xsd",
  rec: "http://www.stormware.cz/schema/version_2/recyclingContrib.xsd"
} as const;

export const vatRates = ["none", "low", "high"] as const;
export const voucherTypes = ["receipt", "expense"] as const;
export const activityActions = ["add", "update", "delete"] as const;
export const sphereTypes = [
  "business", "loan", "specificRegulations", "other", "cheques",
  "exchangeRateDifference", "penalty", "labourLaw"
] as const;
export const invoiceTypes = [
  "issuedInvoice", "issuedCreditNotice", "issuedDebitNote", "issuedAdvanceInvoice",
  "receivable", "issuedProformaInvoice", "penalty", "issuedCorrectiveTax",
  "receivedInvoice", "receivedCreditNotice", "receivedDebitNote", "receivedAdvanceInvoice",
  "commitment", "receivedProformaInvoice", "receivedCorrectiveTax"
] as const;

export const documentAgendas = [
  "invoice", "order", "voucher", "bank", "contract", "intDoc", "offer", "enquiry",
  "vydejka", "prijemka", "prodejka", "prevodka", "vyroba", "accountancy",
  "movement", "productRequirement", "service", "claim"
] as const;

export const exportAgendas = [
  "registrationNumber", "rulesPairing", "groupStocks", "actionPrice",
  "inventoryLists", "payment", "classificationVAT", "recyclingContrib",
  "store", "bankAccount", "cashRegister", "numericalSeries", "centre", "activity"
] as const;

export const exportAgendasWithoutFilters = ["classificationVAT"] as const;
export const exportAgendasWithLastChanges = ["registrationNumber", "store"] as const;
export const exportAgendasWithoutServerLimit = ["centre", "activity"] as const;

export const printAgendas = [
  "adresar", "banka", "cenove_akce", "cenove_skupiny", "cleneni_skladu", "evidencni_cisla",
  "interni_doklady", "inventura", "inventurni_seznamy", "ostatni_pohledavky", "ostatni_zavazky",
  "pohyby", "pokladna", "prevod", "prijate_faktury", "prijate_nabidky", "prijate_objednavky",
  "prijate_poptavky", "prijate_zalohove_faktury", "prijemky", "prodejky", "prodejni_ceny",
  "reklamace", "servis", "sklady", "uzivatelska_agenda", "vydane_faktury", "vydane_nabidky",
  "vydane_objednavky", "vydane_poptavky", "vydane_zalohove_faktury", "vydejky", "vyroba",
  "vyrobni_pozadavky", "zakazky", "zasoby"
] as const;

export type AgendaConfig = {
  listPrefix: "lst" | "lStk" | "lAdb" | "lCon" | "lCen" | "lAcv";
  listRequest: string;
  requestTag: string;
  versionAttr?: string;
};

export const agendaConfig: Record<string, AgendaConfig> = {
  stock: { listPrefix: "lStk", listRequest: "listStockRequest", requestTag: "requestStock" },
  invoice: { listPrefix: "lst", listRequest: "listInvoiceRequest", requestTag: "requestInvoice" },
  addressbook: { listPrefix: "lAdb", listRequest: "listAddressBookRequest", requestTag: "requestAddressBook", versionAttr: "addressBookVersion" },
  order: { listPrefix: "lst", listRequest: "listOrderRequest", requestTag: "requestOrder" },
  voucher: { listPrefix: "lst", listRequest: "listVoucherRequest", requestTag: "requestVoucher" },
  bank: { listPrefix: "lst", listRequest: "listBankRequest", requestTag: "requestBank" },
  contract: { listPrefix: "lCon", listRequest: "listContractRequest", requestTag: "requestContract" },
  intDoc: { listPrefix: "lst", listRequest: "listIntDocRequest", requestTag: "requestIntDoc" },
  offer: { listPrefix: "lst", listRequest: "listOfferRequest", requestTag: "requestOffer" },
  enquiry: { listPrefix: "lst", listRequest: "listEnquiryRequest", requestTag: "requestEnquiry" },
  vydejka: { listPrefix: "lst", listRequest: "listVydejkaRequest", requestTag: "requestVydejka" },
  prijemka: { listPrefix: "lst", listRequest: "listPrijemkaRequest", requestTag: "requestPrijemka" },
  prodejka: { listPrefix: "lst", listRequest: "listProdejkaRequest", requestTag: "requestProdejka" },
  prevodka: { listPrefix: "lst", listRequest: "listPrevodkaRequest", requestTag: "requestPrevodka" },
  vyroba: { listPrefix: "lst", listRequest: "listVyrobaRequest", requestTag: "requestVyroba" },
  accountancy: { listPrefix: "lst", listRequest: "listAccountancyRequest", requestTag: "requestAccountancy" },
  store: { listPrefix: "lst", listRequest: "listStoreRequest", requestTag: "requestStore" },
  bankAccount: { listPrefix: "lst", listRequest: "listBankAccountRequest", requestTag: "requestBankAccount", versionAttr: "bankAccountVersion" },
  cashRegister: { listPrefix: "lst", listRequest: "listCashRegisterRequest", requestTag: "requestCashRegister", versionAttr: "cashRegisterVersion" },
  numericalSeries: { listPrefix: "lst", listRequest: "listNumericalSeriesRequest", requestTag: "requestNumericalSeries", versionAttr: "numericalSeriesVersion" },
  centre: { listPrefix: "lCen", listRequest: "listCentreRequest", requestTag: "requestCentre" },
  activity: { listPrefix: "lAcv", listRequest: "listActivityRequest", requestTag: "requestActivity" },
  movement: { listPrefix: "lst", listRequest: "listMovementRequest", requestTag: "requestMovement", versionAttr: "movementVersion" },
  productRequirement: { listPrefix: "lst", listRequest: "listProductRequirementRequest", requestTag: "requestProductRequirement", versionAttr: "productRequirementVersion" },
  service: { listPrefix: "lst", listRequest: "listServiceRequest", requestTag: "requestService", versionAttr: "serviceVersion" },
  claim: { listPrefix: "lst", listRequest: "listClaimRequest", requestTag: "requestClaim", versionAttr: "claimVersion" },
  registrationNumber: { listPrefix: "lst", listRequest: "listRegistrationNumberRequest", requestTag: "requestRegistrationNumber", versionAttr: "registrationNumberVersion" },
  rulesPairing: { listPrefix: "lst", listRequest: "listRulesPairingRequest", requestTag: "requestRulesPairing", versionAttr: "rulesPairingVersion" },
  groupStocks: { listPrefix: "lst", listRequest: "listGroupStocksRequest", requestTag: "requestGroupStocks", versionAttr: "groupStocksVersion" },
  actionPrice: { listPrefix: "lst", listRequest: "listActionPriceRequest", requestTag: "requestActionPrice", versionAttr: "actionPricesVersion" },
  inventoryLists: { listPrefix: "lst", listRequest: "listInventoryListsRequest", requestTag: "requestInventoryLists", versionAttr: "inventoryListsVersion" },
  payment: { listPrefix: "lst", listRequest: "listPaymentRequest", requestTag: "requestPayment", versionAttr: "paymentVersion" },
  classificationVAT: { listPrefix: "lst", listRequest: "listClassificationVATRequest", requestTag: "requestClassificationVAT", versionAttr: "classificationVATVersion" },
  recyclingContrib: { listPrefix: "lst", listRequest: "listRecyclingContribRequest", requestTag: "requestRecyclingContrib", versionAttr: "recyclingContribVersion" }
};

export const defaultListLimit = 100;
