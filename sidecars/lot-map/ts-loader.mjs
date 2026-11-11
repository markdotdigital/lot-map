// Lets Node run hooks/map.ts and hooks/text.ts directly without a package.json or build step.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z0-9]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx', '/index.d.ts', '/index.ts']) {
        try { return await nextResolve(`${specifier}${ext}`, context) } catch {}
      }
    }
    throw err
  }
}

export const load = (url, ctx, next) =>
  url.endsWith('.ts') || url.endsWith('.tsx') ? next(url, { ...ctx, format: 'module-typescript' }) : next(url, ctx)
