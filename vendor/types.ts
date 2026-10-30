// Vendored from deepseek-pp core/types.ts (SSEEvent) so the stream codec stays
// byte-identical to upstream apart from its import specifier.
export interface SSEEvent {
  id?: string;
  type: string;
  data: string;
}
