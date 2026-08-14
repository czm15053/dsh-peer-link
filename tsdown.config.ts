/**
 * dsh-peer-link 构建配置。
 *
 * host 半区:tsc 编译 src/ → lib/(ESM,供 dsh host 加载)。
 * client 半区:tsdown 打包 src/client/index.ts → lib/client.js
 * (CJS + __ModuleLoader__.load 注册,供 dsh web 前端加载)。
 *
 * client bundle 依赖的平台模块(react、dsh-client-*)由 loader 的 module table
 * 提供,必须 external;其余依赖(如有)内联。
 */
import { defineConfig } from 'tsdown'

const PLATFORM_EXTERNALS = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-tool/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-slots/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-primitives/client',
  '@deepseek-ai/cordis',
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
]

export default defineConfig({
  // host 半区入口(tsc 会 emit 到 lib/,这里不需要 tsdown 处理 host)
  name: '@deepseek-ai/dsh-peer-link/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  // 平台模块 external(loader 提供);其余依赖内联。
  external: PLATFORM_EXTERNALS,
  noExternal: (id: string) => (PLATFORM_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('@deepseek-ai/dsh-peer-link')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
