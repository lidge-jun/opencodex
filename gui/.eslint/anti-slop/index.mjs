/**
 * OpenCodex-local anti-slop rules.
 *
 * Adapted from dmmulroy/anti-slop at commit
 * 446268e5d15baa968eaec669ff65358d36ae6259 under the MIT license.
 * OpenCodex keeps only rules that fit this repository's TypeScript boundaries.
 */

const FUNCTION_BOUNDARY_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

const COMMENT_OWNER_TYPES = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

const PARAMETER_OWNER_TYPES = [
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSConstructorType",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
  "TSFunctionType",
  "TSMethodSignature",
];

function unwrapParenthesizedExpression(expression) {
  let current = expression;
  while (current?.type === "ParenthesizedExpression") current = current.expression;
  return current;
}

function unwrapTransparentType(type) {
  let current = type;
  while (
    current?.type === "TSParenthesizedType" ||
    (current?.type === "TSTypeOperator" && current.operator === "readonly")
  ) {
    current = current.typeAnnotation;
  }
  return current;
}

function typeReferenceName(type) {
  return type?.type === "TSTypeReference" && type.typeName?.type === "Identifier"
    ? type.typeName.name
    : null;
}

function classifyBroadType(type) {
  const current = unwrapTransparentType(type);
  if (!current) return null;
  if (current.type === "TSUnknownKeyword" || current.type === "TSAnyKeyword") return "unknown";
  if (current.type === "TSObjectKeyword") return "object";
  if (current.type === "TSMappedType") return "open dictionary";
  if (current.type === "TSTypeLiteral") {
    if (current.members?.some((member) => member.type === "TSIndexSignature")) {
      return "open dictionary";
    }
    return current.members?.length > 0 ? "anonymous object" : null;
  }
  if (current.type !== "TSTypeReference") return null;

  const name = typeReferenceName(current);
  if (["Readonly", "Partial", "Required", "NonNullable"].includes(name)) {
    const inner = current.typeArguments?.params?.[0];
    return inner ? classifyBroadType(inner) : null;
  }
  return name === "Record" ? "open dictionary" : null;
}

function resolveVariable(sourceCode, identifier) {
  if (typeof sourceCode?.getScope !== "function") return null;
  let scope = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set?.get?.(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

function variableDeclarator(variable) {
  const definitions = variable?.defs ?? [];
  if (definitions.length !== 1) return null;
  const [definition] = definitions;
  return definition?.type === "Variable" && definition.node?.type === "VariableDeclarator"
    ? definition.node
    : null;
}

function isStableConstDeclarator(declarator) {
  return declarator?.parent?.type === "VariableDeclaration" && declarator.parent.kind === "const";
}

function isKnownEvidenceExpression(sourceCode, expression, visitedVariables = new Set()) {
  let current = expression;
  while (current?.type === "ParenthesizedExpression" || current?.type === "TSNonNullExpression") {
    current = current.expression;
  }

  if (current?.type === "TSAsExpression" || current?.type === "TSTypeAssertion") {
    if (classifyBroadType(current.typeAnnotation) === null) return true;
    return isKnownEvidenceExpression(sourceCode, current.expression, visitedVariables);
  }
  if (current?.type === "TSSatisfiesExpression") {
    return isKnownEvidenceExpression(sourceCode, current.expression, visitedVariables);
  }

  if (
    current?.type === "Literal" ||
    current?.type === "TemplateLiteral" ||
    current?.type === "ArrayExpression" ||
    current?.type === "ArrowFunctionExpression" ||
    current?.type === "ClassExpression" ||
    current?.type === "FunctionExpression" ||
    current?.type === "NewExpression" ||
    current?.type === "ObjectExpression"
  ) {
    return true;
  }

  if (current?.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, current);
  if (!variable || visitedVariables.has(variable)) return false;
  const declarator = variableDeclarator(variable);
  if (!declarator || !isStableConstDeclarator(declarator)) return false;

  if (
    declarator.id?.type === "Identifier" &&
    declarator.id.typeAnnotation?.typeAnnotation &&
    classifyBroadType(declarator.id.typeAnnotation.typeAnnotation) === null
  ) {
    return true;
  }
  if (!declarator.init) return false;

  const nextVisited = new Set(visitedVariables);
  nextVisited.add(variable);
  return isKnownEvidenceExpression(sourceCode, declarator.init, nextVisited);
}

function isTypeAssertion(node) {
  return node?.type === "TSAsExpression" || node?.type === "TSTypeAssertion";
}

function isConstAssertion(node) {
  const annotation = node?.typeAnnotation;
  return (
    annotation?.type === "TSTypeReference" &&
    annotation.typeName?.type === "Identifier" &&
    annotation.typeName.name === "const"
  );
}

function outermostAssertionInChain(node) {
  let current = node;
  let parent = node.parent;
  while (parent?.type === "ParenthesizedExpression" && parent.expression === current) {
    current = parent;
    parent = parent.parent;
  }
  return !isTypeAssertion(parent) || parent.expression !== current;
}

function forbiddenAssertionChain(node) {
  let assertionCount = 0;
  let hasNonConst = false;
  let current = node;
  while (isTypeAssertion(current)) {
    assertionCount += 1;
    hasNonConst ||= !isConstAssertion(current);
    current = unwrapParenthesizedExpression(current.expression);
  }
  return assertionCount > 1 && hasNonConst;
}

const noChainedTypeAssertions = {
  meta: {
    type: "problem",
    docs: { description: "Disallow chained TypeScript type assertions." },
    schema: [],
    messages: {
      chained:
        "This assertion chain discards type evidence. Keep the precise type or parse untrusted input before narrowing it.",
    },
  },
  create(context) {
    const check = (node) => {
      if (outermostAssertionInChain(node) && forbiddenAssertionChain(node)) {
        context.report({ node, messageId: "chained" });
      }
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

function nearestFunction(node) {
  let current = node?.parent;
  while (current && current.type !== "Program") {
    if (FUNCTION_BOUNDARY_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function sourceKeyName(sourceCode, key) {
  if (key?.type === "Identifier" || key?.type === "PrivateIdentifier") return key.name;
  if (key?.type === "Literal") return String(key.value);
  return sourceCode.getText(key);
}

function functionName(sourceCode, owner) {
  if (!owner) return "anonymous function";
  if (owner.id?.name) return owner.id.name;
  const parent = owner.parent;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return parent.id.name;
  }
  if (parent?.type === "MethodDefinition") return sourceKeyName(sourceCode, parent.key);
  return "anonymous function";
}

function hasParentAssertion(node) {
  return isTypeAssertion(node?.parent);
}

const noKnownValueWidening = {
  meta: {
    type: "problem",
    docs: { description: "Reject clear syntax-only cases where known values are widened." },
    schema: [],
    messages: {
      widening:
        "The explicit {{target}} type on {{subject}} discards known type evidence. Keep inference, use `satisfies`, or use a named owner contract.",
    },
  },
  create(context) {
    const reportFlow = (expression, annotation, subject) => {
      if (!expression || !annotation) return;
      const target = classifyBroadType(annotation);
      if (!target || !isKnownEvidenceExpression(context.sourceCode, expression)) return;
      context.report({ node: expression, messageId: "widening", data: { subject, target } });
    };

    return {
      VariableDeclarator(node) {
        if (node.init && node.id?.type === "Identifier") {
          reportFlow(node.init, node.id.typeAnnotation?.typeAnnotation, `binding \`${node.id.name}\``);
        }
      },
      PropertyDefinition(node) {
        if (node.value) {
          reportFlow(
            node.value,
            node.typeAnnotation?.typeAnnotation,
            `property \`${sourceKeyName(context.sourceCode, node.key)}\``,
          );
        }
      },
      AccessorProperty(node) {
        if (node.value) {
          reportFlow(
            node.value,
            node.typeAnnotation?.typeAnnotation,
            `property \`${sourceKeyName(context.sourceCode, node.key)}\``,
          );
        }
      },
      AssignmentExpression(node) {
        if (node.operator !== "=" || node.left?.type !== "Identifier") return;
        const variable = resolveVariable(context.sourceCode, node.left);
        const declarator = variableDeclarator(variable);
        if (declarator?.id?.type !== "Identifier") return;
        reportFlow(
          node.right,
          declarator.id.typeAnnotation?.typeAnnotation,
          `binding \`${declarator.id.name}\``,
        );
      },
      ReturnStatement(node) {
        if (!node.argument) return;
        const owner = nearestFunction(node);
        reportFlow(
          node.argument,
          owner?.returnType?.typeAnnotation,
          `return value of \`${functionName(context.sourceCode, owner)}\``,
        );
      },
      ArrowFunctionExpression(node) {
        if (node.body?.type === "BlockStatement") return;
        reportFlow(
          node.body,
          node.returnType?.typeAnnotation,
          `return value of \`${functionName(context.sourceCode, node)}\``,
        );
      },
      TSAsExpression(node) {
        if (!hasParentAssertion(node)) reportFlow(node.expression, node.typeAnnotation, "assertion");
      },
      TSTypeAssertion(node) {
        if (!hasParentAssertion(node)) reportFlow(node.expression, node.typeAnnotation, "assertion");
      },
    };
  },
};

function parameterAnnotation(parameter) {
  if (!parameter) return null;
  if (parameter.type === "TSParameterProperty") return parameterAnnotation(parameter.parameter);
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left?.typeAnnotation ?? null;
  }
  return parameter.typeAnnotation ?? null;
}

function parameterName(sourceCode, parameter) {
  if (parameter?.type === "Identifier") return parameter.name;
  return sourceCode.getText(parameter).replace(/\s*:\s*object\s*$/u, "");
}

function shadowedTypeNames(node) {
  const names = new Set();
  let current = node;
  while (current && current.type !== "Program") {
    for (const parameter of current.typeParameters?.params ?? []) {
      const name = parameter?.name?.name;
      if (name) names.add(name);
    }
    current = current.parent;
  }
  return names;
}

const noObjectParameters = {
  meta: {
    type: "problem",
    docs: { description: "Disallow the broad object type on function inputs." },
    schema: [],
    messages: {
      objectParameter:
        "Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type and parse external input at its boundary.",
    },
  },
  create(context) {
    const aliases = new Map();

    const resolvesToObject = (type, shadowed, visited = new Set()) => {
      const current = unwrapTransparentType(type);
      if (!current) return false;
      if (current.type === "TSObjectKeyword") return true;
      if (current.type === "TSUnionType") {
        return current.types?.some((member) => resolvesToObject(member, shadowed, visited)) ?? false;
      }
      if (current.type !== "TSTypeReference") return false;
      const name = typeReferenceName(current);
      if (
        !name ||
        current.typeArguments?.params?.length > 0 ||
        shadowed.has(name) ||
        visited.has(name)
      ) {
        return false;
      }
      const alias = aliases.get(name);
      if (!alias) return false;
      const nextVisited = new Set(visited);
      nextVisited.add(name);
      return resolvesToObject(alias, shadowed, nextVisited);
    };

    const checkParameters = (node) => {
      const shadowed = shadowedTypeNames(node);
      for (const parameter of node.params ?? []) {
        const annotation = parameterAnnotation(parameter);
        if (!annotation?.typeAnnotation) continue;
        if (!resolvesToObject(annotation.typeAnnotation, shadowed)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "objectParameter",
          data: { parameter: parameterName(context.sourceCode, parameter) },
        });
      }
    };

    const visitors = {
      Program(node) {
        aliases.clear();
        for (const statement of node.body ?? []) {
          const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (
            declaration?.type === "TSTypeAliasDeclaration" &&
            (declaration.typeParameters?.params?.length ?? 0) === 0
          ) {
            aliases.set(declaration.id.name, declaration.typeAnnotation);
          }
        }
      },
    };
    for (const type of PARAMETER_OWNER_TYPES) visitors[type] = checkParameters;
    return visitors;
  },
};

function isGlobalReflect(sourceCode, expression) {
  if (expression?.type !== "Identifier" || expression.name !== "Reflect") return false;
  if (typeof sourceCode?.isGlobalReference === "function" && sourceCode.isGlobalReference(expression)) {
    return true;
  }
  const variable = resolveVariable(sourceCode, expression);
  return variable !== null && (variable.defs?.length ?? 0) === 0;
}

function isGlobalReflectMethodCall(sourceCode, callee, methodName) {
  if (!callee || !("property" in callee) || !("object" in callee) || !("computed" in callee)) {
    return false;
  }
  if (!isGlobalReflect(sourceCode, callee.object)) return false;
  return callee.computed
    ? callee.property?.type === "Literal" && callee.property.value === methodName
    : callee.property?.type === "Identifier" && callee.property.name === methodName;
}

function reflectRule(methodName, messageId, description, message) {
  return {
    meta: {
      type: "problem",
      docs: { description },
      schema: [],
      messages: { [messageId]: message },
    },
    create(context) {
      return {
        CallExpression(node) {
          if (isGlobalReflectMethodCall(context.sourceCode, node.callee, methodName)) {
            context.report({ node, messageId });
          }
        },
      };
    },
  };
}

const noReflectApply = reflectRule(
  "apply",
  "reflectApply",
  "Disallow Reflect.apply in favour of typed calls.",
  "Replace `Reflect.apply` with a typed function call or model dynamic dispatch behind a named interface.",
);

const noReflectGet = reflectRule(
  "get",
  "reflectGet",
  "Disallow Reflect.get in favour of typed property access.",
  "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
);

function initializerBroadType(declarator) {
  const annotation = declarator?.id?.type === "Identifier"
    ? declarator.id.typeAnnotation?.typeAnnotation
    : null;
  const declaredBroad = classifyBroadType(annotation);
  if (declaredBroad) return { kind: declaredBroad, expression: declarator.init };

  const init = unwrapParenthesizedExpression(declarator?.init);
  if (isTypeAssertion(init)) {
    const assertedBroad = classifyBroadType(init.typeAnnotation);
    if (assertedBroad) return { kind: assertedBroad, expression: init.expression };
  }
  return null;
}

const noWidenThenAssert = {
  meta: {
    type: "problem",
    docs: { description: "Detect local const flows that widen known values before asserting them back." },
    schema: [],
    messages: {
      widenThenAssert:
        "Binding `{{name}}` discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use.",
    },
  },
  create(context) {
    const check = (node) => {
      const expression = unwrapParenthesizedExpression(node.expression);
      if (expression?.type !== "Identifier") return;
      if (classifyBroadType(node.typeAnnotation) !== null) return;

      const variable = resolveVariable(context.sourceCode, expression);
      const declarator = variableDeclarator(variable);
      if (!declarator || !isStableConstDeclarator(declarator) || !declarator.init) return;
      const widened = initializerBroadType(declarator);
      if (!widened || !isKnownEvidenceExpression(context.sourceCode, widened.expression)) return;

      context.report({
        node,
        messageId: "widenThenAssert",
        data: { name: expression.name },
      });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

function hasSafetyComment(sourceCode, node) {
  if (typeof sourceCode?.getCommentsBefore !== "function") return true;
  let current = node;
  while (current) {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some((comment) => comment.end <= node.start && /\bSAFETY\s*:/u.test(comment.value))
    ) {
      return true;
    }
    if (COMMENT_OWNER_TYPES.has(current.type) || current.parent?.type === "Program") return false;
    current = current.parent;
  }
  return false;
}

const requireSafetyCommentForTypeAssertion = {
  meta: {
    type: "problem",
    docs: { description: "Require a SAFETY justification for non-const type assertions." },
    schema: [],
    messages: {
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
  },
  create(context) {
    const check = (node) => {
      if (!isConstAssertion(node) && !hasSafetyComment(context.sourceCode, node)) {
        context.report({ node, messageId: "missingSafetyComment" });
      }
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

export default {
  meta: {
    name: "anti-slop",
    version: "opencodex-1",
  },
  rules: {
    "no-chained-type-assertions": noChainedTypeAssertions,
    "no-known-value-widening": noKnownValueWidening,
    "no-object-parameters": noObjectParameters,
    "no-reflect-apply": noReflectApply,
    "no-reflect-get": noReflectGet,
    "no-widen-then-assert": noWidenThenAssert,
    "require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertion,
  },
};
