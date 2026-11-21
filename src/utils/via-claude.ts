// Changes and comments made through the Claude connector (worker/src/mcp/)
// carry the person's name plus " (via Claude)": the server writes it into
// the activity log's `who` and a comment's `author` (see connectorAttachment()
// in worker/src/mcp/handler.ts). Views show the name with a small
// "via Claude" tag instead, so the name itself doesn't get cut off.
const VIA_CLAUDE_SUFFIX = / \(via Claude\)$/;

export function splitViaClaude(name: string): { name: string; viaClaude: boolean } {
  const viaClaude = VIA_CLAUDE_SUFFIX.test(name);
  return { name: viaClaude ? name.replace(VIA_CLAUDE_SUFFIX, '') : name, viaClaude };
}
