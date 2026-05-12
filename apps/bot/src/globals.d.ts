/// <reference types="@cloudflare/workers-types" />

declare module '*.wasm' {
  const value: string | URL | WebAssembly.Module | ArrayBuffer
  export default value
}

declare module '*.woff2' {
  const value: string | URL | ArrayBuffer | Uint8Array
  export default value
}
