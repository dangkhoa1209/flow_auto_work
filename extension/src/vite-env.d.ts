/// <reference types="vite/client" />
/// <reference types="chrome" />

declare module "*?script" {
  const path: string;
  export default path;
}

declare module "*?script&module" {
  const path: string;
  export default path;
}
