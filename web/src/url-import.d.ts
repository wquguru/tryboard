// Vite 的 `?url` 导入（只用在懒加载 Manifold 的 wasm 上）：tsconfig 没带 vite/client 类型，这里单独声明
declare module '*?url' {
  const url: string;
  export default url;
}
