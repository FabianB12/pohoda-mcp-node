import { randomInt } from "node:crypto";
import { namespaces } from "./constants.js";

export type XmlValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | XmlObject
  | XmlValue[];

export type XmlObject = { [key: string]: XmlValue };

export type DataPackItem = {
  rootElement: string;
  version: string;
  data: XmlObject;
  rootAttrs?: Record<string, string>;
  note?: string;
};

export class XmlBuilder {
  public constructor(
    private readonly ico: string,
    private readonly application = "MCP Server"
  ) {}

  public build(
    rootElement: string,
    version: string,
    data: XmlObject,
    note = "",
    rootAttrs: Record<string, string> = {},
    dataPackId = ""
  ): string {
    const id = normalizeDataPackId(dataPackId);
    const root = element(rootElement, { version, ...rootAttrs }, writeData(data));
    return this.wrapDataPack(id, note, [
      element("dat:dataPackItem", { id, version: "2.0" }, root)
    ]);
  }

  public buildMany(items: DataPackItem[], note = "", dataPackId = ""): string {
    if (items.length === 0) {
      throw new Error("At least one dataPackItem is required.");
    }
    const id = normalizeDataPackId(dataPackId);
    return this.wrapDataPack(id, note, items.map((item, index) => {
      const itemId = `${id}-${index + 1}`;
      return element("dat:dataPackItem", {
        id: itemId,
        version: "2.0",
        ...(item.note ? { note: item.note } : {})
      }, element(item.rootElement, { version: item.version, ...(item.rootAttrs ?? {}) }, writeData(item.data)));
    }));
  }

  public buildRaw(innerXml: string, note = "", dataPackId = ""): string {
    return this.buildRawMany([innerXml], note, dataPackId);
  }

  public buildRawMany(innerXmlItems: string[], note = "", dataPackId = ""): string {
    if (innerXmlItems.length === 0) {
      throw new Error("At least one raw XML item is required.");
    }
    const id = normalizeDataPackId(dataPackId);
    return this.wrapDataPack(id, note, innerXmlItems.map((innerXml, index) =>
      element("dat:dataPackItem", { id: `${id}-${index + 1}`, version: "2.0" }, innerXml)
    ));
  }

  private wrapDataPack(id: string, note: string, items: string[]): string {
    return '<?xml version="1.0" encoding="Windows-1250"?>'
      + element("dat:dataPack", {
        ...Object.fromEntries(Object.entries(namespaces).map(([prefix, uri]) => [`xmlns:${prefix}`, uri])),
        id,
        ico: this.ico,
        application: this.application,
        version: "2.0",
        note
      }, items.join(""));
  }
}

export function normalizeDataPackId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") {
    return randomInt(1, 100_000_000).toString().padStart(8, "0");
  }
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(trimmed)) {
    throw new Error("dataPackId may contain only letters, numbers, dot, underscore, colon, and dash, max 64 characters.");
  }
  return trimmed;
}

function writeData(data: XmlObject | XmlValue[]): string {
  let xml = "";
  const entries = Array.isArray(data) ? data.entries() : Object.entries(data);
  for (const [rawKey, value] of entries) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (typeof rawKey === "number") {
      if (Array.isArray(value) || isPlainObject(value)) {
        xml += writeData(value as XmlObject | XmlValue[]);
      }
      continue;
    }
    const key = String(rawKey);
    if (key.startsWith("@")) {
      continue;
    }
    if (Array.isArray(value)) {
      xml += element(key, {}, writeData(value));
      continue;
    }
    if (isPlainObject(value)) {
      const attrs: Record<string, string> = {};
      const children: XmlObject = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childKey.startsWith("@")) {
          if (isScalar(childValue)) {
            attrs[childKey.slice(1)] = String(childValue);
          }
        } else {
          children[childKey] = childValue;
        }
      }
      xml += element(key, attrs, writeData(children));
      continue;
    }
    xml += element(key, {}, scalarToText(value));
  }
  return xml;
}

function element(name: string, attrs: Record<string, string | number | boolean>, body: string): string {
  const attrText = Object.entries(attrs)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join("");
  return body === "" ? `<${name}${attrText}/>` : `<${name}${attrText}>${body}</${name}>`;
}

function scalarToText(value: string | number | boolean | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return escapeXml(String(value));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isPlainObject(value: unknown): value is XmlObject {
  return typeof value === "object" && value !== null && !(value instanceof Date) && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}
