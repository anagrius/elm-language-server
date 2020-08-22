import { container } from "tsyringe";
import {
  Hover,
  IConnection,
  MarkupKind,
  TextDocumentPositionParams,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { SyntaxNode, Tree } from "web-tree-sitter";
import { IElmWorkspace } from "../elmWorkspace";
import { getEmptyTypes } from "../util/elmUtils";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";
import { HintHelper } from "../util/hintHelper";
import { NodeType, TreeUtils } from "../util/treeUtils";
import { ITreeContainer } from "src/forest";
import { typeToString, findType } from "../util/types/typeInference";

type HoverResult = Hover | null | undefined;

export class HoverProvider {
  private connection: IConnection;

  constructor() {
    this.connection = container.resolve<IConnection>("Connection");
    this.connection.onHover(
      new ElmWorkspaceMatcher((param: TextDocumentPositionParams) =>
        URI.parse(param.textDocument.uri),
      ).handlerForWorkspace(this.handleHoverRequest),
    );
  }

  protected handleHoverRequest = (
    params: TextDocumentPositionParams,
    elmWorkspace: IElmWorkspace,
  ): HoverResult => {
    this.connection.console.info(`A hover was requested`);

    const forest = elmWorkspace.getForest();
    const tree: ITreeContainer | undefined = forest.getByUri(
      params.textDocument.uri,
    );

    if (tree) {
      const nodeAtPosition = TreeUtils.getNamedDescendantForPosition(
        tree.tree.rootNode,
        params.position,
      );

      // try {
      //   const typeString: string = typeToString(
      //     findType(nodeAtPosition, params.textDocument.uri, elmWorkspace),
      //   );

      //   if (typeString && typeString !== "Unknown") {
      //     return {
      //       contents: typeString,
      //     };
      //   }
      // } catch (e) {
      //   console.log(e);
      // }

      const definitionNode = TreeUtils.findDefinitionNodeByReferencingNode(
        nodeAtPosition,
        params.textDocument.uri,
        tree.tree,
        elmWorkspace.getImports(),
      );

      if (definitionNode) {
        return this.createMarkdownHoverFromDefinition(definitionNode);
      } else {
        const specialMatch = getEmptyTypes().find(
          (a) => a.name === nodeAtPosition.text,
        );
        if (specialMatch) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: specialMatch.markdown,
            },
          };
        }
      }
    }
  };

  private createMarkdownHoverFromDefinition(
    definitionNode:
      | { node: SyntaxNode; uri: string; nodeType: NodeType }
      | undefined,
  ): Hover | undefined {
    if (definitionNode) {
      const value =
        definitionNode.nodeType === "FunctionParameter" ||
        definitionNode.nodeType === "AnonymousFunctionParameter" ||
        definitionNode.nodeType === "CasePattern"
          ? HintHelper.createHintFromFunctionParameter(definitionNode.node)
          : HintHelper.createHint(definitionNode.node);

      if (value) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value,
          },
        };
      }
    }
  }
}
