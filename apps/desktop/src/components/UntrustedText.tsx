/**
 * Text someone else wrote — a sender, a workspace, a CLI preview — shown as text and nothing else (DA4, DA11): one
 * text node, so no markup in it is ever read as markup, and its line breaks kept.
 */
export function UntrustedText({ text }: { text: string }) {
  return <span className="whitespace-pre-wrap break-words">{text}</span>;
}
