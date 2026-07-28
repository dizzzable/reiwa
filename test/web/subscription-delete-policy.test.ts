import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { executeSubscriptionDeleteWithAmbiguousRetry } from "../../web/src/features/dashboard/subscription-delete-policy.js";

const deleteDialogSource = ts.createSourceFile(
  "delete-subscription-dialog.tsx",
  readFileSync(
    new URL(
      "../../web/src/features/dashboard/components/delete-subscription-dialog.tsx",
      import.meta.url,
    ),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function findNodes<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function getMutationCallback(
  name: "mutationFn" | "onSuccess",
): ts.ArrowFunction | ts.FunctionExpression {
  const useMutation = findNodes(
    deleteDialogSource,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useMutation",
  )[0];
  const options = useMutation?.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) {
    throw new Error("DeleteSubscriptionDialog must configure useMutation inline");
  }

  const property = options.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === name,
  );
  if (
    !property ||
    (!ts.isArrowFunction(property.initializer) &&
      !ts.isFunctionExpression(property.initializer))
  ) {
    throw new Error(`DeleteSubscriptionDialog must define ${name} as a callback`);
  }
  return property.initializer;
}

describe("subscription delete ambiguity policy", () => {
  it("returns the first explicit success without retrying", async () => {
    const operation = vi.fn().mockResolvedValue({ deleted: true });

    await expect(
      executeSubscriptionDeleteWithAmbiguousRetry(
        operation,
        () => false,
      ),
    ).resolves.toEqual({ deleted: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries one transport-ambiguous failure", async () => {
    const ambiguous = new Error("response lost");
    const operation = vi
      .fn()
      .mockRejectedValueOnce(ambiguous)
      .mockResolvedValueOnce({ deleted: true });

    await expect(
      executeSubscriptionDeleteWithAmbiguousRetry(
        operation,
        (error) => error === ambiguous,
      ),
    ).resolves.toEqual({ deleted: true });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry an explicit server failure", async () => {
    const explicit = new Error("403");
    const operation = vi.fn().mockRejectedValue(explicit);

    await expect(
      executeSubscriptionDeleteWithAmbiguousRetry(
        operation,
        () => false,
      ),
    ).rejects.toBe(explicit);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("hands the awaited deletion id to the server-commit callback before closing", () => {
    const mutationFn = getMutationCallback("mutationFn");
    const onSuccess = getMutationCallback("onSuccess");

    const awaitedDelete = findNodes(
      mutationFn.body,
      (node): node is ts.AwaitExpression =>
        ts.isAwaitExpression(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text ===
          "executeSubscriptionDeleteWithAmbiguousRetry",
    )[0];
    const returnedId = findNodes(
      mutationFn.body,
      (node): node is ts.ReturnStatement =>
        ts.isReturnStatement(node) &&
        !!node.expression &&
        ts.isIdentifier(node.expression),
    )[0];
    const returnedExpression = returnedId?.expression;
    if (
      !awaitedDelete ||
      !returnedExpression ||
      !ts.isIdentifier(returnedExpression)
    ) {
      throw new Error("mutationFn must await deletion and return its captured id");
    }
    const returnedIdName = returnedExpression.text;

    const capturedId = findNodes(
      mutationFn.body,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === returnedIdName &&
        !!node.initializer &&
        ts.isPropertyAccessExpression(node.initializer) &&
        node.initializer.name.text === "id",
    )[0];
    if (!capturedId) {
      throw new Error("mutationFn must capture the subscription id before deletion");
    }

    expect(capturedId.getStart(deleteDialogSource)).toBeLessThan(
      awaitedDelete.getStart(deleteDialogSource),
    );
    expect(awaitedDelete.getStart(deleteDialogSource)).toBeLessThan(
      returnedId.getStart(deleteDialogSource),
    );

    const successId = onSuccess.parameters[0]?.name;
    if (!successId || !ts.isIdentifier(successId)) {
      throw new Error("onSuccess must receive the committed subscription id");
    }

    const successCalls = findNodes(
      onSuccess.body,
      (node): node is ts.CallExpression => ts.isCallExpression(node),
    );
    const serverCommit = successCalls.find(
      (call) =>
        ts.isIdentifier(call.expression) &&
        call.expression.text === "onServerCommitted" &&
        ts.isIdentifier(call.arguments[0]) &&
        call.arguments[0].text === successId.text,
    );
    const closeDialog = successCalls.find(
      (call) =>
        ts.isIdentifier(call.expression) &&
        call.expression.text === "onOpenChange" &&
        call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword,
    );
    if (!serverCommit || !closeDialog) {
      throw new Error(
        "onSuccess must commit its subscription id and then close the dialog",
      );
    }

    expect(serverCommit.getStart(deleteDialogSource)).toBeLessThan(
      closeDialog.getStart(deleteDialogSource),
    );
  });
});
