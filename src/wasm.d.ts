// Module declarations so `import wasm from "...od_router.wasm"` type-checks.
// wrangler's CompiledWasm rule resolves the import to a WebAssembly.Module
// at bundle time.
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
