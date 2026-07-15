import type { Rule } from "eslint";
import type { JSXAttribute, JSXElement, JSXText, Node, Property, TemplateElement } from "estree";
import { isBrandOrModelLiteral, isTechnicalLiteral } from "./i18n-allowlist.ts";
import { formatHardcodedSnippet, i18nLocaleFileHint } from "./i18n-locales.ts";

const LITERAL_PATTERN =
  /[A-Za-zÀ-ÖØ-öø-ÿ\u0100-\u024F\u1E00-\u1EFF\u0400-\u04FF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/u;

const UI_ATTRS = new Set([
  "title",
  "placeholder",
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "alt",
]);

const DATA_COPY_KEYS = new Set([
  "label",
  "title",
  "description",
  "placeholder",
  "message",
  "reason",
  "text",
  "summary",
  "subtitle",
  "helper",
  "empty",
  "hint",
]);

function isAllowedLiteral(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (!LITERAL_PATTERN.test(trimmed)) return true;
  if (isTechnicalLiteral(trimmed)) return true;
  if (isBrandOrModelLiteral(trimmed)) return true;
  return false;
}

function reportLiteral(
  context: Rule.RuleContext,
  node: Node,
  value: string,
  messageId: "uiString" | "dataCopy",
) {
  if (isAllowedLiteral(value)) return;
  context.report({
    node,
    messageId,
    data: {
      snippet: formatHardcodedSnippet(value),
      locales: i18nLocaleFileHint(),
    },
  });
}

function isInsideTrans(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (current.type === "JSXElement") {
      const opening = (current as JSXElement).openingElement;
      const name = opening.name;
      if (name.type === "JSXIdentifier" && name.name === "Trans") return true;
    }
    current = (current as { parent?: Node }).parent;
  }
  return false;
}

function isTransProp(node: Node): boolean {
  const parent = (node as { parent?: Node }).parent;
  if (!parent || parent.type !== "JSXAttribute") return false;
  const attr = parent as JSXAttribute;
  if (attr.name.type !== "JSXIdentifier") return false;
  return attr.name.name === "k" || attr.name.name === "cmd";
}

function isInsideTCall(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (current.type === "CallExpression") {
      const callee = (current as { callee: Node }).callee;
      if (callee.type === "Identifier" && callee.name === "t") return true;
    }
    current = (current as { parent?: Node }).parent;
  }
  return false;
}

function propertyKeyName(key: Property["key"]): string | null {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

const noHardcodedUiStrings: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow hardcoded user-facing UI strings; use src/i18n keys via useT/t/Trans.",
    },
    schema: [],
    messages: {
      uiString:
        'Hardcoded UI text: "{{snippet}}". Add a key to {{locales}} and render with t() or <Trans />. Company names and model ids are the only allowed literals.',
    },
  },
  create(context) {
    return {
      JSXText(node: JSXText) {
        const value = node.value.replace(/\s+/g, " ").trim();
        if (!value) return;
        reportLiteral(context, node, value, "uiString");
      },
      JSXAttribute(node: JSXAttribute) {
        if (node.name.type !== "JSXIdentifier") return;
        if (!UI_ATTRS.has(node.name.name)) return;
        const valueNode = node.value;
        if (!valueNode) return;
        if (valueNode.type === "Literal" && typeof valueNode.value === "string") {
          reportLiteral(context, valueNode, valueNode.value, "uiString");
          return;
        }
        if (valueNode.type === "JSXExpressionContainer") {
          const expr = valueNode.expression;
          if (expr.type === "Literal" && typeof expr.value === "string") {
            reportLiteral(context, expr, expr.value, "uiString");
          }
        }
      },
      Literal(node) {
        if (typeof node.value !== "string") return;
        const parent = (node as { parent?: Node }).parent;
        if (!parent) return;
        if (parent.type === "ImportDeclaration") return;
        if (isInsideTrans(node) || isTransProp(node) || isInsideTCall(node)) return;
        if (parent.type === "JSXAttribute") return;
        if (parent.type === "JSXExpressionContainer") return;
        if (parent.type === "Property") {
          const key = propertyKeyName((parent as Property).key);
          if (key && DATA_COPY_KEYS.has(key)) {
            reportLiteral(context, node, node.value, "uiString");
          }
        }
      },
      TemplateElement(node: TemplateElement) {
        if ((node.value.expressions?.length ?? 0) > 0) return;
        const raw = node.value.raw.replace(/\s+/g, " ").trim();
        if (!raw) return;
        reportLiteral(context, node, raw, "uiString");
      },
    };
  },
};

const noHardcodedDataCopy: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow hardcoded label/title/description fields in data helpers.",
    },
    schema: [],
    messages: {
      dataCopy:
        'Hardcoded user-facing copy: "{{snippet}}". Use i18n keys (e.g. labelKey) in {{locales}} and resolve with t() at render time.',
    },
  },
  create(context) {
    return {
      Property(node: Property) {
        const key = propertyKeyName(node.key);
        if (!key || !DATA_COPY_KEYS.has(key)) return;
        const value = node.value;
        if (value.type === "Literal" && typeof value.value === "string") {
          reportLiteral(context, value, value.value, "dataCopy");
        }
      },
    };
  },
};

export default {
  rules: {
    "no-hardcoded-ui-strings": noHardcodedUiStrings,
    "no-hardcoded-data-copy": noHardcodedDataCopy,
  },
};
