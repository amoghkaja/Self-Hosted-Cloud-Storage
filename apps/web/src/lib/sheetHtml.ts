/**
 * Turns LibreOffice's HTML export of a spreadsheet into sheets the viewer can show.
 *
 * The file is untrusted (anyone who can share a spreadsheet wrote it), so nothing from it is
 * inserted as HTML. It is parsed inert with DOMParser and rebuilt node by node: only table and
 * text-formatting elements, only presentational attributes with checked values, only a few
 * style properties (no url(), so nothing loads), and links only to http(s) or mailto.
 */

export interface Sheet {
  name: string;
  table: HTMLTableElement;
  /** Rows left out because the sheet is too big to show in a browser. */
  truncatedRows: number;
}

const MAX_CELLS = 200_000;

const KEEP = new Set([
  'table',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'sub',
  'sup',
  'font',
  'span',
  'br',
  'p',
  'div',
  'a',
]);
// Dropped with their content; anything else unknown is unwrapped (its text kept).
const DROP = new Set([
  'script',
  'style',
  'comment',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'img',
  'link',
  'meta',
  'form',
  'input',
  'button',
  'textarea',
  'select',
]);

const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i;
const ATTRS: Record<string, RegExp> = {
  colspan: /^\d{1,4}$/,
  rowspan: /^\d{1,5}$/,
  span: /^\d{1,4}$/,
  width: /^\d{1,5}%?$/,
  height: /^\d{1,5}$/,
  align: /^(left|right|center|justify)$/i,
  valign: /^(top|middle|bottom|baseline)$/i,
  bgcolor: COLOR,
  color: COLOR,
  face: /^[\w ,'"-]{1,100}$/,
};
const STYLES = [
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'background-color',
  'color',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-align',
  'vertical-align',
  'white-space',
];

function copyStyle(from: HTMLElement, to: HTMLElement) {
  for (const prop of STYLES) {
    const value = from.style?.getPropertyValue(prop);
    if (value && !/url\(|expression|image-set|@import|\\/i.test(value)) {
      to.style.setProperty(prop, value);
    }
  }
}

function rebuild(node: Node, parent: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    parent.appendChild(document.createTextNode(node.textContent ?? ''));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (DROP.has(tag) || el.classList.contains('comment-indicator')) return;
  let target: Node = parent;
  if (KEEP.has(tag)) {
    const href = el.getAttribute('href') ?? '';
    if (tag === 'a' && !/^(https?:|mailto:)/i.test(href)) {
      target = parent; // an anchor or odd link: keep its text only
    } else {
      const out = document.createElement(tag);
      for (const [name, allowed] of Object.entries(ATTRS)) {
        const value = el.getAttribute(name)?.trim();
        if (value && allowed.test(value)) out.setAttribute(name, value);
      }
      if (tag === 'a') {
        out.setAttribute('href', href);
        out.setAttribute('target', '_blank');
        out.setAttribute('rel', 'noopener noreferrer nofollow');
      }
      copyStyle(el, out);
      parent.appendChild(out);
      target = out;
    }
  }
  for (const child of Array.from(el.childNodes)) rebuild(child, target);
}

/** Sheets in workbook order, named as in the file. */
export function parseSheets(html: string): Sheet[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // LibreOffice heads each sheet with <a name="tableN"><h1>Sheet N: <em>Name</em></h1></a>.
  const names = Array.from(doc.querySelectorAll('a[name^="table"] em'), (e) =>
    (e.textContent ?? '').trim(),
  );
  let budget = MAX_CELLS;
  return Array.from(doc.querySelectorAll('table'), (source, i) => {
    const table = document.createElement('table');
    for (const group of Array.from(source.querySelectorAll(':scope > colgroup'))) {
      rebuild(group, table);
    }
    const body = table.appendChild(document.createElement('tbody'));
    let truncatedRows = 0;
    for (const row of Array.from(source.rows)) {
      budget -= row.cells.length;
      if (budget < 0) truncatedRows++;
      else rebuild(row, body);
    }
    return { name: names[i] || `Sheet ${i + 1}`, table, truncatedRows };
  });
}
