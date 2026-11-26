// Bun's text import loader exposes Markdown as a UTF-8 string.
declare module "*.md" {
  const markdown: string;
  export default markdown;
}
