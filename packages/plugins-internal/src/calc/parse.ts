/**
 * Avaliador do calc (R-7.4, D-17): parser descendente recursivo escrito à mão sobre
 * `[0-9.+\-*\/%^()]`. Sem `eval` e sem `Function` (lint `no-eval`/`no-new-func`, AC-7.7).
 *
 * Gramática (precedência da menor para a maior):
 *   soma     := produto (('+' | '-') produto)*
 *   produto  := unario (('*' | '/' | '%') unario)*
 *   unario   := '-' unario | potencia
 *   potencia := primario ('^' unario)?        (à direita: 2^3^2 = 2^9; -2^2 = -4)
 *   primario := numero | '(' soma ')'
 *   numero   := digitos ('.' digitos)? | '.' digitos      (separador decimal só '.', Q-12)
 */
export type CalcOutcome =
  { readonly kind: 'value'; readonly value: number } | { readonly kind: 'div0' };

type Node =
  | { readonly op: 'num'; readonly value: number }
  | { readonly op: 'neg'; readonly arg: Node }
  | { readonly op: '+' | '-' | '*' | '/' | '%' | '^'; readonly left: Node; readonly right: Node };

class CalcSyntaxError extends Error {}

class Parser {
  pos = 0;
  binary = 0;

  constructor(readonly src: string) {}

  parse(): Node {
    const node = this.sum();
    if (this.pos !== this.src.length) throw new CalcSyntaxError();
    return node;
  }

  sum(): Node {
    let left = this.product();
    for (let c = this.src[this.pos]; c === '+' || c === '-'; c = this.src[this.pos]) {
      this.pos++;
      this.binary++;
      left = { op: c, left, right: this.product() };
    }
    return left;
  }

  product(): Node {
    let left = this.unary();
    for (let c = this.src[this.pos]; c === '*' || c === '/' || c === '%'; c = this.src[this.pos]) {
      this.pos++;
      this.binary++;
      left = { op: c, left, right: this.unary() };
    }
    return left;
  }

  unary(): Node {
    if (this.src[this.pos] === '-') {
      this.pos++;
      return { op: 'neg', arg: this.unary() };
    }
    return this.power();
  }

  power(): Node {
    const base = this.primary();
    if (this.src[this.pos] !== '^') return base;
    this.pos++;
    this.binary++;
    return { op: '^', left: base, right: this.unary() };
  }

  primary(): Node {
    if (this.src[this.pos] === '(') {
      this.pos++;
      const inner = this.sum();
      if (this.src[this.pos] !== ')') throw new CalcSyntaxError();
      this.pos++;
      return inner;
    }
    const match = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(this.src.slice(this.pos));
    if (!match) throw new CalcSyntaxError();
    this.pos += match[0].length;
    return { op: 'num', value: Number(match[0]) };
  }
}

class DivisionByZero extends Error {}

function evaluateNode(node: Node): number {
  switch (node.op) {
    case 'num':
      return node.value;
    case 'neg':
      return -evaluateNode(node.arg);
    default: {
      const left = evaluateNode(node.left);
      const right = evaluateNode(node.right);
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '^':
          return left ** right;
        default:
          if (right === 0) throw new DivisionByZero();
          return node.op === '/' ? left / right : left % right;
      }
    }
  }
}

/**
 * Avalia a expressão depois do `=`. `null` = não é uma expressão calc: erro de sintaxe, nenhum
 * operador binário (`=5`, `=-3`) ou resultado não finito (fica cru, como um erro de sintaxe).
 * Divisão (ou resto) por zero → `div0` ("divisão por zero").
 */
export function evaluate(expression: string): CalcOutcome | null {
  const parser = new Parser(expression);
  let tree: Node;
  try {
    tree = parser.parse();
  } catch {
    return null;
  }
  if (parser.binary === 0) return null;
  try {
    const value = evaluateNode(tree);
    return Number.isFinite(value) ? { kind: 'value', value } : null;
  } catch {
    return { kind: 'div0' };
  }
}
