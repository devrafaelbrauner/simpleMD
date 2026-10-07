// Gerado por scripts/build-plugin-example.mjs a partir de packages/plugins-internal/src/calc.
// Não edite à mão (o CI confere). API v1: docs/plugins.md.
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
//#region packages/plugins-internal/src/shared/reveal.ts
/**
* Foco do editor guardado no estado, com a mesma regra do live preview do r1 (arch-frontend F-2):
* só os módulos do host, sem importar o core. A revelação pelo cursor só vale com o editor focado.
*/
var setPluginFocus = StateEffect.define();
var pluginFocusField = StateField.define({
	create: () => false,
	update(focused, tr) {
		for (const effect of tr.effects) if (effect.is(setPluginFocus)) focused = effect.value;
		return focused;
	}
});
/**
* Um estado trocado com `view.setState` (troca de aba) chega com o campo em `false` mesmo com o
* editor focado; este plugin corrige a divergência logo depois (o `focusSync` do r1).
*/
var focusSync = ViewPlugin.fromClass(class {
	view;
	destroyed = false;
	scheduled = false;
	constructor(view) {
		this.view = view;
		this.check();
	}
	update() {
		this.check();
	}
	check() {
		if (this.scheduled || this.view.hasFocus === this.view.state.field(pluginFocusField, false)) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.destroyed) return;
			const focused = this.view.hasFocus;
			if (focused !== this.view.state.field(pluginFocusField, false)) this.view.dispatch({ effects: setPluginFocus.of(focused) });
		});
	}
	destroy() {
		this.destroyed = true;
	}
});
var pluginFocus = [
	pluginFocusField,
	EditorView.focusChangeEffect.of((_state, focusing) => setPluginFocus.of(focusing)),
	focusSync
];
/** Tocado = editor focado e alguma faixa da seleção encosta no intervalo (mesma regra do r1). */
function isTouched(state, from, to) {
	if (!state.field(pluginFocusField, false)) return false;
	for (const range of state.selection.ranges) if (range.from <= to && range.to >= from) return true;
	return false;
}
function focusChanged(update) {
	return update.startState.field(pluginFocusField, false) !== update.state.field(pluginFocusField, false);
}
/**
* Clique num widget: cursor no início da unidade e foco no editor; a unidade tocada passa a mostrar
* a fonte (R-3.2). Usado pelos `mousedown` dos três plugins.
*/
function revealAt(view, pos) {
	view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) } });
	view.focus();
}
/**
* `mousedown` em qualquer elemento com `selector` dentro do conteúdo: revela a unidade cuja posição
* é a do próprio widget (`posAtDOM`).
*/
function revealOnMouseDown(selector) {
	return EditorView.domEventHandlers({ mousedown(event, view) {
		const widget = event.target?.closest?.(selector);
		if (!widget || !view.contentDOM.contains(widget)) return false;
		event.preventDefault();
		revealAt(view, view.posAtDOM(widget));
		return true;
	} });
}
/** Ícone ⚠ monolinha (DESIGN §8.10), criado com a API do DOM; `aria-hidden`. */
function warnGlyph(doc) {
	const ns = "http://www.w3.org/2000/svg";
	const svg = doc.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.6");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	for (const d of ["M12 3.5 21.5 20h-19z", "M12 10v4M12 17h.01"]) {
		const path = doc.createElementNS(ns, "path");
		path.setAttribute("d", d);
		svg.appendChild(path);
	}
	return svg;
}
//#endregion
//#region packages/plugins-internal/src/shared/scan.ts
/** Nós em que nenhuma renderização acontece (R-7.3, R-7.4, R-9.1). */
var EXCLUDED = {
	FrontMatter: true,
	FencedCode: true,
	CodeBlock: true,
	InlineCode: true
};
/** Nós excluídos que cruzam `[from, to]`, em ordem de posição. */
function excludedSpans(state, from, to) {
	const out = [];
	syntaxTree(state).iterate({
		from,
		to,
		enter(node) {
			if (!EXCLUDED[node.name]) return;
			out.push({
				from: node.from,
				to: node.to
			});
			return false;
		}
	});
	return out;
}
/** `[from, to]` encosta em algum intervalo de `spans` (ordenados por `from`). */
function insideAny(spans, from, to) {
	for (const span of spans) {
		if (span.from > to) return false;
		if (span.to >= from) return true;
	}
	return false;
}
/** Espaço, tab ou quebra de linha (charCode). */
var isSpace$1 = (code) => code === 32 || code === 9 || code === 10 || code === 13;
var DOLLAR = 36;
var BACKSLASH = 92;
/**
* Matemática em linha numa linha de texto, pelas regras do Pandoc (R-7.3): o `$` de abertura não é
* seguido de espaço; o de fechamento não é precedido de espaço nem seguido de dígito; `\$` é um
* cifrão literal; `$$` nunca abre matemática em linha. Uma unidade nunca cruza a linha nem um
* intervalo bloqueado (código, front matter, bloco `$$`).
*/
function scanInlineMath(text, offset, blocked, out) {
	let i = 0;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === BACKSLASH) {
			i += 2;
			continue;
		}
		if (code !== DOLLAR || insideAny(blocked, offset + i, offset + i)) {
			i++;
			continue;
		}
		if (text.charCodeAt(i + 1) === DOLLAR) {
			i += 2;
			continue;
		}
		if (i + 1 >= text.length || isSpace$1(text.charCodeAt(i + 1))) {
			i++;
			continue;
		}
		let close = -1;
		for (let j = i + 1; j < text.length; j++) {
			if (insideAny(blocked, offset + j, offset + j)) break;
			const c = text.charCodeAt(j);
			if (c === BACKSLASH) {
				j++;
				continue;
			}
			if (c !== DOLLAR) continue;
			const after = text.charCodeAt(j + 1);
			if (!isSpace$1(text.charCodeAt(j - 1)) && !(after >= 48 && after <= 57)) {
				close = j;
				break;
			}
		}
		if (close === -1) {
			i++;
			continue;
		}
		out.push({
			from: offset + i,
			to: offset + close + 1,
			tex: text.slice(i + 1, close)
		});
		i = close + 1;
	}
}
/**
* Bloco `$$` (R-7.3): um parágrafo de topo cuja PRIMEIRA linha é só `$$` e uma linha seguinte do
* mesmo parágrafo também só `$$`, com conteúdo entre elas. Devolve as linhas inteiras do bloco.
*/
function blockMathAt(doc, node) {
	if (doc.sliceString(node.from, node.from + 2) !== "$$") return null;
	if (doc.lineAt(node.from).from !== node.from) return null;
	const found = displayMathAt(doc.sliceString(node.from, doc.lineAt(node.to).to));
	return found && {
		from: node.from,
		to: node.from + found.end,
		tex: found.tex
	};
}
/**
* A regra do bloco `$$` sobre o texto de um parágrafo (o editor e a exportação usam a mesma; R-7.3,
* R-10.4): a primeira linha é só `$$` e uma linha seguinte — depois de pelo menos uma de conteúdo —
* também. Devolve o TeX entre elas e o fim da linha de fechamento (offset no texto).
*/
function displayMathAt(text) {
	if (!text.startsWith("$$")) return null;
	const openEnd = text.indexOf("\n");
	if (openEnd === -1 || text.slice(0, openEnd).trim() !== "$$") return null;
	const contentFrom = openEnd + 1;
	let start = text.indexOf("\n", contentFrom);
	while (start !== -1) {
		start++;
		let end = text.indexOf("\n", start);
		if (end === -1) end = text.length;
		if (text.slice(start, end).trim() === "$$") return {
			tex: text.slice(contentFrom, start - 1),
			end
		};
		start = end === text.length ? -1 : end;
	}
	return null;
}
/** Blocos `$$` de topo que cruzam `[from, to]` (O(blocos de topo visitados)). */
function blockMathIn(state, from, to) {
	const doc = state.doc;
	const out = [];
	syntaxTree(state).iterate({
		from,
		to,
		enter(node) {
			if (node.name === "Document") return;
			if (node.name === "Paragraph") {
				const block = blockMathAt(doc, node);
				if (block) out.push(block);
			}
			return false;
		}
	});
	return out;
}
/**
* Matemática em linha nas linhas de `[from, to]`, fora de código, front matter e blocos `$$`
* (`blocked`, ordenados por `from`).
*/
function inlineMathIn(state, from, to, blocked) {
	const doc = state.doc;
	const out = [];
	for (let pos = doc.lineAt(from).from; pos <= to;) {
		const line = doc.lineAt(pos);
		if (line.text.includes("$")) scanInlineMath(line.text, line.from, blocked, out);
		pos = line.to + 1;
	}
	return out;
}
/** Nós excluídos e blocos `$$` de `[from, to]`, juntos e ordenados (o que bloqueia calc e `$`). */
function blockedSpans(state, from, to) {
	return [...excludedSpans(state, from, to), ...blockMathIn(state, from, to)].sort((a, b) => a.from - b.from);
}
//#endregion
//#region packages/plugins-internal/src/calc/parse.ts
var CalcSyntaxError = class extends Error {};
var Parser = class {
	src;
	pos = 0;
	binary = 0;
	constructor(src) {
		this.src = src;
	}
	parse() {
		const node = this.sum();
		if (this.pos !== this.src.length) throw new CalcSyntaxError();
		return node;
	}
	sum() {
		let left = this.product();
		for (let c = this.src[this.pos]; c === "+" || c === "-"; c = this.src[this.pos]) {
			this.pos++;
			this.binary++;
			left = {
				op: c,
				left,
				right: this.product()
			};
		}
		return left;
	}
	product() {
		let left = this.unary();
		for (let c = this.src[this.pos]; c === "*" || c === "/" || c === "%"; c = this.src[this.pos]) {
			this.pos++;
			this.binary++;
			left = {
				op: c,
				left,
				right: this.unary()
			};
		}
		return left;
	}
	unary() {
		if (this.src[this.pos] === "-") {
			this.pos++;
			return {
				op: "neg",
				arg: this.unary()
			};
		}
		return this.power();
	}
	power() {
		const base = this.primary();
		if (this.src[this.pos] !== "^") return base;
		this.pos++;
		this.binary++;
		return {
			op: "^",
			left: base,
			right: this.unary()
		};
	}
	primary() {
		if (this.src[this.pos] === "(") {
			this.pos++;
			const inner = this.sum();
			if (this.src[this.pos] !== ")") throw new CalcSyntaxError();
			this.pos++;
			return inner;
		}
		const match = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(this.src.slice(this.pos));
		if (!match) throw new CalcSyntaxError();
		this.pos += match[0].length;
		return {
			op: "num",
			value: Number(match[0])
		};
	}
};
var DivisionByZero = class extends Error {};
function evaluateNode(node) {
	switch (node.op) {
		case "num": return node.value;
		case "neg": return -evaluateNode(node.arg);
		default: {
			const left = evaluateNode(node.left);
			const right = evaluateNode(node.right);
			switch (node.op) {
				case "+": return left + right;
				case "-": return left - right;
				case "*": return left * right;
				case "^": return left ** right;
				default:
					if (right === 0) throw new DivisionByZero();
					return node.op === "/" ? left / right : left % right;
			}
		}
	}
}
/**
* Avalia a expressão depois do `=`. `null` = não é uma expressão calc: erro de sintaxe, nenhum
* operador binário (`=5`, `=-3`) ou resultado não finito (fica cru, como um erro de sintaxe).
* Divisão (ou resto) por zero → `div0` ("divisão por zero").
*/
function evaluate(expression) {
	const parser = new Parser(expression);
	let tree;
	try {
		tree = parser.parse();
	} catch {
		return null;
	}
	if (parser.binary === 0) return null;
	try {
		const value = evaluateNode(tree);
		return Number.isFinite(value) ? {
			kind: "value",
			value
		} : null;
	} catch {
		return { kind: "div0" };
	}
}
/** STR-88 (vinculante). */
var DIV0_TEXT = "divisão por zero";
var CALC_TOKEN = /^=[0-9.+\-*/%^()]+$/;
/**
* Até 10 algarismos significativos e sem zeros à direita (`0.1+0.2` → `0.3`); `-0` vira `0`.
*/
function formatResult(value) {
	return String(Number(value.toPrecision(10)) + 0);
}
/**
* Resultado de um token calc completo (`=2+3`), ou `null` quando ele não é calc: caractere fora da
* gramática, mais de 200 caracteres, sem operador binário ou erro de sintaxe (R-7.4). Função pura,
* também usada pela exportação (arch-frontend r2 §10.2).
*/
function renderCalc(token) {
	if (token.length > 200 || !CALC_TOKEN.test(token)) return null;
	const outcome = evaluate(token.slice(1));
	if (outcome === null) return null;
	if (outcome.kind === "div0") return {
		text: DIV0_TEXT,
		label: `${token}: ${DIV0_TEXT}`,
		error: true
	};
	const text = formatResult(outcome.value);
	return {
		text,
		label: `${token} = ${text}`,
		error: false
	};
}
var isSpace = (char) => char === " " || char === "	";
/**
* Candidatos a token calc num texto (R-7.4; o editor passa uma linha, a exportação o texto de um
* bloco): começa com `=` no início de uma linha ou depois de espaço/tab e vai até o próximo espaço,
* tab ou quebra de linha; no máximo 200 caracteres. Quem chama exclui código, front matter e
* matemática e decide com {@link renderCalc}.
*/
function calcTokenSpans(text) {
	const out = [];
	for (let i = text.indexOf("="); i !== -1; i = text.indexOf("=", i + 1)) {
		if (i > 0 && !isSpace(text[i - 1]) && text[i - 1] !== "\n") continue;
		let end = i + 1;
		while (end < text.length && !isSpace(text[end]) && text[end] !== "\n") end++;
		if (end - i > 200) continue;
		out.push({
			from: i,
			to: end
		});
	}
	return out;
}
//#endregion
//#region packages/plugins-internal/src/calc/decorate.ts
/**
* Chip que substitui `=2+3` (DESIGN §8.18 CLC-OK/CLC-ERROR): `role="img"` com o nome acessível
* (UX-R2-D23); o erro leva o ⚠ em `danger` e o texto "divisão por zero".
*/
var CalcWidget = class extends WidgetType {
	result;
	constructor(result) {
		super();
		this.result = result;
	}
	eq(other) {
		return other.result.label === this.result.label;
	}
	toDOM(view) {
		const doc = view.dom.ownerDocument;
		const span = doc.createElement("span");
		span.className = this.result.error ? "cm-calc-error" : "cm-calc-result";
		span.setAttribute("role", "img");
		span.setAttribute("aria-label", this.result.label);
		if (this.result.error) span.appendChild(warnGlyph(doc));
		span.appendChild(doc.createTextNode(this.result.text));
		return span;
	}
	ignoreEvent(event) {
		return event.type !== "mousedown";
	}
};
/**
* Decorações do calc nas faixas dadas (R-7.4): token que começa com `=` no início da linha ou depois
* de espaço, até o próximo espaço; fora de código, front matter e matemática; o token tocado fica
* cru. Função pura do estado (testes e o `ViewPlugin`).
*/
function computeCalcDecorations(state, ranges) {
	const doc = state.doc;
	const out = [];
	let lastLine = -1;
	for (const range of ranges) {
		const blocked = blockedSpans(state, range.from, range.to);
		const math = inlineMathIn(state, range.from, range.to, blocked);
		const skip = [...blocked, ...math].sort((a, b) => a.from - b.from);
		for (let pos = doc.lineAt(range.from).from; pos <= range.to;) {
			const line = doc.lineAt(pos);
			pos = line.to + 1;
			if (line.number <= lastLine) continue;
			lastLine = line.number;
			const text = line.text;
			for (const token of calcTokenSpans(text)) {
				const from = line.from + token.from;
				const to = line.from + token.to;
				if (insideAny(skip, from, to - 1) || isTouched(state, from, to)) continue;
				const result = renderCalc(text.slice(token.from, token.to));
				if (result) out.push(Decoration.replace({ widget: new CalcWidget(result) }).range(from, to));
			}
		}
	}
	return Decoration.set(out, true);
}
var calcPlugin = ViewPlugin.fromClass(class {
	decorations;
	constructor(view) {
		this.decorations = computeCalcDecorations(view.state, view.visibleRanges);
	}
	update(update) {
		if (update.docChanged || update.viewportChanged || update.selectionSet || focusChanged(update) || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = computeCalcDecorations(update.state, update.view.visibleRanges);
	}
}, { decorations: (plugin) => plugin.decorations });
/** Estilos do chip (DESIGN §8.18; só `var(--…)`, design-ack T-14). */
var calcTheme = EditorView.theme({
	".cm-calc-result, .cm-calc-error": {
		fontFamily: "var(--fontFamily-mono)",
		fontVariantNumeric: "tabular-nums",
		color: "var(--color-fg)",
		backgroundColor: "var(--color-code-bg)",
		borderRadius: "var(--dimension-radius)",
		paddingInline: "var(--dimension-space-1)"
	},
	".cm-calc-error": {
		display: "inline-flex",
		alignItems: "baseline",
		gap: "var(--dimension-space-1)"
	},
	".cm-calc-error svg": {
		color: "var(--color-danger)",
		alignSelf: "center"
	},
	".cm-calc-error > svg": {
		width: "0.9em",
		height: "0.9em",
		flex: "none"
	}
});
/** Extensão `source` do calc: foco próprio, decorações no viewport, clique revela e estilos. */
var calcExtension = [
	pluginFocus,
	calcPlugin,
	revealOnMouseDown(".cm-calc-result, .cm-calc-error"),
	calcTheme
];
//#endregion
//#region packages/plugins-internal/src/calc/index.ts
/**
* Plugin interno "Cálculo" (etapa 7, R-7.4): `=2+3` vira `5`. Usa só a API v1
* (`registerEditorExtension`) e os módulos do host — prova de suficiência da API (R-7.1). O mesmo
* código, empacotado, é `plugins-examples/calc` (R-7.5).
*/
function activate(api) {
	api.registerEditorExtension({ source: calcExtension });
}
//#endregion
export { activate, activate as default };
