import execa, { ExecaReturnValue } from "execa";
import * as path from "path";
import { Connection, CompletionItemKind } from "vscode-languageserver";
import { URI } from "vscode-uri";
import { IElmPackageCache, IConstraint, IVersion } from "../elmWorkspace";
import { IClientSettings } from "./settings";

export const isWindows = process.platform === "win32";

/** Options for execCmd */
export interface IExecCmdOptions {
  /** Any arguments */
  cmdArguments?: string[];
  /** Shows a message if an error occurs (in particular the command not being */
  /* found), instead of rejecting. If this happens, the promise never resolves */
  showMessageOnError?: boolean;
  /** Text to add when command is not found (maybe helping how to install) */
  notFoundText?: string;
}

/** Executes a command. Shows an error message if the command isn't found */
export async function execCmd(
  cmdFromUser: string,
  cmdStatic: string,
  options: IExecCmdOptions = {},
  cwd: string,
  connection: Connection,
  input?: string,
): Promise<ExecaReturnValue<string>> {
  const cmd = cmdFromUser === "" ? cmdStatic : cmdFromUser;
  const preferLocal = cmdFromUser === "";

  const cmdArguments = options ? options.cmdArguments : [];

  try {
    return await execa(cmd, cmdArguments, {
      cwd,
      input,
      preferLocal,
      stripFinalNewline: false,
    });
  } catch (error) {
    if (error.errno === "ENOENT") {
      connection.window.showErrorMessage(
        options.notFoundText
          ? options.notFoundText
          : `Cannot find executable with name '${cmd}'`,
      );
      return Promise.reject("Executable not found");
    } else {
      return Promise.reject(error);
    }
  }
}

export function isTestFile(filename: string, rootPath: string): boolean {
  const testFolder = path.join(rootPath, "tests");
  if (filename.startsWith(testFolder)) {
    return true;
  }
  return false;
}

// Special type that has no core mock https://github.com/elm/compiler/blob/51e20357137ebc9c3f6136cf0a3fe21c24027f39/compiler/src/Canonicalize/Environment/Foreign.hs#L62
export function getEmptyTypes(): {
  markdown: string;
  name: string;
  symbolKind: CompletionItemKind;
}[] {
  return [
    {
      markdown: `An \`List\` is a list of items. Every item must be of the same type. Valid syntax for lists includes:

    []
    [42, 43]
    ["one", "two", "three"]
    [3.14, 0.1234]
    ['a', 'Z', '0']

    `,
      name: "List",
      symbolKind: CompletionItemKind.Enum,
    },
  ];
}

export async function getElmVersion(
  settings: IClientSettings,
  elmWorkspaceFolder: URI,
  connection: Connection,
): Promise<string> {
  const options = {
    cmdArguments: ["--version"],
    notFoundText:
      "Elm binary not found, did you install and setup the path to your binary?",
  };

  const result = await execCmd(
    settings.elmPath,
    "elm",
    options,
    elmWorkspaceFolder.fsPath,
    connection,
  );

  const version = result.stdout.trim();

  connection.console.info(`Elm version ${version} detected.`);

  return Promise.resolve(version);
}

type SolverResult =
  | {
      pending: ReadonlyMap<string, IConstraint>;
      solutions: ReadonlyMap<string, IVersion>;
    }
  | undefined;

export function solveDependencies(
  packageCache: IElmPackageCache,
  deps: ReadonlyMap<string, IConstraint>,
): ReadonlyMap<string, IVersion> | undefined {
  const result = solveDependenciesWorker(
    packageCache,
    deps,
    new Map<string, IVersion>(),
  );

  if (result) {
    return result.solutions;
  }
}

function solveDependenciesWorker(
  packageCache: IElmPackageCache,
  deps: ReadonlyMap<string, IConstraint>,
  solutions: ReadonlyMap<string, IVersion>,
): SolverResult {
  function pickDep(): [
    { name: string; constraint: IConstraint } | undefined,
    Map<string, IConstraint>,
  ] {
    const restDeps = new Map(deps);
    const firstDep = Array.from(deps.keys()).sort()[0];

    restDeps.delete(firstDep);

    return [
      firstDep
        ? { name: firstDep, constraint: deps.get(firstDep)! }
        : undefined,
      restDeps,
    ];
  }

  function combineDeps(
    a: ReadonlyMap<string, IConstraint>,
    b: ReadonlyMap<string, IConstraint>,
  ): Map<string, IConstraint> | undefined {
    const deps = new Map<string, IConstraint>();
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const v1 = a.get(key);
      const v2 = b.get(key);

      if (v1 && v2) {
        const intersect = constraintIntersect(v1, v2);

        if (!intersect) {
          return;
        }

        deps.set(key, intersect);
      } else if (v1) {
        deps.set(key, v1);
      } else if (v2) {
        deps.set(key, v2);
      } else {
        throw new Error("impossible");
      }
    }

    return deps;
  }

  const [dep, restDeps] = pickDep();

  if (!dep) {
    return { pending: deps, solutions };
  }

  // Find versions that satisfy the constraint
  let candidates = packageCache
    .get(dep.name)
    .filter(({ version }) => versionSatifiesConstraint(version, dep.constraint))
    .sort((a, b) =>
      a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
    )
    .reverse();

  const solvedVersion = solutions.get(dep.name);

  if (solvedVersion) {
    candidates = candidates.filter(
      (a) => a.version.string === solvedVersion.string,
    );
  }

  for (const candidate of candidates) {
    const tentativeDeps = combineDeps(restDeps, candidate.dependencies);

    if (!tentativeDeps) {
      continue;
    }

    const tentativeSolutions = new Map(solutions);
    tentativeSolutions.set(dep.name, candidate.version);

    const result = solveDependenciesWorker(
      packageCache,
      tentativeDeps,
      tentativeSolutions,
    );

    if (result) {
      return solveDependenciesWorker(
        packageCache,
        result.pending,
        result.solutions,
      );
    }
  }
}

export function parseVersion(version: string): IVersion {
  const [major, minor, patch] = version.split(".");

  return {
    major: parseInt(major),
    minor: parseInt(minor),
    patch: parseInt(patch),
    string: version,
  };
}

export function parseContraint(contraint: string): IConstraint {
  const regex = /^(\d+\.\d+\.\d+) (<|<=) v (<|<=) (\d+\.\d+\.\d+)$/gm;

  const m = regex.exec(contraint);
  if (m) {
    const lowerRange = m[1];
    const lowerOperator = m[2];
    const upperOperator = m[3];
    const upperRange = m[4];

    return {
      lower: parseVersion(lowerRange),
      upper: parseVersion(upperRange),
      lowerOperator: lowerOperator as "<" | "<=",
      upperOperator: upperOperator as "<" | "<=",
    };
  }

  throw new Error("Could not parse version constraint");
}

export function versionSatifiesConstraint(
  version: IVersion,
  constraint: IConstraint,
): boolean {
  return (
    filterSemver(constraint.lower, version, constraint.lowerOperator) &&
    filterSemver(version, constraint.upper, constraint.upperOperator)
  );
}

function filterSemver(
  lower: IVersion,
  upper: IVersion,
  operator: "<" | "<=",
): boolean {
  const currentCompare = versionCompare(lower, upper);
  switch (operator) {
    case "<=":
      return currentCompare === -1 || currentCompare === 0;
    case "<":
      return currentCompare === -1;
  }
}

function versionCompare(a: IVersion, b: IVersion): number {
  const pa = a.string.split(".");
  const pb = b.string.split(".");
  for (let i = 0; i < 3; i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (na > nb) {
      return 1;
    }
    if (nb > na) {
      return -1;
    }
  }
  return 0;
}

export function constraintIntersect(
  a: IConstraint,
  b: IConstraint,
): IConstraint | undefined {
  function merge(op1: "<=" | "<", op2: "<=" | "<"): "<=" | "<" {
    return op1 === "<" || op2 === "<" ? "<" : "<=";
  }

  let newLower;
  let newLowerOp;
  let newUpper;
  let newUpperOp;

  const lowerCompare = versionCompare(a.lower, b.lower);

  switch (lowerCompare) {
    case -1:
      newLower = b.lower;
      newLowerOp = b.lowerOperator;
      break;
    case 0:
      newLower = a.lower;
      newLowerOp = merge(a.lowerOperator, b.lowerOperator);
      break;
    case 1:
      newLower = a.lower;
      newLowerOp = a.lowerOperator;
      break;
  }

  const upperCompare = versionCompare(a.upper, b.upper);

  switch (upperCompare) {
    case -1:
      newUpper = a.upper;
      newUpperOp = a.upperOperator;
      break;
    case 0:
      newUpper = a.upper;
      newUpperOp = merge(a.upperOperator, b.upperOperator);
      break;
    case 1:
      newUpper = b.upper;
      newUpperOp = b.upperOperator;
      break;
  }

  if (
    !newLower ||
    !newUpper ||
    !newLowerOp ||
    !newUpperOp ||
    versionCompare(newLower, newUpper) !== -1
  ) {
    return;
  }

  return {
    lower: newLower,
    upper: newUpper,
    lowerOperator: newLowerOp,
    upperOperator: newUpperOp,
  };
}
