/**
 * Restricted conditional-edge expressions — the explicit replacement for eval().
 *
 * Edges carry a small AST (not a string of code). The evaluator is total,
 * side-effect-free, and non-Turing-complete: it can read declared state keys and
 * compare/combine them, and nothing else. There is no function call, no property
 * access beyond a whitelisted state path, no loops. This eliminates the eval()
 * RCE/injection footgun by construction.
 *
 * Guards: KER (CEL/JSONLogic-style edges, never eval), MAN (undeclared state keys
 * are rejected).
 */

export type Expr =
  | { op: "const"; value: string | number | boolean | null }
  | { op: "var"; key: string } // reads runState[key]; key must be declared
  | { op: "eq"; left: Expr; right: Expr }
  | { op: "ne"; left: Expr; right: Expr }
  | { op: "lt"; left: Expr; right: Expr }
  | { op: "lte"; left: Expr; right: Expr }
  | { op: "gt"; left: Expr; right: Expr }
  | { op: "gte"; left: Expr; right: Expr }
  | { op: "and"; clauses: Expr[] }
  | { op: "or"; clauses: Expr[] }
  | { op: "not"; clause: Expr };

export type RunState = Record<string, string | number | boolean | null>;

export class ExprError extends Error {
  constructor(
    message: string,
    readonly code: "UNKNOWN_KEY" | "TYPE_MISMATCH" | "BAD_NODE" | "DEPTH",
  ) {
    super(message);
    this.name = "ExprError";
  }
}

const MAX_DEPTH = 32; // bound recursion — no runaway expressions

/**
 * Evaluate an expression against run state. `declaredKeys` is the set of state keys
 * the manifest declared; reading any other key is a hard error (no silent undefined).
 * Returns a boolean for edge conditions (non-bool results are an error at the top).
 */
export function evalCondition(expr: Expr, state: RunState, declaredKeys: ReadonlySet<string>): boolean {
  const v = evalExpr(expr, state, declaredKeys, 0);
  if (typeof v !== "boolean") {
    throw new ExprError(`condition must evaluate to boolean, got ${typeof v}`, "TYPE_MISMATCH");
  }
  return v;
}

type Val = string | number | boolean | null;

function evalExpr(expr: Expr, state: RunState, declared: ReadonlySet<string>, depth: number): Val {
  if (depth > MAX_DEPTH) throw new ExprError("expression too deep", "DEPTH");

  switch (expr.op) {
    case "const":
      return expr.value;
    case "var": {
      if (!declared.has(expr.key)) {
        throw new ExprError(`undeclared state key '${expr.key}'`, "UNKNOWN_KEY");
      }
      return expr.key in state ? state[expr.key]! : null;
    }
    case "eq":
      return cmpEq(evalExpr(expr.left, state, declared, depth + 1), evalExpr(expr.right, state, declared, depth + 1));
    case "ne":
      return !cmpEq(evalExpr(expr.left, state, declared, depth + 1), evalExpr(expr.right, state, declared, depth + 1));
    case "lt":
      return cmpOrd(expr.left, expr.right, state, declared, depth, (a, b) => a < b);
    case "lte":
      return cmpOrd(expr.left, expr.right, state, declared, depth, (a, b) => a <= b);
    case "gt":
      return cmpOrd(expr.left, expr.right, state, declared, depth, (a, b) => a > b);
    case "gte":
      return cmpOrd(expr.left, expr.right, state, declared, depth, (a, b) => a >= b);
    case "and": {
      for (const c of expr.clauses) {
        if (!asBool(evalExpr(c, state, declared, depth + 1))) return false;
      }
      return true;
    }
    case "or": {
      for (const c of expr.clauses) {
        if (asBool(evalExpr(c, state, declared, depth + 1))) return true;
      }
      return false;
    }
    case "not":
      return !asBool(evalExpr(expr.clause, state, declared, depth + 1));
    default: {
      // exhaustiveness — if a new op is added without handling, this throws.
      const _never: never = expr;
      throw new ExprError(`unknown expr node: ${JSON.stringify(_never)}`, "BAD_NODE");
    }
  }
}

function cmpEq(a: Val, b: Val): boolean {
  return a === b;
}

function cmpOrd(
  l: Expr,
  r: Expr,
  state: RunState,
  declared: ReadonlySet<string>,
  depth: number,
  f: (a: number, b: number) => boolean,
): boolean {
  const a = evalExpr(l, state, declared, depth + 1);
  const b = evalExpr(r, state, declared, depth + 1);
  // A declared-but-absent state key reads as null. Comparing null in an ordering
  // operator is NOT an error and NOT true — it means "the data isn't there, so the
  // condition is not satisfied". This makes edge routing robust: a gate like
  // `score >= 80` simply isn't taken until `score` exists, rather than crashing the
  // run. (A genuine string-vs-number mismatch IS still an authoring error.)
  if (a === null || b === null) return false;
  if (typeof a !== "number" || typeof b !== "number") {
    throw new ExprError(`ordering comparison needs numbers, got ${typeof a} and ${typeof b}`, "TYPE_MISMATCH");
  }
  return f(a, b);
}

function asBool(v: Val): boolean {
  if (typeof v !== "boolean") {
    throw new ExprError(`expected boolean, got ${typeof v}`, "TYPE_MISMATCH");
  }
  return v;
}

/** Collect every state key referenced by an expression (for validation). */
export function referencedKeys(expr: Expr, into: Set<string> = new Set()): Set<string> {
  switch (expr.op) {
    case "const":
      break;
    case "var":
      into.add(expr.key);
      break;
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      referencedKeys(expr.left, into);
      referencedKeys(expr.right, into);
      break;
    case "and":
    case "or":
      for (const c of expr.clauses) referencedKeys(c, into);
      break;
    case "not":
      referencedKeys(expr.clause, into);
      break;
  }
  return into;
}
