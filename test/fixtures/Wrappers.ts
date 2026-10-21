/** Renders compiled wrapper components with React and reads the resulting styles in Chromium. @module */
import * as Esbuild from 'esbuild'
import * as Module from 'node:module'
import * as Path from 'node:path'
import { chromium } from 'playwright'
import * as React from 'react'
import * as Server from 'react-dom/server'

/** Classes and computed styles of one element the application renders inside `main`. */
export type Element = {
  borderLeftWidth: string
  className: string
  color: string
  paddingLeft: string
  tag: string
}

/** Bundles compiled modules, renders the entry's `App` on the server, and reads its elements. */
export async function render(
  options: render.Options,
): Promise<render.ReturnType> {
  const built = await Esbuild.build({
    alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
    bundle: true,
    entryPoints: [`./${options.entry}`],
    external: ['react'],
    format: 'cjs',
    jsx: 'automatic',
    platform: 'node',
    plugins: [
      {
        name: 'modules',
        setup(build) {
          build.onResolve({ filter: /^\.\// }, (args) =>
            args.kind === 'entry-point' || args.namespace === 'modules'
              ? { namespace: 'modules', path: args.path.slice(2) }
              : undefined,
          )
          build.onLoad({ filter: /.*/, namespace: 'modules' }, (args) => {
            const contents = options.modules[args.path]

            if (contents === undefined)
              throw new Error(`Missing module: ${args.path}`)

            return { contents, loader: 'tsx', resolveDir: process.cwd() }
          })
        },
      },
    ],
    write: false,
  })
  const module = { exports: {} as { App: () => React.ReactNode } }

  new Function('module', 'exports', 'require', built.outputFiles[0]!.text)(
    module,
    module.exports,
    Module.createRequire(import.meta.url),
  )

  const markup = Server.renderToStaticMarkup(
    React.createElement(module.exports.App),
  )
  const browser = await chromium.launch()

  try {
    const page = await browser.newPage()

    await page.setContent(`<style>${options.css}</style>${markup}`)

    const elements = await page.locator('main > *').evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node)

        return {
          borderLeftWidth: style.borderLeftWidth,
          className: node.className,
          color: style.color,
          paddingLeft: style.paddingLeft,
          tag: node.tagName.toLowerCase(),
        }
      }),
    )

    return { elements, markup }
  } finally {
    await browser.close()
  }
}

export declare namespace render {
  type Options = {
    /** Stylesheet text of every module. */
    css: string
    /** Module that exports `App`. */
    entry: string
    /** Compiled module code, by module identity. Relative imports name these identities. */
    modules: Readonly<Record<string, string>>
  }

  type ReturnType = {
    /** Each element directly inside the rendered `main`, in document order. */
    elements: readonly Element[]
    /** Server-rendered markup. */
    markup: string
  }
}
