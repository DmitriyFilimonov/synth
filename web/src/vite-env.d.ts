/// <reference types="vite/client" />

interface ImportMeta {
  readonly env: Record<string, string>;
}

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
