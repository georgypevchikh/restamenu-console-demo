import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  {
    // supabase/functions is Deno land (Deno globals, npm: specifiers) —
    // type-checked by `deno check` in CI, not by this toolchain.
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "*.tsbuildinfo", "supabase/functions/**"],
  },
  ...coreWebVitals,
  ...typescript,
];

export default config;
