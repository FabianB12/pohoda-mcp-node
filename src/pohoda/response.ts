import { XMLParser } from "fast-xml-parser";

export type ResponseArray = {
  state: string;
  programVersion: string;
  transport: Record<string, unknown>;
  items: ResponseItemArray[];
};

export type ResponseItemArray = {
  id: string;
  state: string;
  elementName: string;
  attributes: Record<string, string>;
  data: Record<string, any>;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (_name, jPath) => [
    "responsePack.responsePackItem",
    "responsePack.responsePackItem.listInvoice.invoice",
    "responsePack.responsePackItem.listAddressBook.addressbook",
    "responsePack.responsePackItem.listAccountingUnit.itemAccountingUnit"
  ].includes(String(jPath))
});

export class PohodaResponse {
  public readonly state: string;
  public readonly programVersion: string;
  public readonly items: PohodaResponseItem[];

  public constructor(xml: string, public readonly transport: Record<string, unknown> = {}) {
    let root: any;
    try {
      const parsed = parser.parse(xml);
      root = parsed?.responsePack;
    } catch {
      root = null;
    }
    if (!root || typeof root !== "object") {
      this.state = "error";
      this.programVersion = "";
      this.items = [];
      return;
    }

    this.state = asString(root["@state"]) || "unknown";
    this.programVersion = asString(root["@programVersion"]);
    this.items = asArray(root.responsePackItem).map((item) => new PohodaResponseItem(item, "responsePackItem"));
  }

  public isOk(): boolean {
    return this.state === "ok" && this.items.every((item) => item.isOk());
  }

  public toArray(): ResponseArray {
    return {
      state: this.state,
      programVersion: this.programVersion,
      transport: this.transport,
      items: this.items.map((item) => item.toArray())
    };
  }
}

export class PohodaResponseItem {
  public readonly id: string;
  public readonly state: string;
  public readonly elementName: string;
  public readonly attributes: Record<string, string>;
  public readonly data: Record<string, any>;

  public constructor(node: any, elementName: string) {
    this.elementName = elementName;
    this.attributes = attributesOf(node);
    this.id = this.attributes.id ?? "";
    this.state = this.attributes.state ?? "unknown";
    this.data = parseItemData(node);
  }

  public isOk(): boolean {
    return this.state === "ok" && nestedState(this.data) !== "error";
  }

  public toArray(): ResponseItemArray {
    return {
      id: this.id,
      state: this.state,
      elementName: this.elementName,
      attributes: this.attributes,
      data: this.data
    };
  }
}

function parseItemData(node: any): Record<string, any> {
  const data: Record<string, any> = {};
  let primaryParsed = false;
  for (const [name, value] of Object.entries(node ?? {})) {
    if (name.startsWith("@")) {
      continue;
    }
    const parsed = normalizeParsed(value);
    if (!primaryParsed && !["note", "importDetails"].includes(name)) {
      if (isRecord(parsed)) {
        Object.assign(data, parsed);
      } else {
        data[name] = parsed;
      }
      primaryParsed = true;
      continue;
    }
    append(data, name, parsed);
  }
  return data;
}

function normalizeParsed(value: any): any {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeParsed(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const attrs = attributesOf(value);
  const entries = Object.entries(value).filter(([key]) => !key.startsWith("@"));
  if (entries.length === 0) {
    return Object.keys(attrs).length > 0 ? attrs : "";
  }
  const result: Record<string, any> = { ...attrs };
  for (const [key, child] of entries) {
    append(result, key, normalizeParsed(child));
  }
  return result;
}

function nestedState(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    return value.some((item) => nestedState(item) === "error") ? "error" : "";
  }
  const object = value as Record<string, unknown>;
  if (String(object.state ?? "") === "error") {
    return "error";
  }
  return Object.values(object).some((child) => nestedState(child) === "error") ? "error" : "";
}

function append(target: Record<string, any>, key: string, value: any): void {
  if (target[key] === undefined) {
    target[key] = value;
  } else if (Array.isArray(target[key])) {
    target[key].push(value);
  } else {
    target[key] = [target[key], value];
  }
}

function attributesOf(value: any): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const attrs: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.startsWith("@")) {
      attrs[key.slice(1)] = asString(raw);
    }
  }
  return attrs;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
