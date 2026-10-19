// Vite `?url` imports (only for lazy-loading the Manifold wasm); tsconfig lacks vite/client types, so declare it here.
declare module '*?url' {
  const url: string;
  export default url;
}
