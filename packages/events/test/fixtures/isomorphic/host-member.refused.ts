// Refused: lower-casing follows the host's Unicode tables, which differ between Node and a webview.
export const lower = (text: string): string => text.toLowerCase();
