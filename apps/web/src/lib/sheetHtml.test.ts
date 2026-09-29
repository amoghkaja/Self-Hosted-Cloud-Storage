import { describe, expect, it } from 'vitest';
import { parseSheets } from './sheetHtml';

// Trimmed from LibreOffice's HTML export of a two-sheet workbook, plus things a hostile file
// could contain.
const HTML = `<!DOCTYPE html><html><head><style>body { background: url(https://evil.test/x) }</style>
<script>window.pwned = 1</script></head><body>
<p><center><h1>Overview</h1><A HREF="#table0">Budget</A></center></p>
<A NAME="table0"><h1>Sheet 1: <em>Budget</em></h1></A>
<table cellspacing="0" border="0">
  <colgroup width="222"></colgroup>
  <tr>
    <td style="border-bottom: 1px solid #000000; position: fixed; background-image: url(https://evil.test/y)" height="17" align="left" bgcolor="#1F6FEB" onclick="alert(1)"><b><font face="Calibri" color="#FFFFFF">Item</font></b></td>
    <td align="right" sdval="1234.5">€1,234.50</td>
  </tr>
  <tr>
    <td colspan=2 bgcolor="red;x:expression(1)"><a href="javascript:alert(1)">bad link</a> <a href="https://example.com/trip">good link</a><img src="https://evil.test/z" onerror="alert(1)"><script>alert(1)</script></td>
  </tr>
  <tr><td><a class="comment-indicator"></a><comment>a private note</comment>Noted</td></tr>
</table>
<A NAME="table1"><h1>Sheet 2: <em>Trips &amp; Dates</em></h1></A>
<table><tr><td>Goa</td><td>46000</td></tr></table>
</body></html>`;

describe('parseSheets', () => {
  it('keeps sheet names, formatted values, colours and merged cells', () => {
    const sheets = parseSheets(HTML);
    expect(sheets.map((s) => s.name)).toEqual(['Budget', 'Trips & Dates']);
    const [budget] = sheets;
    const header = budget!.table.rows[0]!.cells[0]!;
    expect(header.getAttribute('bgcolor')).toBe('#1F6FEB');
    expect(header.style.getPropertyValue('border-bottom')).toContain('1px solid');
    expect(header.querySelector('font')?.getAttribute('color')).toBe('#FFFFFF');
    expect(budget!.table.rows[0]!.cells[1]!.textContent).toBe('€1,234.50');
    expect(budget!.table.rows[1]!.cells[0]!.getAttribute('colspan')).toBe('2');
    expect(budget!.table.querySelector('colgroup')?.getAttribute('width')).toBe('222');
  });

  it('drops scripts, handlers, remote images, unsafe links and styles', () => {
    const [budget] = parseSheets(HTML);
    const html = budget!.table.outerHTML;
    expect(html).not.toMatch(
      /script|onclick|onerror|<img|javascript:|evil\.test|position|expression/i,
    );
    const links = budget!.table.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://example.com/trip');
    expect(links[0]!.getAttribute('rel')).toContain('noopener');
    expect(budget!.table.rows[1]!.cells[0]!.textContent).toContain('bad link');
    // Cell notes stay hidden, as in Excel.
    expect(budget!.table.rows[2]!.cells[0]!.textContent).toBe('Noted');
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('names sheets itself when the file does not', () => {
    expect(parseSheets('<table><tr><td>1</td></tr></table>')[0]!.name).toBe('Sheet 1');
  });
});
