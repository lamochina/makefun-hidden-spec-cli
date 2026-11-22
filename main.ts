// mend: one patch tool for every AI edit format (SPEC.md, version 1).
//
// mend reads a patch in one of four formats (a unified diff, SEARCH/REPLACE blocks, a V4A patch, or
// text-editor tool calls as JSON), applies every edit it names to the tree of text files rooted at
// the working directory, and writes every change or none. Lines an edit names are found at the first
// of three matching tiers: exact, trailing-whitespace-insensitive, then indentation-insensitive
// (with re-indentation of the replacement). The program is run as `node main.ts [options] [PATCH]`
// with Node 22 and its standard library alone.
//
// In a make.fun trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set; the last lines
// of this file then hand over to the kit's runner.ts, which runs this file on each check in a fresh
// directory, without that variable. That hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A fault in the patch itself: the run answers `error: parse <line>` and exit code 2. */
class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit failed: the run answers `error: <code> <path>` for it and, at the end, exit code 1. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at `\n`, one trailing `\r` removed from each, and no
 *  empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): not empty, no leading `/`, no `\`, and no empty, `.` or `..` segment. */
function isSafePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function checkSafe(p: string): void {
  if (!isSafePath(p)) throw new EditFault('unsafe', p);
}

/** A file as lines: its text split at its own line break, and whether it ends with that break. */
interface FileModel {
  lines: string[];
  br: string;
  tail: boolean;
}

function modelOf(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, tail: false };
  const parts = text.split(br);
  let tail = false;
  if (text.endsWith(br)) {
    parts.pop();
    tail = true;
  }
  return { lines: parts, br, tail };
}

function textOf(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.tail ? m.br : '');
}

/** The tree the edits work on: original file texts are read from disk on first use and cached, and
 *  every change an edit makes is held in `now` (a null value: the file is deleted) until the run
 *  ends and, if no edit failed, is written out. Moves are remembered for the `R` output lines. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  put(p: string, v: string | null): void {
    this.now.set(p, v);
  }

  snapshot(): { now: Map<string, string | null>; moves: number } {
    return { now: new Map(this.now), moves: this.moves.length };
  }

  restore(s: { now: Map<string, string | null>; moves: number }): void {
    this.now = s.now;
    this.moves.length = s.moves;
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Matching lines (section 5)
// ---------------------------------------------------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function matchAt(lines: string[], pos: number, old: string[], tier: number): boolean {
  for (let j = 0; j < old.length; j += 1) {
    if (!lineEq(lines[pos + j]!, old[j]!, tier)) return false;
  }
  return true;
}

function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    if (matchAt(lines, i, old, tier)) out.push(i);
  }
  return out;
}

const tiersOf = (strict: boolean): number[] => (strict ? [0] : [0, 1, 2]);

interface Match {
  tier: number;
  at: number[];
}

/** The first tier at which `old` occurs in `lines`, with every occurrence there (section 5). */
function findMatch(lines: string[], old: string[], strict: boolean): Match | null {
  for (const tier of tiersOf(strict)) {
    const at = occurrences(lines, old, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a replacement: `ctx` is its index in the old lines when it is a context line (a line
 *  of both, in a unified hunk or a V4A chunk), and -1 when it is an added line. */
interface NewLine {
  text: string;
  ctx: number;
}

/** The lines to write over a match of `old` at `pos`: a context line is written as the file's own
 *  matched line; at tier 2 every other line is re-indented from the old lines' first line's leading
 *  whitespace to the file's (section 5). */
function writtenLines(fileLines: string[], pos: number, old: string[], repl: NewLine[], tier: number): string[] {
  const f = leadWs(fileLines[pos]!);
  const p = old.length > 0 ? leadWs(old[0]!) : '';
  return repl.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    if (tier === 2 && n.text !== '' && !/^[ \t]+$/.test(n.text) && n.text.startsWith(p)) {
      return f + n.text.slice(p.length);
    }
    return n.text;
  });
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'del' | 'add' | 'eol';

interface BodyLine {
  kind: BodyKind;
  text: string;
  bare: boolean; // a context line that was an empty patch line, not a line holding one space
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld: string | undefined;
  gitNew: string | undefined;
  pairOld: string | null | undefined; // null: /dev/null
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` header line names: the text after the four characters, up to the
 *  first tab, with surrounding spaces removed; `/dev/null` is no file; a leading `a/` or `b/` goes. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.replace(/^ +| +$/g, '');
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Whether a `\` line follows the hunk's last context or `+` line (section 6's line-break rule). */
function backslashAfterLastWritten(h: Hunk): boolean {
  for (let i = h.body.length - 1; i >= 0; i -= 1) {
    const k = h.body[i]!.kind;
    if (k === 'ctx' || k === 'add') return i + 1 < h.body.length && h.body[i + 1]!.kind === 'eol';
  }
  return false;
}

/** Apply one section's hunks, in order, to a file model; `d` is the running line drift (section 6). */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const old: string[] = [];
    const repl: NewLine[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        old.push(b.text);
        repl.push({ text: b.text, ctx: old.length - 1 });
      } else if (b.kind === 'del') {
        old.push(b.text);
      } else if (b.kind === 'add') {
        repl.push({ text: b.text, ctx: -1 });
      }
    }
    if (old.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > model.lines.length) at = model.lines.length;
      const atEnd = at === model.lines.length;
      model.lines.splice(at, 0, ...repl.map((n) => n.text));
      if (atEnd) model.tail = !backslashAfterLastWritten(h);
    } else {
      const m = findMatch(model.lines, old, strict);
      if (m === null) throw new EditFault('no-match', path);
      const target = h.a - 1 + d;
      let pos = m.at[0]!;
      for (const cand of m.at) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const runsToEnd = pos + old.length === model.lines.length;
      const written = writtenLines(model.lines, pos, old, repl, m.tier);
      model.lines.splice(pos, old.length, ...written);
      if (runsToEnd) model.tail = !backslashAfterLastWritten(h);
    }
    d += repl.length - old.length;
  }
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.gitOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.gitNew;
  const isCreate = sec.newFile || sec.pairOld === null;
  const isDelete = sec.delFile || sec.pairNew === null;
  if (isCreate) {
    const target = (newPath ?? oldPath ?? '') as string;
    return (tree) => {
      checkSafe(target);
      if (tree.get(target) !== null) throw new EditFault('exists', target);
      const plus: string[] = [];
      let lastAdd = -1;
      let afterLastAdd: BodyKind | null = null;
      let flat = 0;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'add') {
            plus.push(b.text);
            lastAdd = flat;
            afterLastAdd = null;
          } else if (lastAdd === flat - 1 && afterLastAdd === null) {
            afterLastAdd = b.kind;
          }
          flat += 1;
        }
      }
      const model: FileModel = { lines: plus, br: '\n', tail: !(lastAdd >= 0 && afterLastAdd === 'eol') };
      tree.put(target, textOf(model));
    };
  }
  if (isDelete) {
    const target = (oldPath ?? newPath ?? '') as string;
    return (tree) => {
      checkSafe(target);
      if (tree.get(target) === null) throw new EditFault('missing', target);
      tree.put(target, null);
    };
  }
  const from = (oldPath ?? newPath ?? '') as string;
  const to = (newPath ?? oldPath ?? '') as string;
  if (from === to) {
    return (tree) => {
      checkSafe(from);
      const before = tree.get(from);
      if (before === null) throw new EditFault('missing', from);
      const model = modelOf(before);
      applyHunks(model, sec.hunks, strict, from);
      tree.put(from, textOf(model));
    };
  }
  return (tree) => {
    checkSafe(from);
    checkSafe(to);
    const before = tree.get(from);
    if (before === null) throw new EditFault('missing', from);
    if (tree.get(to) !== null) throw new EditFault('exists', to);
    const model = modelOf(before);
    applyHunks(model, sec.hunks, strict, from);
    tree.put(to, textOf(model));
    tree.put(from, null);
    tree.moves.push([from, to]);
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const newSection = (): Section => {
    const s: Section = {
      gitOld: undefined,
      gitNew: undefined,
      pairOld: undefined,
      pairNew: undefined,
      renOld: undefined,
      renNew: undefined,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+) b\/(.+)$/.exec(line.slice(11));
      if (m === null) throw new ParseFault(i + 1);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      const rest = hm === null ? null : line.slice(hm[0].length);
      if (hm === null || (rest !== '' && !rest!.startsWith(' '))) throw new ParseFault(i + 1);
      const hunk: Hunk = { a: Number(hm[1]), body: [] };
      cur.hunks.push(hunk);
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          hunk.body.push({ kind: 'ctx', text: '', bare: true });
          i += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ') hunk.body.push({ kind: 'ctx', text: bl.slice(1), bare: false });
        else if (c === '-') hunk.body.push({ kind: 'del', text: bl.slice(1), bare: false });
        else if (c === '+') hunk.body.push({ kind: 'add', text: bl.slice(1), bare: false });
        else if (c === '\\') hunk.body.push({ kind: 'eol', text: '', bare: false });
        else break;
        i += 1;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.bare) hunk.body.pop();
        else break;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(next);
        } else {
          cur = newSection();
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(next);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new ParseFault(i + 2);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    checkSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.put(path, textOf({ lines: [...newLines], br: '\n', tail: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    const model = modelOf(before);
    const m = findMatch(model.lines, oldLines, strict);
    if (m === null) throw new EditFault('no-match', path);
    if (m.at.length > 1) throw new EditFault('ambiguous', path);
    const pos = m.at[0]!;
    const repl: NewLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const written = writtenLines(model.lines, pos, oldLines, repl, m.tier);
    model.lines.splice(pos, oldLines.length, ...written);
    tree.put(path, textOf(model));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // the previous block's REPLACE line, an index into `lines`
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new ParseFault(searchLine + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseFault(searchLine + 1);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchLine + 1);
      path = prevPath;
    }
    edits.push(searchReplaceEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  old: string[];
  repl: NewLine[];
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  for (const tier of tiersOf(strict)) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

/** The first occurrence of `old` at or after `from`, at the first tier with one; an end-of-file
 *  chunk takes only an occurrence that ends at the file's last line. */
function findChunkMatch(lines: string[], old: string[], from: number, eof: boolean, strict: boolean): { tier: number; pos: number } | null {
  for (const tier of tiersOf(strict)) {
    for (let i = from; i + old.length <= lines.length; i += 1) {
      if (eof && i + old.length !== lines.length) continue;
      if (matchAt(lines, i, old, tier)) return { tier, pos: i };
    }
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    checkSafe(path);
    if (moveTo !== null) checkSafe(moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const model = modelOf(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(model.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new EditFault('no-match', path);
        cursor = at + 1;
      }
      if (ch.old.length === 0) {
        const at = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const written = ch.repl.map((n) => n.text);
        model.lines.splice(at, 0, ...written);
        cursor = at + written.length;
      } else {
        const m = findChunkMatch(model.lines, ch.old, cursor, ch.eof, strict);
        if (m === null) throw new EditFault('no-match', path);
        const written = writtenLines(model.lines, m.pos, ch.old, ch.repl, m.tier);
        model.lines.splice(m.pos, ch.old.length, ...written);
        cursor = m.pos + written.length;
      }
    }
    if (moveTo !== null) {
      tree.put(moveTo, textOf(model));
      tree.put(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.put(path, textOf(model));
    }
  };
}

const V4A_SECTIONS: Array<{ prefix: string; kind: 'add' | 'del' | 'upd' }> = [
  { prefix: '*** Add File: ', kind: 'add' },
  { prefix: '*** Delete File: ', kind: 'del' },
  { prefix: '*** Update File: ', kind: 'upd' },
];

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !isBlank(l));
  if (firstNB < 0) throw new ParseFault(1);
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new ParseFault(firstNB + 1);
  let lastNB = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!isBlank(lines[j])) {
      lastNB = j;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const sectionStart = (l: string): { prefix: string; kind: 'add' | 'del' | 'upd' } | null => {
    for (const s of V4A_SECTIONS) {
      if (l.startsWith(s.prefix)) return s;
    }
    return null;
  };
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const sec = sectionStart(line);
    if (sec === null) throw new ParseFault(i + 1);
    const secLine = i + 1;
    const path = line.slice(sec.prefix.length).replace(/^ +| +$/g, '');
    const body: Array<{ line: string; no: number }> = [];
    let j = i + 1;
    while (j < lastNB && sectionStart(lines[j]!) === null) {
      body.push({ line: lines[j]!, no: j + 1 });
      j += 1;
    }
    if (sec.kind === 'add') {
      const content: string[] = [];
      const kept = [...body];
      while (kept.length > 0 && isBlank(kept[kept.length - 1]!.line)) kept.pop();
      for (const b of kept) {
        if (b.line.startsWith('+')) content.push(b.line.slice(1));
        else if (b.line === '') content.push('');
        else throw new ParseFault(b.no);
      }
      edits.push((tree) => {
        checkSafe(path);
        if (tree.get(path) !== null) throw new EditFault('exists', path);
        tree.put(path, textOf({ lines: content, br: '\n', tail: true }));
      });
    } else if (sec.kind === 'del') {
      for (const b of body) {
        if (!isBlank(b.line)) throw new ParseFault(b.no);
      }
      edits.push((tree) => {
        checkSafe(path);
        if (tree.get(path) === null) throw new EditFault('missing', path);
        tree.put(path, null);
      });
    } else {
      const kept = [...body];
      while (kept.length > 0 && isBlank(kept[kept.length - 1]!.line)) kept.pop();
      let moveTo: string | null = null;
      let start = 0;
      if (kept.length > 0 && kept[0]!.line.startsWith('*** Move to: ')) {
        moveTo = kept[0]!.line.slice(13).replace(/^ +| +$/g, '');
        start = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      const openChunk = (): Chunk => {
        const c: Chunk = { anchor: null, eof: false, old: [], repl: [] };
        chunks.push(c);
        return c;
      };
      for (let k = start; k < kept.length; k += 1) {
        const b = kept[k]!;
        if (b.line.startsWith('@@')) {
          cur = openChunk();
          const t = b.line.slice(2).trim();
          cur.anchor = t === '' ? null : t;
          continue;
        }
        if (b.line.trim() === '*** End of File') {
          if (cur === null) cur = openChunk();
          cur.eof = true;
          cur = null;
          continue;
        }
        if (b.line.startsWith('*** ')) throw new ParseFault(b.no);
        const c = b.line[0];
        if (b.line !== '' && c !== ' ' && c !== '-' && c !== '+') throw new ParseFault(b.no);
        if (cur === null) cur = openChunk();
        if (b.line === '' || c === ' ') {
          const t = b.line === '' ? '' : b.line.slice(1);
          cur.old.push(t);
          cur.repl.push({ text: t, ctx: cur.old.length - 1 });
        } else if (c === '-') {
          cur.old.push(b.line.slice(1));
        } else {
          cur.repl.push({ text: b.line.slice(1), ctx: -1 });
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(secLine);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one: a wrong command, or a missing or mistyped
 *  key, is a parse fault (section 9). Keys other than the ones below are ignored. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.put(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      checkSafe(p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.put(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      checkSafe(p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const model = modelOf(before);
      if (line < 0 || line > model.lines.length) throw new EditFault('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.put(p, textOf(model));
    };
  }
  return null;
}

function parseJSON(text: string, lines: string[]): Edit[] {
  const firstNB = lines.findIndex((l) => !isBlank(l));
  if (firstNB < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[firstNB]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(firstNB + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(firstNB + 1);
    for (const item of v) {
      const e = jsonEdit(item);
      if (e === null) throw new ParseFault(firstNB + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      throw new ParseFault(idx + 1);
    }
    const e = jsonEdit(v);
    if (e === null) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Detecting the format (section 4), the command line (section 1), the run
// (sections 2 and 10)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function runCli(args: string[]): { code: number; out: string[] } {
  let format = 'auto';
  let formatSeen = false;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && !formatSeen && FORMAT_NAMES.includes(a.slice(9))) {
        format = a.slice(9);
        formatSeen = true;
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchPath = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  if (patchPath === null) {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(patchPath, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = patchLines(text);
  const kind = format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4A(lines, strict);
    else edits = parseJSON(text, lines);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // The changed paths, in byte order (UTF-8); a qualifying move replaces its pair's D and A lines
  // with one R line that sorts by the new path (section 2).
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const moveNewToOld = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null) {
      moveNewToOld.set(n, o);
    }
  }
  const moveOlds = new Set(moveNewToOld.values());
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of tree.now.keys()) {
    if (moveNewToOld.has(p)) {
      rows.push({ key: p, text: `R ${moveNewToOld.get(p)!} -> ${p}` });
      continue;
    }
    if (moveOlds.has(p)) continue;
    const was = tree.original(p);
    const now = finalOf(p);
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = finalOf(p);
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
