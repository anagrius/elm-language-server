import { IConnection, TextEdit, Range, Position } from "vscode-languageserver";
import {
  GetMoveDestinationRequest,
  MoveDestinationsResponse,
  MoveParams,
  MoveRequest,
  MoveDestination,
} from "../../protocol";
import { ElmWorkspace } from "../../elmWorkspace";
import { URI } from "vscode-uri";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { TreeUtils } from "../../util/treeUtils";
import { References } from "../../util/references";
import { RefactorEditUtils } from "../../util/refactorEditUtils";

export class MoveRefactoringHandler {
  constructor(
    private connection: IConnection,
    private elmWorkspaces: ElmWorkspace[],
  ) {
    this.connection.onRequest(
      GetMoveDestinationRequest,
      new ElmWorkspaceMatcher(elmWorkspaces, (param: MoveParams) =>
        URI.parse(param.sourceUri),
      ).handlerForWorkspace(this.handleGetMoveDestinationsRequest.bind(this)),
    );

    this.connection.onRequest(
      MoveRequest,
      new ElmWorkspaceMatcher(elmWorkspaces, (param: MoveParams) =>
        URI.parse(param.sourceUri),
      ).handlerForWorkspace(this.handleMoveRequest.bind(this)),
    );
  }

  private handleGetMoveDestinationsRequest(
    params: MoveParams,
    elmWorkspace: ElmWorkspace,
  ): MoveDestinationsResponse {
    const forest = elmWorkspace.getForest();

    const destinations: MoveDestination[] = forest.treeIndex
      .filter(tree => tree.writeable && tree.uri !== params.sourceUri)
      .map(tree => {
        let uri = URI.parse(tree.uri).fsPath;
        const rootPath = elmWorkspace.getRootPath().fsPath;

        uri = uri.slice(rootPath.length + 1);
        const index = uri.lastIndexOf("\\");

        return {
          name: uri.slice(index + 1),
          path: uri.slice(0, index),
          uri: tree.uri,
        };
      });

    return {
      destinations,
    };
  }

  private handleMoveRequest(params: MoveParams, elmWorkspace: ElmWorkspace) {
    if (!params.destination) {
      return;
    }

    const forest = elmWorkspace.getForest();
    const imports = elmWorkspace.getImports();
    const tree = forest.getTree(params.sourceUri);
    const destinationTree = forest.getTree(params.destination.uri);

    if (tree && destinationTree) {
      const nodeAtPosition = TreeUtils.getNamedDescendantForPosition(
        tree.rootNode,
        params.params.range.start,
      );

      const isTypeNode = nodeAtPosition.parent?.type === "type_annotation";
      const isDeclarationNode =
        nodeAtPosition.parent?.parent?.type === "value_declaration";

      const typeNode = isDeclarationNode
        ? nodeAtPosition.parent?.parent?.previousNamedSibling?.type ===
          "type_annotation"
          ? nodeAtPosition.parent?.parent?.previousNamedSibling
          : undefined
        : isTypeNode
        ? nodeAtPosition.parent
        : undefined;

      const declarationNode = isDeclarationNode
        ? nodeAtPosition.parent?.parent
        : isTypeNode
        ? nodeAtPosition.parent?.nextNamedSibling
        : undefined;

      const functionName = isTypeNode
        ? nodeAtPosition.text
        : nodeAtPosition.parent?.text;

      const moduleName = TreeUtils.getModuleNameNode(tree)?.text;

      const destinationModuleName = TreeUtils.getModuleNameNode(destinationTree)
        ?.text;

      if (
        declarationNode &&
        functionName &&
        moduleName &&
        destinationModuleName
      ) {
        const startPosition =
          typeNode?.startPosition ?? declarationNode.startPosition;
        const endPosition = declarationNode.endPosition;

        const functionText = `\n\n${typeNode ? `${typeNode.text}\n` : ""}${
          declarationNode.text
        }`;

        const changes: { [uri: string]: TextEdit[] } = {};

        changes[params.sourceUri] = [];
        changes[params.destination.uri] = [];

        // Remove from source
        changes[params.sourceUri].push(
          TextEdit.del(
            Range.create(
              Position.create(startPosition.row, startPosition.column),
              Position.create(endPosition.row, endPosition.column),
            ),
          ),
        );

        // Add to destination
        changes[params.destination.uri].push(
          TextEdit.insert(
            Position.create(destinationTree.rootNode.endPosition.row + 1, 0),
            functionText,
          ),
        );

        // Update references
        const references = References.find(
          {
            node: declarationNode,
            nodeType: "Function",
            uri: params.sourceUri,
          },
          forest,
          imports,
        );

        const sourceHasReference = !!references.find(
          ref =>
            ref.uri === params.sourceUri &&
            ref.node.parent?.text !== typeNode?.text &&
            ref.node.parent?.parent?.text !== declarationNode?.text &&
            ref.node.type !== "exposed_value",
        );

        const referenceUris = new Set(references.map(ref => ref.uri));

        // Unexpose function in the source file if it is
        const unexposeEdit = RefactorEditUtils.unexposedValueInModule(
          tree,
          functionName,
        );
        if (unexposeEdit) {
          changes[params.sourceUri].push(unexposeEdit);
        }

        // Remove old imports to the old source file from all reference uris
        referenceUris.forEach(refUri => {
          if (!changes[refUri]) {
            changes[refUri] = [];
          }

          const refTree = forest.getTree(refUri);

          if (refTree && params.destination?.name) {
            const removeImportEdit = RefactorEditUtils.removeValueFromImport(
              refTree,
              moduleName,
              functionName,
            );

            if (removeImportEdit) {
              changes[refUri].push(removeImportEdit);
            }
          }
        });

        // We don't want the destination file in the remaining edits
        referenceUris.delete(params.destination.uri);

        // Expose function in destination file if there are external references
        if (referenceUris.size > 0) {
          const exposeEdit = RefactorEditUtils.exposeValueInModule(
            destinationTree,
            functionName,
          );

          if (exposeEdit) {
            changes[params.destination.uri].push(exposeEdit);
          }
        }

        // Add the new imports for each file with a reference
        referenceUris.forEach(refUri => {
          if (refUri === params.sourceUri && !sourceHasReference) {
            return;
          }

          const refTree = forest.getTree(refUri);

          if (refTree) {
            const importEdit = RefactorEditUtils.addImport(
              refTree,
              destinationModuleName,
              functionName,
            );

            if (importEdit) {
              changes[refUri].push(importEdit);
            }
          }
        });

        this.connection.workspace.applyEdit({ changes });
      }
    }
  }
}
