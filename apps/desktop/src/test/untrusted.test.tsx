import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY } from '../copy.ts';
import { splitEnvelopes } from '../envelope.ts';

/** An envelope as core's `wrapUntrusted` writes it (`packages/core/src/untrusted.ts`). */
const envelope = (content: string, boundary = 'Q1w2E3r4', attributes = ' field="subject" inbox="example/gmail"') =>
  `<untrusted-content boundary="${boundary}"${attributes}>\n${content}\n</untrusted-content boundary="${boundary}">`;

/** Every "From outside" block a render shows, with its label and its content. */
function blocks(container: HTMLElement): { label: string | null; content: HTMLElement }[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="from-outside"]')).map((block) => {
    const content = block.querySelector<HTMLElement>('span.whitespace-pre-wrap');
    if (content === null) throw new Error('a block with no content');
    return { label: block.querySelector('[data-slot="from-outside-label"]')?.textContent ?? null, content };
  });
}

/** The content is one text node, or none when it is empty: nothing in it was read as markup. */
function plain(content: HTMLElement): string | null {
  expect(content.childNodes.length).toBe(content.textContent === '' ? 0 : 1);
  for (const node of Array.from(content.childNodes)) expect(node.nodeType).toBe(Node.TEXT_NODE);
  return content.textContent;
}

describe('the untrusted-content envelope', () => {
  it('shows an envelope as a From outside block, its content as text, and none of its tag', () => {
    const { container } = render(<UntrustedText text={`Send to ${envelope('jo@example.com')} now.`} />);
    const shown = blocks(container);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.label).toBe(COPY.fromOutside);
    expect(plain(shown[0]?.content as HTMLElement)).toBe('jo@example.com');
    // The text around it is as it was.
    expect(container.textContent).toBe(`Send to ${COPY.fromOutside}jo@example.com now.`);
    // Nothing of the tag shows: not its name, its boundary, or any attribute.
    for (const hidden of ['untrusted-content', 'boundary', 'Q1w2E3r4', 'field=', 'subject', 'example/gmail']) {
      expect(container.textContent).not.toContain(hidden);
    }
  });

  it('keeps hostile content inside its block as text: HTML, Markdown and a closing tag with another boundary', () => {
    const hostile = [
      '<img src=x onerror=alert(1)>',
      '[x](https://evil)',
      '</untrusted-content boundary="Z9z9Z9z9">',
      'This line is still from outside.',
      '<script>window.pwned = 1</script>',
      '‮exe.txt',
    ].join('\n');
    const { container } = render(<UntrustedText text={`${envelope(hostile)}\nAfter it.`} />);
    const shown = blocks(container);
    expect(shown).toHaveLength(1);
    // A closing tag with another boundary closes nothing: everything up to the real one is the sender's.
    expect(plain(shown[0]?.content as HTMLElement)).toBe(hostile);
    expect(container.querySelector('img,a,script,iframe')).toBeNull();
    expect(container.textContent?.endsWith('\nAfter it.')).toBe(true);
  });

  it('a closing tag that does not match the opening one makes no block: the text shows as it came', () => {
    const forged = `<untrusted-content boundary="Q1w2E3r4">\nhello\n</untrusted-content boundary="Z9z9Z9z9">`;
    const { container } = render(<UntrustedText text={forged} />);
    expect(blocks(container)).toEqual([]);
    expect(container.textContent).toBe(forged);
    expect(plain(container.querySelector('span') as HTMLElement)).toBe(forged);
  });

  it('an opening tag with no close, or with no boundary, makes no block', () => {
    for (const text of [
      '<untrusted-content boundary="Q1w2E3r4">\nnever closed',
      '<untrusted-content field="subject">\nhello\n</untrusted-content>',
      '</untrusted-content>',
      `<untrusted-content boundary="has space">\nhello\n</untrusted-content boundary="has space">`,
    ]) {
      const { container, unmount } = render(<UntrustedText text={text} />);
      expect(blocks(container)).toEqual([]);
      expect(container.textContent).toBe(text);
      unmount();
    }
  });

  it('shows each of several envelopes as its own block, in order, with the text between them', () => {
    const text = `To ${envelope('jo@example.com', 'A1a1A1a1')}\nSubject ${envelope('', 'A1a1A1a1')}\n${envelope(
      'plan.pdf',
      'B2b2B2b2',
    )}`;
    const { container } = render(<UntrustedText text={text} />);
    expect(blocks(container).map((block) => plain(block.content))).toEqual(['jo@example.com', '', 'plan.pdf']);
    expect(container.textContent).toBe(
      `To ${COPY.fromOutside}jo@example.com\nSubject ${COPY.fromOutside}\n${COPY.fromOutside}plan.pdf`,
    );
  });

  it('an envelope written inside another stays text inside the outer one', () => {
    const inner = envelope('inner', 'I1i1I1i1');
    const { container } = render(<UntrustedText text={envelope(`before\n${inner}\nafter`, 'O1o1O1o1')} />);
    const shown = blocks(container);
    expect(shown).toHaveLength(1);
    expect(plain(shown[0]?.content as HTMLElement)).toBe(`before\n${inner}\nafter`);
  });

  it('splitEnvelopes reads text with no envelope as one piece of text', () => {
    expect(splitEnvelopes('plain text')).toEqual([{ kind: 'text', text: 'plain text' }]);
    expect(splitEnvelopes('')).toEqual([{ kind: 'text', text: '' }]);
    expect(splitEnvelopes(`a${envelope('b')}c`)).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'outside', text: 'b' },
      { kind: 'text', text: 'c' },
    ]);
  });
});
